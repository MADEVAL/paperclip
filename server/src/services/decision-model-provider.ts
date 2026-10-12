import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { experimental_decide as decide, type Experimental_DecisionModel } from "ai";
import { centsToUnits, unitsToCents, type DecisionAnswer, type DecisionProvider, type DecisionRequest, type TypesafeAskResult } from "@paperclipai/shared";
import { TypesafeApiError, typesafeApi } from "./typesafe-api.js";

export interface DecisionProviderReceipt {
  inputTokens: number | null; outputTokens: number | null; providerRequestId: string | null;
  costCents: string | null; costStatus: "reported" | "estimated" | "unpriced";
  pricingProvenance: { source: "provider_reported" | "rate_card" | "unknown"; version?: string; evidence?: string; inputCentsPerMillion?: string };
}
export interface DecisionProviderOutcome { noProviderWork?: boolean; answers?: Record<string, DecisionAnswer>; errorCode?: string; receipt: DecisionProviderReceipt }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const tokenCount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : null;
function rejectedResponseData(error: unknown) {
  const value = record(error);
  if (value.data) return record(value.data);
  if (record(value.cause).value) return record(record(value.cause).value);
  // SDK schema rejection may retain only responseBody. Read a bounded body in
  // memory for accounting; never forward it to the ledger, logger, or caller.
  if (typeof value.responseBody === "string" && value.responseBody.length <= 1_000_000) {
    try { return record(JSON.parse(value.responseBody)); } catch { /* Not valid JSON. */ }
  }
  return {};
}
export function decisionReceipt(provider: DecisionProvider, result: unknown): DecisionProviderReceipt {
  const value = record(result), usage = record(value.usage), metadata = record(value.providerMetadata);
  const response = record(value.response);
  const headers = record(response.headers);
  const inputTokens = tokenCount(usage.inputTokens), outputTokens = tokenCount(usage.outputTokens);
  const reported = record(record(metadata.openrouter).usage).cost;
  const base = { inputTokens, outputTokens, providerRequestId: typeof response.id === "string" ? response.id.slice(0, 250) : typeof headers["x-request-id"] === "string" ? headers["x-request-id"].slice(0, 250) : null };
  if (provider === "openrouter" && typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return { ...base, costCents: unitsToCents(centsToUnits(reported * 100)), costStatus: "reported", pricingProvenance: { source: "provider_reported" } };
  }
  // V1 uses the official default endpoint and bounded short text requests. Decisions has its own rate, not the chat model's rate.
  if (provider === "openai" && inputTokens !== null && inputTokens <= 32_000) {
    return { ...base, costCents: unitsToCents(centsToUnits("10") * BigInt(inputTokens) / 1_000_000n), costStatus: "estimated",
      pricingProvenance: { source: "rate_card", version: "openai-decisions-2026-10-07", inputCentsPerMillion: "10.0000000" } };
  }
  // TypeSafe bills per input token only: $42 per billion = 4.2 cents per million.
  if (provider === "typesafe" && inputTokens !== null) {
    return { ...base, costCents: unitsToCents(centsToUnits("4.2") * BigInt(inputTokens) / 1_000_000n), costStatus: "estimated",
      pricingProvenance: { source: "rate_card", version: "typesafe-jev-2026-10-12", inputCentsPerMillion: "4.2000000" } };
  }
  return { ...base, costCents: null, costStatus: "unpriced", pricingProvenance: { source: "unknown" } };
}

/** Decision questions are Paperclip-shaped; TypeSafe calls its yes/no type `noul`. */
function typesafeQuestions(request: DecisionRequest): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "boolean") questions[id] = { type: "noul", instructions: question.instructions };
    else if (question.type === "choice") questions[id] = { type: "choice", instructions: question.instructions, criteria: question.criteria };
    else questions[id] = { type: "score", instructions: question.instructions, criteria: question.criteria };
  }
  return questions;
}

function typesafeAnswers(answers: TypesafeAskResult["answers"]): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") {
      out[id] = { type: "boolean", probability: answer.noul };
    } else if (answer.type === "choice") {
      out[id] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
    } else {
      out[id] = { type: "score", score: answer.score, probabilities: answer.probabilities, confidence: answer.confidence };
    }
  }
  return out;
}

