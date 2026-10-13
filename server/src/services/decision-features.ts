import { and, desc, eq, gte, ne, notInArray, sql } from "drizzle-orm";
import { decisionInvocations, issues, type Db } from "@paperclipai/db";
import { decisionFeatureDefinition, type DecisionAnswer, type DecisionProvider } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { decisionModelService, defineDecisionFeature, type DecisionContext } from "./decision-models.js";

/**
 * Registered direct-Jev decision features. A feature is inert until its purpose
 * is switched on in Company Settings and a shared TypeSafe connection is saved.
 *
 * `DECISION_FEATURES` is the executable subset of the shared product catalog.
 * The registry is drift-checked against that catalog in `defineDecisionFeature`.
 */
export const issuesClassify = defineDecisionFeature("issues.classify", { background: true, purpose: "priority" });
export const issuesDedupe = defineDecisionFeature("issues.dedupe", { background: true, purpose: "issue_triage" });
export const issuesTriage = defineDecisionFeature("issues.triage", { background: true, purpose: "issue_triage" });
export const plansGate = defineDecisionFeature("plans.gate", { background: true, purpose: "task_planning" });
export const qaAcceptance = defineDecisionFeature("qa.acceptance", { background: false, purpose: "qa_acceptance" });
export const DECISION_FEATURES = [issuesClassify, issuesDedupe, issuesTriage, plansGate, qaAcceptance] as const;

/** Catalog status for the company decision settings page: only registered features are advertised. */
export function decisionFeatureStatuses(purposes: Record<string, boolean> = {}) {
  return DECISION_FEATURES.flatMap((feature) => {
    const catalog = decisionFeatureDefinition(feature.id);
    if (!catalog) return [];
    return [{ ...catalog, enabled: purposes[catalog.purpose] === true }];
  });
}

const PRIORITY_LEVELS = ["low", "medium", "high", "critical"] as const;

/**
 * heartbeat.js imports issues.js, which imports this module, so resolve the
 * decision service with its budget hook lazily to keep the module graph acyclic.
 */
async function decisionService(db: Db) {
  const { heartbeatService } = await import("./heartbeat.js");
  return decisionModelService(db, { budgetHooks: { cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork } });
}

/** Confidence carried by an answer; booleans expose probability instead of confidence. */
export function answerConfidence(answer: DecisionAnswer | undefined): number {
  if (!answer) return 0;
  if (answer.type === "boolean") return answer.probability;
  return answer.confidence ?? 0;
}

/**
 * Best-effort priority suggestion for a newly created issue.
 *
 * Never throws to the caller, never touches assignment or status, and only acts
 * above the feature's confidence gate. It sends only the title and description,
 * only for open tasks that still hold the default priority, so private content
 * is never forwarded and an explicit human choice is never overridden. A
 * disabled purpose or an unconfigured model makes this a no-op.
 */
export async function suggestIssuePriority(db: Db, input: { companyId: string; issueId: string }): Promise<void> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue || issue.visibility !== "open" || issue.priority !== "medium") return;
  const context: DecisionContext = { companyId: input.companyId, feature: issuesClassify, actor: { type: "system" }, issueId: input.issueId };
  const service = await decisionService(db);
  if (!(await service.availability(context)).available) return;
  const result = await service.decide(context, {
    state: { title: issue.title, description: issue.description ?? "" },
    questions: {
      priority: { type: "score", instructions: "Rate this task's severity and urgency.", criteria: [...PRIORITY_LEVELS] },
    },
  });
  if (result.status !== "succeeded") return;
  const answer = result.answers.priority;
  if (answer?.type !== "score" || answerConfidence(answer) < issuesClassify.confidence) return;
  const priority = PRIORITY_LEVELS[Math.round(answer.score)];
  if (!priority) return;
  await db.update(issues).set({ priority, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)));
}

/**
 * Best-effort duplicate check for a newly created issue.
 *
 * Compares the new task against the closest open siblings and, only when the
 * decision model is confident the task is a duplicate, asks the board what to do
 * through the Decisions queue. It never links, closes, or mutates the task
 * itself: v1 has no safe duplicate-link primitive, so the action is an
 * escalation. A disabled purpose or unconfigured model makes this a no-op, and
 * any failure is swallowed by the caller.
 */
