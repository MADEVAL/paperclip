import { z } from "zod";
import type { AiManagedConnectionSummary } from "./ai-connections.js";
import type { TypesafePurpose } from "./typesafe.js";

export const DECISION_MODELS = {
  openai: { id: "gpt-6-luna", name: "GPT-6 Luna" },
  openrouter: { id: "typesafe/jev-1.13", name: "Jev 1.13" },
  // Direct TypeSafe: the same Jev model, called on the account's own key
  // instead of through OpenRouter.
  typesafe: { id: "jev-latest", name: "Jev (TypeSafe direct)" },
} as const;
export type DecisionProvider = keyof typeof DECISION_MODELS;
export const updateDecisionModelSchema = z.object({
  enabled: z.boolean(),
  connectionId: z.string().uuid().nullable(),
  grantId: z.string().uuid().nullable(),
  allowBackground: z.boolean().optional(),
}).refine(v => Boolean(v.connectionId) === Boolean(v.grantId) && (!v.enabled || Boolean(v.connectionId)), {
  message: "Select a connection before enabling decisions",
});
export type UpdateDecisionModel = z.infer<typeof updateDecisionModelSchema>;
export interface DecisionModelSettings extends UpdateDecisionModel {
  allowBackground: boolean;
  companyId: string;
  provider: DecisionProvider | null;
  model: string | null;
  /** Company-level Jev purpose enablement. Absent or false means disabled. */
  purposes: Record<string, boolean>;
}
export type DecisionPurpose = TypesafePurpose;
export const updateDecisionPurposesSchema = z.object({
  purposes: z.record(z.string(), z.boolean()),
}).strict();
export type UpdateDecisionPurposes = z.infer<typeof updateDecisionPurposesSchema>;
export type DecisionConnectionChoice = AiManagedConnectionSummary & { decisionModel: string };

/**
 * The product features that may ask the company decision model, in the order an
 * operator should read them. This is the single source of truth for feature ids
 * and labels: the server registers a matching executable handle and the UI reads
 * labels and purpose hints from here.
 *
 * Every feature is opt-in. A direct TypeSafe connection runs a feature only when
 * its `purpose` is switched on for the company; other providers ignore purposes.
 * `background` marks features a system actor may sponsor on the company's budget
 * (see `allowBackground`). `confidence` is the minimum answer confidence before
 * the feature acts; `fallback` is what happens below the gate.
 */
export interface DecisionFeatureCatalogEntry {
  id: string;
  label: string;
  /** Short operator-facing description of what turning the purpose on spends on. */
  description: string;
  purpose: TypesafePurpose;
  background: boolean;
  confidence: number;
  fallback: "current-behaviour" | "escalate";
}

export const DECISION_FEATURE_CATALOG: readonly DecisionFeatureCatalogEntry[] = [
  { id: "issues.classify", label: "Issue priority", description: "Suggest a priority for a newly created task.", purpose: "priority", background: true, confidence: 0.7, fallback: "current-behaviour" },
  { id: "issues.dedupe", label: "Duplicate check", description: "Detect whether a new task duplicates an open one.", purpose: "issue_triage", background: true, confidence: 0.8, fallback: "current-behaviour" },
  { id: "issues.triage", label: "Issue triage", description: "Choose the next action for a stalled or ambiguous task.", purpose: "issue_triage", background: true, confidence: 0.7, fallback: "escalate" },
  { id: "plans.gate", label: "Plan gate", description: "Check a plan states a verifiable outcome before execution.", purpose: "task_planning", background: true, confidence: 0.75, fallback: "current-behaviour" },
  { id: "qa.acceptance", label: "Acceptance checks", description: "Score acceptance criteria against a change.", purpose: "qa_acceptance", background: false, confidence: 0.7, fallback: "current-behaviour" },
] as const;

export const DECISION_FEATURE_IDS = DECISION_FEATURE_CATALOG.map((entry) => entry.id);

const DECISION_FEATURE_BY_ID = new Map(DECISION_FEATURE_CATALOG.map((entry) => [entry.id, entry]));

