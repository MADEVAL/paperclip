import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asNumber } from "@paperclipai/adapter-utils/server-utils";

export type SseFrame = { event: string | null; data: string };

/**
 * Incremental SSE frame parser. Tolerates CRLF, comment lines, and multi-line
 * `data:` fields. Returns the trailing incomplete frame in `rest`.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest: normalized.slice(offset) };
}

export function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function eventTypeOf(raw: unknown): string | null {
  const record = asRecord(raw);
  return nonEmpty(record?.type) ?? nonEmpty(record?.event);
}

export function eventProperties(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  return asRecord(record?.properties) ?? asRecord(record?.data) ?? {};
}

/** True when the event terminates the turn cleanly. */
export function isIdleEvent(raw: unknown): boolean {
  const type = eventTypeOf(raw)?.toLowerCase() ?? "";
  return type === "session.idle" || type === "session.status.idle";
}

/** Error message when the event terminates the turn with an error. */
export function extractErrorEvent(raw: unknown): string | null {
  const type = eventTypeOf(raw)?.toLowerCase() ?? "";
  if (type !== "session.error" && type !== "session.execution.failed") return null;
  const properties = eventProperties(raw);
  const error = asRecord(properties.error);
  return (
    nonEmpty(error?.message) ??
    nonEmpty(properties.message) ??
    nonEmpty(properties.error) ??
    "OpenCode session failed"
  );
}

export interface AssistantTextDelta {
  partId: string;
  channel: "text" | "reasoning";
  delta: string;
}

/**
 * Extract an assistant text/reasoning delta from a `message.part.updated`
 * event. OpenCode sends cumulative part text, so the caller passes the last
 * seen text per part id and receives only the new suffix.
 */
export function extractAssistantTextDelta(
  raw: unknown,
  previousByPartId: Map<string, string>,
): AssistantTextDelta | null {
  if (eventTypeOf(raw)?.toLowerCase() !== "message.part.updated") return null;
  const part = asRecord(eventProperties(raw).part);
  if (!part) return null;
  const partType = (nonEmpty(part.type) ?? "").toLowerCase();
  if (partType !== "text" && partType !== "reasoning") return null;
  const partId = nonEmpty(part.id) ?? `${nonEmpty(part.messageID) ?? "message"}:${partType}`;
  const full = typeof part.text === "string" ? part.text : "";
  const previous = previousByPartId.get(partId) ?? "";
  const delta =
    typeof part.delta === "string" && part.delta.length > 0
      ? previousByPartId.has(partId) && full.startsWith(previous) && full !== previous
        ? full.slice(previous.length)
        : part.delta
      : full.startsWith(previous)
        ? full.slice(previous.length)
        : full;
  previousByPartId.set(partId, full);
  if (!delta) return null;
  return {
    partId,
    channel: partType === "reasoning" ? "reasoning" : "text",
    delta,
  };
}

export interface ToolPartSnapshot {
  callId: string;
  name: string;
  status: string | null;
  input: unknown;
  output: string | null;
  error: string | null;
}

export function extractToolPart(raw: unknown): ToolPartSnapshot | null {
  if (eventTypeOf(raw)?.toLowerCase() !== "message.part.updated") return null;
  const part = asRecord(eventProperties(raw).part);
  if (!part || (nonEmpty(part.type) ?? "").toLowerCase() !== "tool") return null;
  const state = asRecord(part.state) ?? {};
  const callId = nonEmpty(part.callID) ?? nonEmpty(part.id) ?? "tool";
  const output =
    typeof state.output === "string"
      ? state.output
      : state.output === undefined || state.output === null
        ? null
        : JSON.stringify(state.output);
  return {
    callId,
    name: nonEmpty(part.tool) ?? nonEmpty(part.name) ?? "tool",
    status: nonEmpty(state.status)?.toLowerCase() ?? null,
    input: state.input ?? undefined,
    output,
    error: nonEmpty(state.error),
  };
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  title: string | null;
}

export function extractPermissionRequest(raw: unknown): PermissionRequest | null {
  if (eventTypeOf(raw)?.toLowerCase() !== "permission.updated") return null;
  const properties = eventProperties(raw);
  const requestId = nonEmpty(properties.id) ?? nonEmpty(properties.requestID);
  if (!requestId) return null;
  return {
    requestId,
    sessionId: nonEmpty(properties.sessionID) ?? nonEmpty(properties.sessionId) ?? "",
    title: nonEmpty(properties.title),
  };
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  title: string | null;
  questions: Record<string, unknown>[];
}

export function extractQuestionRequest(raw: unknown): QuestionRequest | null {
  if (eventTypeOf(raw)?.toLowerCase() !== "question.asked") return null;
  const properties = eventProperties(raw);
  const requestId = nonEmpty(properties.id) ?? nonEmpty(properties.requestID);
  if (!requestId) return null;
  const questions = Array.isArray(properties.questions)
    ? properties.questions
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  return {
    requestId,
    sessionId: nonEmpty(properties.sessionID) ?? nonEmpty(properties.sessionId) ?? "",
    title: nonEmpty(properties.title),
    questions,
  };
}

export interface EventUsage {
  usage?: UsageSummary;
  costUsd?: number | null;
  model?: string | null;
  provider?: string | null;
}

/** Extract usage/cost from `message.updated` (and legacy `session.step.ended`). */
export function extractEventUsage(raw: unknown): EventUsage | null {
  const type = eventTypeOf(raw)?.toLowerCase();
  if (type !== "message.updated" && type !== "session.step.ended") return null;
  const properties = eventProperties(raw);
  const info = asRecord(properties.info) ?? properties;
  const tokens = asRecord(info.tokens) ?? asRecord(properties.tokens);
  const cache = asRecord(tokens?.cache);
  const inputTokens = asNumber(tokens?.input ?? tokens?.inputTokens, 0);
  const outputTokens = asNumber(tokens?.output ?? tokens?.outputTokens, 0);
  const cachedInputTokens = asNumber(
    cache?.read ?? tokens?.cacheRead ?? tokens?.cachedInputTokens,
    0,
  );
  const cacheWriteTokens = asNumber(cache?.write ?? tokens?.cacheWrite, 0);
  const costRaw = info.cost ?? properties.cost;
  const costUsd =
    typeof costRaw === "number"
      ? costRaw
      : typeof costRaw === "string"
        ? Number.parseFloat(costRaw)
        : null;
  const usage: UsageSummary | undefined =
    inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0 || cacheWriteTokens > 0
      ? {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
          ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
        }
      : undefined;
  const model = nonEmpty(info.modelID) ?? nonEmpty(info.model);
  const provider = nonEmpty(info.providerID) ?? nonEmpty(info.provider);
  if (!usage && (costUsd === null || !Number.isFinite(costUsd)) && !model) return null;
  return {
    ...(usage ? { usage } : {}),
    costUsd: costUsd !== null && Number.isFinite(costUsd) ? costUsd : null,
    model,
    provider,
  };
}