export async function suggestDuplicateIssue(db: Db, input: { companyId: string; issueId: string }): Promise<void> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue || issue.visibility !== "open") return;
  const similarity = sql<number>`similarity(${issues.title}, ${issue.title})`;
  const candidates = await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title })
    .from(issues).where(and(
      eq(issues.companyId, input.companyId), ne(issues.id, issue.id), eq(issues.visibility, "open"),
      notInArray(issues.status, ["done", "cancelled"]), sql`${similarity} > 0.2`,
    )).orderBy(desc(similarity)).limit(5);
  if (candidates.length === 0) return;
  const context: DecisionContext = { companyId: input.companyId, feature: issuesDedupe, actor: { type: "system" }, issueId: input.issueId };
  const service = await decisionService(db);
  if (!(await service.availability(context)).available) return;
  const result = await service.decide(context, {
    state: {
      title: issue.title, description: issue.description ?? "",
      candidates: candidates.map((row) => ({ identifier: row.identifier, title: row.title })),
    },
    questions: {
      verdict: { type: "choice", instructions: "Is this new task a duplicate of one of the listed tasks, related to one, or a distinct task?",
        criteria: { duplicate: "Same requested outcome as an existing task", related: "Overlaps but asks for different work", distinct: "Unrelated or genuinely new work" } },
    },
  });
  if (result.status !== "succeeded") return;
  const answer = result.answers.verdict;
  if (answer?.type !== "choice" || answerConfidence(answer) < issuesDedupe.confidence || answer.choice !== "duplicate") return;
  const match = candidates[0]!;
  await escalateDecision(db, {
    companyId: input.companyId, featureId: issuesDedupe.id, invocationId: result.invocationId,
    title: `Possible duplicate: ${issue.identifier ?? issue.title}`,
    question: `This task looks like a duplicate of ${match.identifier ?? match.title} ("${match.title}"). What should Paperclip do?`,
    summary: "A background duplicate check flagged this task. Nothing was linked or closed automatically.",
    options: [
      { id: "keep-both", label: "Keep both tasks" },
      { id: "mark-duplicate", label: "Mark this task as a duplicate" },
      { id: "not-duplicate", label: "Not a duplicate" },
    ],
    issueId: input.issueId, idempotencyKey: `dedupe:${input.issueId}`,
  });
}

/**
 * Best-effort triage of a stranded task.
 *
 * Runs from the recovery sweep after an issue has already been escalated to the
 * board (status `blocked`), never on the hot path of a user action. It asks the
 * decision service for a next-action verdict plus an assignee-fit check and a
 * staleness score, and:
 *
 * - for a confident `resume`/`wake` verdict it records the judgment but performs
 *   no mutation: waking and requeueing stay owned by the recovery engine, and v1
 *   will not double-wake;
 * - for every other verdict, or below the confidence gate, it turns the decision
 *   into a board question through `escalateDecision`.
 *
 * It is idempotent per issue for a day: a recent `issues.triage` invocation on
 * the same task short-circuits, so a 30-second sweep cannot re-bill the provider
 * or flood the queue. Failures never propagate to the sweep.
 */