/** Internal, non-product features that still appear in decision history. */
const INTERNAL_DECISION_FEATURE_LABELS: Record<string, string> = { "settings.test": "Setup test" };

export function decisionFeatureDefinition(id: string): DecisionFeatureCatalogEntry | null {
  return DECISION_FEATURE_BY_ID.get(id) ?? null;
}

/** Product label for a feature id; falls back to the raw id so history never breaks. */
export function decisionFeatureLabel(id: string): string {
  return DECISION_FEATURE_BY_ID.get(id)?.label ?? INTERNAL_DECISION_FEATURE_LABELS[id] ?? id;
}

export function decisionFeaturesForPurpose(purpose: TypesafePurpose): DecisionFeatureCatalogEntry[] {
  return DECISION_FEATURE_CATALOG.filter((entry) => entry.purpose === purpose);
}

/** A catalog entry plus whether the company has switched its purpose on. */
export interface DecisionFeatureStatus extends DecisionFeatureCatalogEntry {
  enabled: boolean;
}
export type DecisionUnavailableReason = "not_configured" | "disabled" | "connection_unavailable" | "incompatible_connection" | "access_denied" | "responsible_user_missing" | "background_disabled" | "budget_blocked" | "purpose_disabled";
export type DecisionAvailability = { available: true } | { available: false; reason: DecisionUnavailableReason };
const instructions = z.string().trim().min(1).max(8000);
export const decisionQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), instructions }),
  z.object({ type: z.literal("choice"), instructions, criteria: z.record(z.string().min(1).max(100), z.string().min(1).max(2000)).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 20) }),
  z.object({ type: z.literal("score"), instructions, criteria: z.array(z.string().min(1).max(2000)).min(2).max(20) }),
]);
export const decisionRequestSchema = z.object({
  state: z.union([z.string().min(1), z.record(z.string(), z.json()), z.array(z.json())]),
  questions: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), decisionQuestionSchema)
    .refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 20),
});
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionAnswer =
  | { type: "boolean"; probability: number; confidence?: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number };
export interface DecisionUsage {
  inputTokens: number | null; outputTokens: number | null; costCents: string | null;
  costStatus: "reported" | "estimated" | "unpriced";
}
export type DecisionResult =
  | { status: "succeeded"; invocationId: string; answers: Record<string, DecisionAnswer>; usage: DecisionUsage }
  | { status: "unavailable"; reason: DecisionUnavailableReason; invocationId?: string }
  | { status: "failed"; invocationId: string; errorCode: string; usage: DecisionUsage };
export interface DecisionHistoryEntry {
  id: string; feature: string; actorType: string; responsibleUserId: string | null; userName: string | null;
  issueId: string | null; issueIdentifier: string | null; agentId: string | null; runId: string | null;
  connectionId: string; provider: string; model: string; status: string; errorCode: string | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  inputTokens: number | null; outputTokens: number | null; costCents: string | null; costStatus: string | null;
}
export const DECISION_TEST_REQUEST: DecisionRequest = {
  state: "A customer reports being charged twice for an order. The product still works.",
  questions: {
    billing: { type: "boolean", instructions: "Is this a billing problem?" },
    team: { type: "choice", instructions: "Which team should handle the request?", criteria: { billing: "Charges and payments", technical: "Product failures" } },
    severity: { type: "score", instructions: "How severe is the product disruption?", criteria: ["Product works", "Some functionality is unavailable", "Product cannot be used"] },
  },
};

/** Native endpoints only; OpenRouter's official routing metadata is compatible. */
export function decisionProviderForConnection(metadata: { provider: string; method: string; routing?: { kind: string; baseUrl?: string } }): DecisionProvider | null {
  if (metadata.method !== "api_key") return null;
  if (metadata.provider === "openai" && !metadata.routing) return "openai";
  if (metadata.provider === "openrouter" && (!metadata.routing || (metadata.routing.kind === "openrouter" && !metadata.routing.baseUrl))) return "openrouter";
  if (metadata.provider === "typesafe" && !metadata.routing) return "typesafe";
  return null;
}
