import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, connectionGrants, decisionInvocations, issues, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { isTypesafePurposeAllowed, typesafeAskSchema, TYPESAFE_PURPOSE_IDS, type TypesafeAskResult } from "@paperclipai/shared";
import { HttpError, badRequest, forbidden, unprocessable } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { createCostEventInTransaction } from "../costs.js";
import { decisionReceipt } from "../decision-model-provider.js";
import { secretService } from "../secrets.js";
import { toolAccessPolicyService } from "../tool-access-policy.js";
import {
  TypesafeApiError,
  isTypesafeConnection,
  typesafeApi,
} from "../typesafe-api.js";

const structured = { type: ["string", "object", "array"] };
// Connector-owned definition. It is never part of the universal runner catalog.
export const TYPESAFE_TOOLS = [
  {
    name: "typesafe_ask",
    description:
      "Ask TypeSafe's Jev model typed questions about a state and get calibrated answers. Question types: noul (yes/no probability), choice (one option plus probabilities), score (rating on 2-10 ordered levels). Jev does not write text or take actions. The state and questions are sent to TypeSafe.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          ...structured,
          description: "Text or structured data to evaluate.",
        },
        questions: {
          type: "object",
          description:
            "Map of your question id to a question. Answers return under the same ids.",
          minProperties: 1,
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["noul", "choice", "score"] },
              instructions: structured,
              criteria: {
                description:
                  "noul: optional {true,false}. choice: map of option to description or null (1-255). score: ordered array of 2-10 levels.",
              },
            },
            required: ["type", "instructions"],
            additionalProperties: false,
          },
        },
        model: {
          type: "string",
          description: "Overrides the connection's model, for example jev-preview.",
        },
        connectionId: {
          type: "string",
          description:
            "Required only when more than one TypeSafe connection is assigned.",
        },
        purpose: {
          type: "string",
          enum: [...TYPESAFE_PURPOSE_IDS],
          description:
            "The Paperclip purpose this call serves, for example issue_triage. Omit for an ad-hoc question. A purpose the connection's operator switched off is refused.",
        },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
  },
] as const;

type AgentBinding = { companyId: string; agentId: string };
type AskBinding = AgentBinding & {
  runId?: string | null;
  issueId?: string | null;
};

const API_KEY_PATH = "credentials.apiKey";

/**
 * The agent-side `typesafe_ask` path bypasses the company decision model, so it
 * must record its own invocation and cost event. Metadata only: the state,
 * questions, and answers never reach the ledger.
 */
async function recordTypesafeAskAccounting(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    issueId: string | null;
    connectionId: string;
    purpose: string | null;
    model: string;
    questionTypes: string[];
    usage: { input_tokens?: number | null; output_tokens?: number | null } | null | undefined;
    startedAt: Date;
  },
) {
  try {
    const receipt = decisionReceipt("typesafe", {
      usage: { inputTokens: input.usage?.input_tokens ?? null, outputTokens: input.usage?.output_tokens ?? null },
    });
    await db.transaction(async (tx) => {
      const [grant] = await tx.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
        eq(connectionGrants.companyId, input.companyId),
        eq(connectionGrants.connectionId, input.connectionId),
        eq(connectionGrants.status, "active"),
      )).orderBy(desc(connectionGrants.isDefault)).limit(1);
      if (!grant) return;
      // Ledger foreign keys point at live rows only.
      const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
      ));
      const [issue] = input.issueId
        ? await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
        ))
        : [];
      const invocationId = randomUUID();
      const event = await createCostEventInTransaction(tx as unknown as Db, input.companyId, {
        usageKind: "decision",
        responsibleUserId: null,
        agentId: agent?.id ?? null,
        issueId: issue?.id ?? null,
        projectId: null,
        heartbeatRunId: null,
        idempotencyKey: `typesafe-ask:${invocationId}`,
        provider: "typesafe",
        biller: "typesafe",
        billingType: "metered_api",
        costStatus: receipt.costStatus,
        model: input.model,
        inputTokens: receipt.inputTokens ?? 0,
        outputTokens: receipt.outputTokens ?? 0,
        costCents: receipt.costCents ?? "0",
        providerRequestId: receipt.providerRequestId,
        pricingProvenance: receipt.pricingProvenance,
        occurredAt: input.startedAt,
      }, [], { actorType: "agent", actorId: input.agentId, agentId: agent?.id ?? null });
      await tx.insert(decisionInvocations).values({
        id: invocationId,
        companyId: input.companyId,
        feature: "typesafe.ask",
        actorType: "agent",
        actorId: input.agentId,
        responsibleUserId: null,
        agentId: agent?.id ?? null,
        issueId: issue?.id ?? null,
        projectId: null,
        runId: input.runId,
        identityContextId: null,
        connectionId: input.connectionId,
        grantId: grant.id,
        provider: "typesafe",
        model: input.model,
        questionTypes: input.questionTypes,
        status: "succeeded",
        errorCode: null,
        providerRequestId: receipt.providerRequestId,
        costEventId: event.id,
        startedAt: input.startedAt,
        finishedAt: new Date(),
        durationMs: Math.max(0, Date.now() - input.startedAt.getTime()),
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens,
      });
    });
  } catch {
    // Accounting must never fail an otherwise successful ask.
  }
}