export async function triageIssue(db: Db, input: { companyId: string; issueId: string }): Promise<void> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue || issue.visibility !== "open" || issue.status !== "blocked") return;
  const [recent] = await db.select({ id: decisionInvocations.id }).from(decisionInvocations).where(and(
    eq(decisionInvocations.companyId, input.companyId), eq(decisionInvocations.issueId, input.issueId),
    eq(decisionInvocations.feature, issuesTriage.id), gte(decisionInvocations.startedAt, new Date(Date.now() - 24 * 60 * 60 * 1_000)),
  )).limit(1);
  if (recent) return;
  const context: DecisionContext = { companyId: input.companyId, feature: issuesTriage, actor: { type: "system" }, issueId: input.issueId };
  const service = await decisionService(db);
  if (!(await service.availability(context)).available) return;
  const result = await service.decide(context, {
    state: { title: issue.title, description: issue.description ?? "", status: issue.status, priority: issue.priority },
    questions: {
      verdict: { type: "choice", instructions: "What should Paperclip do with this blocked task?",
        criteria: { resume: "Continue the existing assignment", wake: "Wake the assignee for another attempt", reassign: "Give the work to someone else", unblock: "Remove a blocker and retry", escalate: "A person must decide", close: "Stop the work" } },
      assignee_fit: { type: "boolean", instructions: "Is the current assignee still the right owner for this task?" },
      staleness: { type: "score", instructions: "How stale is this blocked task?", criteria: ["Fresh", "Aging", "Stale"] },
    },
  }, AbortSignal.timeout(5_000));
  if (result.status !== "succeeded") return;
  const verdict = result.answers.verdict;
  const choice = verdict?.type === "choice" ? verdict.choice : null;
  const confident = answerConfidence(verdict) >= issuesTriage.confidence;
  if (confident && (choice === "resume" || choice === "wake")) {
    await logActivity(db, {
      companyId: input.companyId, actorType: "system", actorId: "paperclip-decisions",
      action: "decision_feature.triaged", entityType: "issue", entityId: input.issueId, issueId: input.issueId,
      details: { featureId: issuesTriage.id, invocationId: result.invocationId, verdict: choice, acted: false, reason: "recovery engine owns resume/wake" },
    });
    return;
  }
  const assigneeFit = result.answers.assignee_fit;
  await escalateDecision(db, {
    companyId: input.companyId, featureId: issuesTriage.id, invocationId: result.invocationId,
    title: `Blocked task: ${issue.identifier ?? issue.title}`,
    question: `Paperclip could not recover this blocked task automatically. Jev suggests "${choice ?? "unclear"}"${assigneeFit?.type === "boolean" ? ` (assignee fit ${Math.round(assigneeFit.probability * 100)}%)` : ""}. What should happen next?`,
    summary: "A background triage of a blocked task. Nothing was resumed, reassigned, or closed automatically.",
    options: [
      { id: "resume", label: "Resume the existing assignment" },
      { id: "reassign", label: "Reassign the task" },
      { id: "unblock", label: "Remove the blocker and retry" },
      { id: "close", label: "Close the task" },
      { id: "leave-blocked", label: "Leave it blocked for now" },
    ],
    issueId: input.issueId, idempotencyKey: `triage:${input.issueId}`,
  });
}

/**
 * Triage the issues a recovery sweep escalated to the board. Bounded and
 * best-effort: the sweep never waits on the provider, and a failure is swallowed.
 */
export async function triageEscalatedIssues(db: Db, issueIds: string[]): Promise<void> {
  for (const issueId of [...new Set(issueIds)].slice(0, 3)) {
    try {
      const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
      if (issue) await triageIssue(db, { companyId: issue.companyId, issueId });
    } catch { /* Triage is best-effort; never affect the recovery sweep. */ }
  }
}

export type PlanGateResult =
  | { status: "proceed" }
  | { status: "gate"; invocationId: string; choice: string; confidence: number };

/**
 * Gate a plan-document confirmation at accept time.
 *
 * Called by the accept route *before* the resolution transaction, so the provider
 * call never runs while issue/interaction rows are locked. It reads the plan
 * document and asks whether the plan states a verifiable outcome:
 *
 * - `proceed` when the decision service is unavailable, the plan is empty/ready,
 *   or the verdict is below the confidence gate. This is the fail-open default:
 *   a decision-model problem must never block an operator from accepting a plan.
 * - `gate` when the verdict is not ready. The accept still records the decision
 *   but the task must not flip into execution; the caller suppresses the execution
 *   start and can escalate the missing detail.
 */