async function runTypesafeDecision(
  input: { model: string; apiKey: string; request: DecisionRequest; signal: AbortSignal },
  options: { fetch?: typeof fetch },
): Promise<DecisionProviderOutcome> {
  try {
    const result = await typesafeApi(input.apiKey, options.fetch).evaluate({
      state: input.request.state,
      model: input.model,
      questions: typesafeQuestions(input.request),
    });
    return {
      answers: typesafeAnswers(result.answers),
      receipt: decisionReceipt("typesafe", { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } }),
    };
  } catch (error) {
    // Provider bodies can echo the submitted state; never forward them.
    const apiError = error instanceof TypesafeApiError ? error : null;
    const status = apiError?.status ?? null;
    const errorCode = input.signal.aborted ? "timeout"
      : apiError?.code === "typesafe_rate_limited" ? "provider_rate_limited"
      : apiError?.code === "typesafe_api_key_rejected" ? "provider_auth_failed"
      : apiError?.code === "typesafe_invalid_request" ? "provider_failed"
      : "provider_failed";
    const noProviderWork = status !== null && [400, 401, 403, 404, 422, 429].includes(status);
    const receipt = noProviderWork
      ? { ...decisionReceipt("typesafe", null), inputTokens: 0, outputTokens: 0, costCents: "0.0000000", costStatus: "estimated" as const,
          pricingProvenance: { source: "unknown" as const, evidence: `Provider rejected request before model work (HTTP ${status})` } }
      : decisionReceipt("typesafe", null);
    return { errorCode, receipt, noProviderWork };
  }
}

export async function runDecisionProvider(input: {
  provider: DecisionProvider; model: string; apiKey: string; request: DecisionRequest; signal: AbortSignal;
}, options: { fetch?: typeof fetch } = {}): Promise<DecisionProviderOutcome> {
  if (input.provider === "typesafe") return runTypesafeDecision(input, options);
  const native = input.provider === "openai"
    ? createOpenAI({ apiKey: input.apiKey, fetch: options.fetch }).decisionModel(input.model)
    : createOpenRouter({ apiKey: input.apiKey, fetch: options.fetch }).evaluationModel(input.model);
  let receipt = decisionReceipt(input.provider, null);
  // Capture only accounting metadata before SDK answer validation/refusal errors.
  const model: Exclude<Experimental_DecisionModel, string> = {
    specificationVersion: "v4", provider: native.provider, modelId: native.modelId, supportedQuestionTypes: native.supportedQuestionTypes,
    async doDecide(args) {
      const response = await ("doDecide" in native ? native.doDecide(args) : native.doEvaluate(args));
      receipt = decisionReceipt(input.provider, response);
      return { ...response, warnings: [] };
    },
  };
  try {
    const result = await decide({ model, ...input.request, maxRetries: 0, abortSignal: input.signal,
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false } });
    const metadata = record(result.providerMetadata);
    const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
      const confidence = input.provider === "openai" ? record(record(metadata.openai).confidence)[id]
        : record(record(record(metadata.openrouter).answers)[id]).confidence;
      return [id, { ...answer, ...(typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? { confidence } : {}) }];
    }));
    return { answers, receipt };
  } catch (error) {
    // Never expose provider error messages/bodies; they may contain inputs or credentials.
    const name = error instanceof Error ? error.name : "";
    const status = record(error).statusCode;
    // SDKs can reject refusals or malformed answers before normalized usage.
    // Keep only validated accounting fields, even in this failure path.
    const data = rejectedResponseData(error);
    const rawUsage = record(data.usage);
    if (receipt.costStatus === "unpriced") {
      receipt = decisionReceipt(input.provider, { usage: { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens },
        providerMetadata: { openrouter: { usage: { cost: rawUsage.cost } } },
        response: { id: data.id, headers: record(error).responseHeaders } });
    }
    const rawAnswers = Array.isArray(data.answers) ? data.answers : Object.values(record(data.answers));
    const refused = name.includes("Refusal") || record(data.error).type === "refusal" || rawAnswers.some(answer => record(answer).type === "refusal");
    const errorCode = input.signal.aborted ? "timeout" : refused ? "refused"
      : status === 401 || status === 403 ? "provider_auth_failed" : status === 429 ? "provider_rate_limited" : "provider_failed";
    // An explicit authentication/validation rejection occurs before model work.
    // Server errors and network failures remain unresolved: their charge is unknown.
    const noProviderWork = receipt.costStatus === "unpriced" && [400, 401, 403, 404, 422, 429].includes(Number(status));
    if (noProviderWork) receipt = { ...receipt, inputTokens: 0, outputTokens: 0, costCents: "0.0000000", costStatus: "estimated",
      pricingProvenance: { source: "unknown", evidence: `Provider rejected request before model work (HTTP ${status})` } };
    return { errorCode, receipt, noProviderWork };
  }
}