export async function assignedTypesafeConnections(
  db: Db,
  binding: AgentBinding,
) {
  const rows = await db
    .selectDistinct({ connection: toolConnections })
    .from(toolConnections)
    .innerJoin(
      toolConnectionInstalls,
      and(
        eq(toolConnectionInstalls.connectionId, toolConnections.id),
        eq(toolConnectionInstalls.companyId, binding.companyId),
      ),
    )
    .where(
      and(
        eq(toolConnections.companyId, binding.companyId),
        eq(toolConnections.transport, "rest_api"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
        // Same health gate as the tool gateway's catalog.
        inArray(toolConnections.healthStatus, ["ok", "healthy"]),
        or(
          and(
            eq(toolConnectionInstalls.targetType, "company"),
            eq(toolConnectionInstalls.targetId, binding.companyId),
          ),
          and(
            eq(toolConnectionInstalls.targetType, "agent"),
            eq(toolConnectionInstalls.targetId, binding.agentId),
          ),
        ),
      ),
    );
  return rows
    .map((row) => row.connection)
    .filter(isTypesafeConnection)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function executeTypesafeAsk(
  db: Db,
  binding: AskBinding,
  value: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<TypesafeAskResult> {
  const parsed = typesafeAskSchema.safeParse(value);
  if (!parsed.success)
    throw badRequest("Invalid TypeSafe request", { issues: parsed.error.issues });
  const input = parsed.data;

  const connections = await assignedTypesafeConnections(db, binding);
  if (!connections.length)
    throw forbidden("No TypeSafe connection is assigned to this agent");
  if (!input.connectionId && connections.length > 1)
    throw unprocessable("Choose a TypeSafe connection", {
      code: "typesafe_connection_required",
      connectionIds: connections.map((candidate) => candidate.id),
    });
  const connection = input.connectionId
    ? connections.find((candidate) => candidate.id === input.connectionId)
    : connections[0];
  if (!connection)
    throw forbidden("That TypeSafe connection is not assigned to this agent");

  if (!isTypesafePurposeAllowed(connection.config.methodConfig, input.purpose))
    throw forbidden("This TypeSafe connection is not enabled for that purpose", {
      code: "typesafe_purpose_disabled",
      purpose: input.purpose,
    });

  const methodConfig = connection.config.methodConfig;
  const configured =
    methodConfig && typeof methodConfig === "object" && !Array.isArray(methodConfig)
      ? (methodConfig as Record<string, unknown>).model
      : undefined;
  const model = input.model ?? configured;
  if (typeof model !== "string" || !model)
    throw unprocessable("This TypeSafe connection has no model", {
      code: "typesafe_model_missing",
    });
  const questionCount = Object.keys(input.questions).length;
  const questionTypes = [...new Set(Object.values(input.questions).map((question) => question.type))];
  const startedAt = new Date();

  const policy = toolAccessPolicyService(db);
  const policyRequest = {
    companyId: binding.companyId,
    actor: {
      actorType: "agent" as const,
      actorId: binding.agentId,
      agentId: binding.agentId,
    },
    runContext: {
      issueId: binding.issueId ?? undefined,
      heartbeatRunId: binding.runId ?? undefined,
    },
    request: {
      connectionId: connection.id,
      toolName: "typesafe.ask",
      providerType: "typesafe",
      riskLevel: "read" as const,
      // Shape only: the audit row must not hold the state or the questions.
      arguments: { model, questionCount },
      sideEffecting: false,
    },
    consumeRateLimit: true,
  };
  const decision = await policy.decide(policyRequest);
  await policy.writeAudit(policyRequest, decision);
  if (!decision.allowed) throw forbidden(decision.explanation);

  const ref = connection.credentialSecretRefs.find(
    (candidate) => candidate.configPath === API_KEY_PATH,
  );
  if (!ref)
    throw unprocessable("Reconnect TypeSafe to restore its API key", {
      code: "missing_secret",
    });
  const key = await secretService(db).resolveSecretValue(
    connection.companyId,
    ref.secretId,
    ref.versionSelector ?? "latest",
    {
      consumerType: "tool_connection",
      consumerId: connection.id,
      configPath: API_KEY_PATH,
      actorType: "agent",
      actorId: binding.agentId,
    },
  );

  let result: TypesafeAskResult;
  try {
    result = await typesafeApi(key, fetchImpl).evaluate({
      state: input.state,
      model,
      questions: input.questions,
    });
  } catch (error) {
    if (!(error instanceof TypesafeApiError)) throw error;
    throw new HttpError(error.httpStatus, error.message, {
      code: error.code,
      retryable: error.retryable,
    });
  }

  // Usage only: state, instructions and answers may hold private task content.
  await recordTypesafeAskAccounting(db, {
    companyId: binding.companyId,
    agentId: binding.agentId,
    runId: binding.runId ?? null,
    issueId: binding.issueId ?? null,
    connectionId: connection.id,
    purpose: input.purpose ?? null,
    model,
    questionTypes,
    usage: result.usage,
    startedAt,
  });
  await logActivity(db, {
    companyId: binding.companyId,
    actorType: "agent",
    actorId: binding.agentId,
    agentId: binding.agentId,
    runId: binding.runId ?? null,
    issueId: binding.issueId ?? null,
    action: "typesafe.ask",
    entityType: "tool_connection",
    entityId: connection.id,
    details: {
      // The requested name: resolved versions such as jev-1.13.0 trip the JWT-shape redactor.
      model,
      purpose: input.purpose ?? null,
      questionCount,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    },
  });
  return result;
}