export async function gatePlan(
  db: Db,
  input: { companyId: string; issueId: string; actor: AuthorizationActor },
): Promise<PlanGateResult> {
  const context: DecisionContext = { companyId: input.companyId, feature: plansGate, actor: input.actor, issueId: input.issueId };
  const service = await decisionService(db);
  if (!(await service.availability(context)).available) return { status: "proceed" };
  const { documentService } = await import("./documents.js");
  const plan = await documentService(db).getIssueDocumentByKey(input.issueId, "plan").catch(() => null);
  const body = plan && typeof plan.body === "string" ? plan.body.trim() : "";
  if (!body) return { status: "proceed" };
  const result = await service.decide(context, {
    state: { plan: body.slice(0, 20_000) },
    questions: {
      ready: { type: "choice", instructions: "Is this plan ready to execute?",
        criteria: { ready: "States a clear outcome and how to verify it", "needs-detail": "Missing an outcome or a way to verify it", blocked: "Cannot proceed as written" } },
      coverage: { type: "score", instructions: "How completely does the plan state verifiable acceptance criteria?", criteria: ["None", "Partial", "Complete"] },
      verifiable: { type: "boolean", instructions: "Does the plan name how the result will be verified?" },
    },
  }, AbortSignal.timeout(8_000));
  if (result.status !== "succeeded") return { status: "proceed" };
  const ready = result.answers.ready;
  const confidence = answerConfidence(ready);
  const choice = ready?.type === "choice" ? ready.choice : null;
  if (choice === "ready" || choice === null || confidence < plansGate.confidence) return { status: "proceed" };
  return { status: "gate", invocationId: result.invocationId, choice, confidence };
}

export type AcceptanceResult =
  | { status: "pass" }
  | { status: "fail"; invocationId: string; choice: string };

/**
 * Check a change against a task's acceptance criteria before an agent's
 * self-review can auto-complete it.
 *
 * Called by the review-comment route only for an *agent*-origin approval, so a
 * human's explicit approval is never overridden. Fail-open: an unavailable
 * decision model, a task without a plan document, or a below-gate verdict all
 * return `pass`, which preserves today's behaviour.
 */
export async function checkAcceptance(
  db: Db,
  input: { companyId: string; issueId: string; actor: AuthorizationActor },
): Promise<AcceptanceResult> {
  const context: DecisionContext = { companyId: input.companyId, feature: qaAcceptance, actor: input.actor, issueId: input.issueId };
  const service = await decisionService(db);
  if (!(await service.availability(context)).available) return { status: "pass" };
  const { documentService } = await import("./documents.js");
  const plan = await documentService(db).getIssueDocumentByKey(input.issueId, "plan").catch(() => null);
  const criteria = plan && typeof plan.body === "string" ? plan.body.trim() : "";
  if (!criteria) return { status: "pass" };
  const { workProductService } = await import("./work-products.js");
  const products = await workProductService(db).listForIssue(input.issueId).catch(() => []);
  const change = products.slice(0, 20)
    .map((product) => `${product.type}: ${product.title}${product.summary ? ` - ${product.summary}` : ""}`)
    .join("\n");
  const result = await service.decide(context, {
    state: { acceptance_criteria: criteria.slice(0, 16_000), change_summary: change.slice(0, 8_000) || "(no work products recorded)" },
    questions: {
      verdict: { type: "choice", instructions: "Does the recorded change meet the acceptance criteria?",
        criteria: { pass: "Every criterion is met", fail: "At least one criterion is not met", unclear: "Cannot be verified from the available evidence" } },
      coverage: { type: "score", instructions: "How completely is the change verifiable against the criteria?", criteria: ["Not verified", "Partially verified", "Fully verified"] },
      met: { type: "boolean", instructions: "Are all acceptance criteria met?" },
    },
  }, AbortSignal.timeout(8_000));
  if (result.status !== "succeeded") return { status: "pass" };
  const verdict = result.answers.verdict;
  const confidence = answerConfidence(verdict);
  const choice = verdict?.type === "choice" ? verdict.choice : null;
  if (choice === "pass" || choice === null || confidence < qaAcceptance.confidence) return { status: "pass" };
  return { status: "fail", invocationId: result.invocationId, choice };
}

export interface DecisionEscalationInput {
  companyId: string;
  featureId: string;
  invocationId?: string | null;
  title: string;
  question: string;
  summary?: string | null;
  options: Array<{ id: string; label: string; description?: string | null }>;
  issueId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  /** Stable per-escalation key; the interaction idempotency key is namespaced from it. */
  idempotencyKey: string;
}

export type DecisionEscalationResult = { shape: "interaction"; id: string } | { shape: "none"; reason: "no_issue" };

