import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  createDb, companies, agents, companyMemberships, companyDecisionModels, costEvents,
  decisionInvocations, issueThreadInteractions, issues, activityLog,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { decisionModelService } from "../services/decision-models.js";
import {
  checkAcceptance, escalateDecision, gatePlan, resolveDecisionGuidance, suggestDuplicateIssue, triageIssue,
} from "../services/decision-features.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { decisionReceipt, runDecisionProvider } from "../services/decision-model-provider.js";

vi.mock("../services/decision-model-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/decision-model-provider.js")>();
  return { ...actual, runDecisionProvider: vi.fn() };
});
const provider = vi.mocked(runDecisionProvider);

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-decision-features-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "decision-features-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-decision-features-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
let sequence = 0;

async function fixture() {
  provider.mockReset();
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Decision features", issuePrefix: `DF${++sequence}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Test agent", adapterType: "codex_local" });
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
  await db.insert(issues).values({ id: issueId, companyId, title: "A task that needs a decision" });
  const connections = aiConnectionService(db);
  const binding = await connections.save(companyId, "alice", { provider: "openai", method: "api_key", name: "Decision key", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
  await decisionModelService(db).configure(companyId, "alice", { ...binding, enabled: true, allowBackground: true });
  return { companyId, agentId, issueId, binding, connections };
}

const duplicateAnswer = () => ({ answers: { verdict: { type: "choice" as const, choice: "duplicate", confidence: 0.95 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 50, outputTokens: 0 } }) });

describe("create-time decision hooks", () => {
  it("defers classify/dedupe until the caller's transaction commits", async () => {
    const f = await fixture();
    const deferred: Array<{ id: string; companyId: string }> = [];
    let visibleBeforeCommit = true;
    await db.transaction(async (tx) => {
      const created = await issueService(db).create(f.companyId, {
        title: "Transaction hook timing",
        description: "Classify and dedupe must wait for the commit.",
        assigneeAgentId: f.agentId,
        status: "todo",
        createdByUserId: "alice",
        visibility: "open",
      }, tx, { afterCreate: (issue) => deferred.push(issue) });
      // A separate connection cannot see the uncommitted row; running the
      // decision hooks here would silently no-op, which is the bug this guards.
      visibleBeforeCommit = (await db.select().from(issues).where(eq(issues.id, created.id))).length > 0;
    });
    expect(deferred).toHaveLength(1);
    expect(visibleBeforeCommit).toBe(false);
  });
});

describe("decision escalation loop", () => {  it("creates an issue-scoped ask_user_questions interaction and copies only metadata", async () => {
    const f = await fixture();
    const result = await escalateDecision(db, {
      companyId: f.companyId, featureId: "issues.triage", invocationId: randomUUID(),
      title: "Triage the stuck task", question: "Resume, reassign, or escalate?",
      options: [{ id: "resume", label: "Resume" }, { id: "escalate", label: "Escalate" }],
      issueId: f.issueId, idempotencyKey: "triage-1",
    });
    expect(result).toEqual({ shape: "interaction", id: expect.any(String) });
    if (result.shape !== "interaction") return;
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, result.id));
    expect(row).toMatchObject({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending" });
    expect(JSON.stringify(row!.payload)).toContain("Resume");
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "decision_feature.escalated")));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).toMatchObject({ featureId: "issues.triage" });
  });

  it("reuses the interaction for a repeated escalation key and defers when there is no issue", async () => {
    const f = await fixture();
    const input = { companyId: f.companyId, featureId: "issues.triage", title: "Triage", question: "What next?",
      options: [{ id: "a", label: "Resume" }, { id: "b", label: "Escalate" }], issueId: f.issueId, idempotencyKey: "retry" };
    const first = await escalateDecision(db, input);
    const second = await escalateDecision(db, input);
    expect(first).toEqual(second);
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows).toHaveLength(1);
    expect(await escalateDecision(db, { ...input, issueId: null })).toEqual({ shape: "none", reason: "no_issue" });
  });
});

describe("issues.dedupe feature", () => {
  it("escalates a confident duplicate to the Decisions queue and records the invocation", async () => {
    const f = await fixture();
    const candidateId = randomUUID();
    await db.insert(issues).values({ id: candidateId, companyId: f.companyId, title: "Login redirect loop on mobile devices" });
    await db.update(issues).set({ title: "fix the Login redirect loop on mobile device" }).where(eq(issues.id, f.issueId));
    provider.mockResolvedValueOnce(duplicateAnswer());
    await suggestDuplicateIssue(db, { companyId: f.companyId, issueId: f.issueId });
    const [invocation] = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
    expect(invocation).toMatchObject({ feature: "issues.dedupe", status: "succeeded" });
    expect(provider).toHaveBeenCalledTimes(1);
    const interactions = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, f.companyId), eq(issueThreadInteractions.issueId, f.issueId)));
    expect(interactions).toHaveLength(1);
    expect(JSON.stringify(interactions[0]!.payload)).toContain("duplicate");
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
    expect(costs[0]).toMatchObject({ usageKind: "decision", agentId: null });
  });

  it("stays silent without a similar open task or when the verdict is not a confident duplicate", async () => {
    const f = await fixture();
    await suggestDuplicateIssue(db, { companyId: f.companyId, issueId: f.issueId });
    expect(provider).not.toHaveBeenCalled();
    await db.insert(issues).values({ id: randomUUID(), companyId: f.companyId, title: "An unrelated billing export task" });
    provider.mockResolvedValueOnce({ answers: { verdict: { type: "choice", choice: "distinct", confidence: 0.99 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 50, outputTokens: 0 } }) });
    await suggestDuplicateIssue(db, { companyId: f.companyId, issueId: f.issueId });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
  });
});

