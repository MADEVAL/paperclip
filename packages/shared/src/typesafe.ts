import { z } from "zod";

const structured = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
const criterion = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
const question = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      instructions: structured,
      criteria: z.object({ true: criterion.optional(), false: criterion.optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: structured,
      criteria: z.record(z.string().min(1), criterion.nullable()).refine((value) => {
        const size = Object.keys(value).length;
        return size >= 1 && size <= 255;
      }, "A choice needs 1 to 255 options"),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: structured,
      criteria: z.array(criterion).min(2).max(10),
    })
    .strict(),
]);

export const typesafeAskSchema = z
  .object({
    state: structured,
    questions: z
      .record(z.string().min(1), question)
      .refine((value) => Object.keys(value).length >= 1, "At least one question is required"),
    model: z.string().min(1).max(100).optional(),
    connectionId: z.string().uuid().optional(),
    // The product purpose this call serves. When present, Paperclip refuses a
    // purpose the connection's operator switched off.
    purpose: z
      .enum([
        "issue_triage",
        "task_planning",
        "qa_acceptance",
        "priority",
        "inbox_gardening",
        "guardrails",
      ])
      .optional(),
  })
  .strict();
export type TypesafeAsk = z.infer<typeof typesafeAskSchema>;

/**
 * The named Paperclip purposes Jev may serve. Each purpose maps to one
 * connection `methodConfig` checkbox so an operator can allow or deny it on the
 * connection (and, later, per company). Keep ids stable; they appear in the
 * tool schema, the CLI and the HTTP API.
 */
export const TYPESAFE_PURPOSES = [
  {
    id: "issue_triage",
    fieldKey: "purposeIssueTriage",
    label: "Issue triage",
    description: "Classify an issue's next action (resume, reassign, unblock, escalate, close).",
  },
  {
    id: "task_planning",
    fieldKey: "purposeTaskPlanning",
    label: "Plan review",
    description: "Check a plan states a clear outcome and how to verify it before execution.",
  },
  {
    id: "qa_acceptance",
    fieldKey: "purposeQaAcceptance",
    label: "Acceptance checks",
    description: "Score acceptance-criteria coverage and per-criterion pass/fail.",
  },
  {
    id: "priority",
    fieldKey: "purposePriority",
    label: "Priority and severity",
    description: "Score severity and impact to suggest an issue priority.",
  },
  {
    id: "inbox_gardening",
    fieldKey: "purposeInboxGardening",
    label: "Inbox gardening",
    description: "Decide which inbox items are safe to archive.",
  },
  {
    id: "guardrails",
    fieldKey: "purposeGuardrails",
    label: "Outbound guardrails",
    description: "Screen outbound messages for leaked content or policy risk.",
  },
] as const;
export type TypesafePurpose = (typeof TYPESAFE_PURPOSES)[number]["id"];
export const TYPESAFE_PURPOSE_IDS = TYPESAFE_PURPOSES.map((entry) => entry.id) as TypesafePurpose[];

/** Purpose ids the connection's operator has switched on in `methodConfig`. */
export function enabledTypesafePurposes(methodConfig: unknown): TypesafePurpose[] {
  const config =
    methodConfig && typeof methodConfig === "object" && !Array.isArray(methodConfig)
      ? (methodConfig as Record<string, unknown>)
      : {};
  return TYPESAFE_PURPOSES.filter((entry) => config[entry.fieldKey] === true).map(
    (entry) => entry.id,
  );
}

/** True when `purpose` is absent or the operator enabled that purpose. */
export function isTypesafePurposeAllowed(
  methodConfig: unknown,
  purpose: TypesafePurpose | undefined,
): boolean {
  if (!purpose) return true;
  return enabledTypesafePurposes(methodConfig).includes(purpose);
}


export type TypesafeAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };
export interface TypesafeAskResult {
  model: string;
  answers: Record<string, TypesafeAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