/**
 * Connect a below-threshold or authority-gated decision to the human loop.
 *
 * Shape A (issue-scoped): create an `ask_user_questions` interaction. Pending
 * interactions are seeded into the left-menu Decisions -> Questions queue by the
 * `ask-user-questions` rule, so no queue row is written here. The interaction
 * carries only the feature id, the question, and option labels; the decision
 * `state` and the provider's answer are never copied.
 *
 * Shape B (agent/run + pick-an-option-then-act) needs a live, issue-scoped run
 * and is left to the agent path (`typesafe_ask`) in v1. Shape C (no issue) has no
 * queue source today, so it returns `none`; the caller reports on its own surface.
 */
export async function escalateDecision(db: Db, input: DecisionEscalationInput): Promise<DecisionEscalationResult> {
  if (!input.issueId) return { shape: "none", reason: "no_issue" };
  const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
  const interaction = await issueThreadInteractionService(db).create(
    { id: input.issueId, companyId: input.companyId },
    {
      kind: "ask_user_questions",
      idempotencyKey: `decision-escalation:${input.idempotencyKey}`,
      title: input.title.slice(0, 240),
      summary: input.summary?.slice(0, 1000) ?? null,
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        title: input.title.slice(0, 240),
        questions: [{
          id: "decision",
          prompt: input.question.slice(0, 4000),
          selectionMode: "single",
          required: true,
          options: input.options.slice(0, 20).map((option) => ({
            id: option.id.slice(0, 160),
            label: option.label.slice(0, 1000),
            ...(option.description ? { description: option.description.slice(0, 1000) } : {}),
          })),
        }],
      },
    },
    input.agentId || input.runId
      ? { agentId: input.agentId ?? null, runId: input.runId ?? null }
      : { systemId: "paperclip-decisions" },
  );
  await logActivity(db, {
    companyId: input.companyId, actorType: "system", actorId: "paperclip-decisions",
    action: "decision_feature.escalated", entityType: "issue", entityId: input.issueId, issueId: input.issueId,
    details: {
      featureId: input.featureId, invocationId: input.invocationId ?? null,
      question: input.question.slice(0, 500), optionLabels: input.options.map((option) => option.label),
    },
  });
  return { shape: "interaction", id: interaction.id };
}

const DECISION_GUIDANCE_HEADER = "Calibrated decision service:";

/**
 * Guidance block injected into an agent's task context when (and only when) the
 * company has an enabled decision model. The server-side decision path has no
 * agent tool; the agent-facing path stays the `typesafe_ask` connector tool, so
 * the block names both instead of promising a tool that may not be installed.
 */
export function decisionGuidance(input: { provider: DecisionProvider | null; purposes: string[] }): string | null {
  if (!input.provider) return null;
  const lines = [
    DECISION_GUIDANCE_HEADER,
    "This company has a calibrated decision service. For judgment calls named in your skills (triage, plan review, acceptance, priority, guardrails, inbox gardening), prefer it over guessing.",
    "It answers typed questions with a confidence score. When a result is below the stated threshold, escalate to the board instead of acting.",
  ];
  if (input.provider === "typesafe") {
    lines.push(`Enabled purposes: ${input.purposes.length > 0 ? input.purposes.join(", ") : "none"}.`);
    lines.push("Paperclip runs the server-side decision path automatically for those purposes. If a `typesafe_ask` tool is installed in your run, use it for the same purpose-gated judgment.");
  } else {
    lines.push("Paperclip runs these decisions automatically through the company decision model. Use them where your skills describe a judgment call.");
  }
  return lines.join("\n");
}

/** Read the company decision settings and return the guidance block, or null when no path is enabled. */
export async function resolveDecisionGuidance(db: Db, companyId: string): Promise<string | null> {
  const settings = await decisionModelService(db).settings(companyId);
  if (!settings.enabled || !settings.connectionId || !settings.provider) return null;
  const purposes = Object.entries(settings.purposes ?? {}).filter(([, on]) => on === true).map(([id]) => id);
  if (settings.provider === "typesafe" && purposes.length === 0) return null;
  return decisionGuidance({ provider: settings.provider, purposes });
}