describe("issues.triage feature", () => {
  it("escalates a blocked task to the Decisions queue and is idempotent for a day", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    provider.mockResolvedValueOnce({ answers: { verdict: { type: "choice", choice: "escalate", confidence: 0.92 }, assignee_fit: { type: "boolean", probability: 0.3 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 40, outputTokens: 0 } }) });
    await triageIssue(db, { companyId: f.companyId, issueId: f.issueId });
    const [invocation] = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
    expect(invocation).toMatchObject({ feature: "issues.triage", status: "succeeded" });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(1);
    await triageIssue(db, { companyId: f.companyId, issueId: f.issueId });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("records a confident resume verdict without mutating status or escalating", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    provider.mockResolvedValueOnce({ answers: { verdict: { type: "choice", choice: "wake", confidence: 0.95 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 40, outputTokens: 0 } }) });
    await triageIssue(db, { companyId: f.companyId, issueId: f.issueId });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "decision_feature.triaged")));
    expect(activity).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "blocked" });
  });

  it("ignores a task that is not blocked", async () => {
    const f = await fixture();
    await triageIssue(db, { companyId: f.companyId, issueId: f.issueId });
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("plans.gate feature", () => {
  const boardActor = (companyId: string) => ({ type: "board" as const, userId: "alice", source: "session" as const, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner" as const, status: "active" as const }] });

  it("gates a plan that is not ready and proceeds for a ready or missing plan", async () => {
    const f = await fixture();
    const actor = boardActor(f.companyId);
    expect(await gatePlan(db, { companyId: f.companyId, issueId: f.issueId, actor })).toEqual({ status: "proceed" });
    expect(provider).not.toHaveBeenCalled();
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "plan", title: "Plan", format: "markdown", body: "Do the thing." });
    provider.mockResolvedValueOnce({ answers: { ready: { type: "choice", choice: "needs-detail", confidence: 0.9 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 30, outputTokens: 0 } }) });
    expect(await gatePlan(db, { companyId: f.companyId, issueId: f.issueId, actor })).toMatchObject({ status: "gate", choice: "needs-detail" });
    provider.mockResolvedValueOnce({ answers: { ready: { type: "choice", choice: "ready", confidence: 0.95 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 30, outputTokens: 0 } }) });
    expect(await gatePlan(db, { companyId: f.companyId, issueId: f.issueId, actor })).toEqual({ status: "proceed" });
  });

  it("fails open when the not-ready verdict is below the confidence gate", async () => {
    const f = await fixture();
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "plan", title: "Plan", format: "markdown", body: "Do the thing." });
    provider.mockResolvedValueOnce({ answers: { ready: { type: "choice", choice: "blocked", confidence: 0.4 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 30, outputTokens: 0 } }) });
    expect(await gatePlan(db, { companyId: f.companyId, issueId: f.issueId, actor: boardActor(f.companyId) })).toEqual({ status: "proceed" });
  });
});

describe("qa.acceptance feature", () => {
  const boardActor = (companyId: string) => ({ type: "board" as const, userId: "alice", source: "session" as const, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner" as const, status: "active" as const }] });

  it("fails acceptance on a not-pass verdict and passes otherwise, with no plan document as a pass", async () => {
    const f = await fixture();
    const actor = boardActor(f.companyId);
    expect(await checkAcceptance(db, { companyId: f.companyId, issueId: f.issueId, actor })).toEqual({ status: "pass" });
    expect(provider).not.toHaveBeenCalled();
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "plan", title: "Plan", format: "markdown", body: "Outcome: X. Verified by: Y." });
    provider.mockResolvedValueOnce({ answers: { verdict: { type: "choice", choice: "fail", confidence: 0.9 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 30, outputTokens: 0 } }) });
    expect(await checkAcceptance(db, { companyId: f.companyId, issueId: f.issueId, actor })).toMatchObject({ status: "fail", choice: "fail" });
    provider.mockResolvedValueOnce({ answers: { verdict: { type: "choice", choice: "pass", confidence: 0.95 } }, receipt: decisionReceipt("openai", { usage: { inputTokens: 30, outputTokens: 0 } }) });
    expect(await checkAcceptance(db, { companyId: f.companyId, issueId: f.issueId, actor })).toEqual({ status: "pass" });
  });
});

describe("decision prompt guidance", () => {
  it("tracks the configured decision path and its enabled purposes", async () => {
    const f = await fixture();
    expect(await resolveDecisionGuidance(db, f.companyId)).toContain("Calibrated decision service");
    await db.update(companyDecisionModels).set({ enabled: false }).where(eq(companyDecisionModels.companyId, f.companyId));
    expect(await resolveDecisionGuidance(db, f.companyId)).toBeNull();
    const typesafe = await f.connections.save(f.companyId, "alice", { provider: "typesafe", method: "api_key", name: "Jev", ownership: "shared", apiKey: "jev-key", agentIds: [], allAgents: true }, "jev-key");
    await decisionModelService(db).configure(f.companyId, "alice", { ...typesafe, enabled: true, allowBackground: true });
    expect(await resolveDecisionGuidance(db, f.companyId)).toBeNull();
    await decisionModelService(db).configurePurposes(f.companyId, "alice", { purposes: { priority: true } });
    expect(await resolveDecisionGuidance(db, f.companyId)).toContain("priority");
  });
});
