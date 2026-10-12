import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { decisionModelService, defineDecisionFeature } from "./decision-models.js";

/**
 * Registered direct-Jev decision features. A feature is inert until its purpose
 * is switched on in Company Settings and a shared TypeSafe connection is saved.
 */
export const issuesClassify = defineDecisionFeature("issues.classify", { background: true, purpose: "priority" });
export const DECISION_FEATURES = [issuesClassify] as const;

/** Severity rubric, ordered ascending. The returned score is a zero-based index. */
const PRIORITY_LEVELS = ["low", "medium", "high", "critical"] as const;
const PRIORITY_CONFIDENCE_GATE = 0.7;

/**
 * heartbeat.js imports issues.js, which imports this module, so resolve the
 * decision service with its budget hook lazily to keep the module graph acyclic.
 */
async function decisionService(db: Db) {
  const { heartbeatService } = await import("./heartbeat.js");
  return decisionModelService(db, { budgetHooks: { cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork } });
}

/**
 * Best-effort priority suggestion for a newly created issue.
 *
 * Never throws to the caller, never touches assignment or status, and only acts
 * above the confidence gate. It sends only the title and description, only for
 * open tasks that still hold the default priority, so private content is never
 * forwarded and an explicit human choice is never overridden. A disabled purpose
 * or an unconfigured model makes this a no-op.
 */
export async function suggestIssuePriority(db: Db, input: { companyId: string; issueId: string }): Promise<void> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue || issue.visibility !== "open" || issue.priority !== "medium") return;
  const context = { companyId: input.companyId, feature: issuesClassify, actor: { type: "system" as const }, issueId: input.issueId };
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
  if (answer?.type !== "score" || (answer.confidence ?? 0) < PRIORITY_CONFIDENCE_GATE) return;
  const priority = PRIORITY_LEVELS[Math.round(answer.score)];
  if (!priority) return;
  await db.update(issues).set({ priority, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)));
}
