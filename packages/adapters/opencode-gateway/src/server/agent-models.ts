import type { AdapterModel } from "@paperclipai/adapter-utils";
import { normalizeBaseUrl } from "./config.js";
import { isRetiredOpenCodeModelId } from "./free-models.js";
import { buildBasicAuthHeader } from "./transport.js";

/** Normalized subset of OpenCode's `GET /api/model` response we rely on. */
interface AgentModelInfo {
  id?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  status?: unknown;
  enabled?: unknown;
  cost?: unknown;
}

export interface AgentModelListResult {
  models: AdapterModel[];
  /** `agent` when the models came from the agent's own OpenCode server. */
  source: "agent";
}

/** Parse a v2 `GET /api/model` snapshot into picker models. */
export function parseOpenCodeAgentModels(payload: unknown): AdapterModel[] {
  const entries: AgentModelInfo[] = Array.isArray((payload as { data?: unknown })?.data)
    ? ((payload as { data: AgentModelInfo[] }).data)
    : [];
  const seen = new Set<string>();
  const models: AdapterModel[] = [];
  for (const entry of entries) {
    const providerID = text(entry.providerID);
    const modelID = text(entry.modelID) ?? text(entry.id);
    if (!providerID || !modelID) continue;
    if (entry.enabled === false) continue;
    const status = text(entry.status);
    if (failureStatus(status)) continue;
    if (isRetiredOpenCodeModelId(modelID)) continue;
    const id = `${providerID}/${modelID}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const free = freeFromCost(entry.cost);
    models.push({ id, label: `${providerID} · ${modelID}${free ? " (free)" : ""}` });
  }
  return models;
}

export interface AgentModelRequestInput {
  /** Resolved (secret-free) adapter config for one gateway agent. */
  config: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requestBase(config: Record<string, unknown>): { origin: string; username: string; password: string | null } {
  const raw = text(config.apiBaseUrl);
  const base = raw ? normalizeBaseUrl(raw) : null;
  if (!base) throw new Error("OpenCode gateway requires a valid apiBaseUrl");
  return {
    origin: base.origin,
    username: text(config.username) ?? "opencode",
    password: text(config.password),
  };
}

function failureStatus(status: string | null): boolean {
  return status !== null && ["deprecated", "disabled", "removed", "inactive", "unavailable"].includes(status.toLowerCase());
}

function freeFromCost(cost: unknown): boolean {
  const entry = Array.isArray(cost) ? cost[0] : cost;
  if (!entry || typeof entry !== "object") return false;
  const input = (entry as { input?: unknown }).input;
  const output = (entry as { output?: unknown }).output;
  return input === 0 && output === 0;
}

/**
 * Ask one gateway agent's own OpenCode server which models it can actually use
 * (`GET /api/model`, v2 API). The snapshot carries `status`, `enabled`, cost and
 * variants, so the picker reflects that agent's catalog instead of a public one.
 */
export async function listOpenCodeGatewayAgentModels(input: AgentModelRequestInput): Promise<AgentModelListResult> {
  const { origin, username, password } = requestBase(input.config);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${origin}/api/model`, {
    headers: {
      accept: "application/json",
      ...(password ? { authorization: buildBasicAuthHeader(username, password) } : {}),
    },
    signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
  });
  if (!response.ok) {
    throw new Error(`OpenCode server ${origin}/api/model returned HTTP ${response.status}`);
  }
  return { models: parseOpenCodeAgentModels(await response.json()), source: "agent" };

}

export interface OpenCodeModelProbeResult {
  ok: boolean;
  code: string | null;
  message: string;
  latencyMs: number;
  sessionId: string | null;
}

export function readOpenCodeAssistantReply(messages: unknown): { text: string | null; error: string | null } {
  if (!Array.isArray(messages)) return { text: null, error: null };
  let answer: string | null = null;
  let failure: string | null = null;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const info = (message.info && typeof message.info === "object" ? message.info : message) as Record<string, unknown>;
    // v2 lists flattened messages (`{ type: "assistant", text }`); the nested
    // `info.role` shape is kept for servers that still emit it.
    const role = text(message.type) ?? text(info.role) ?? text(message.role) ?? text(info.type);
    if (role !== "assistant") {
      if (role === "error") failure = text(message.text) ?? JSON.stringify(message).slice(0, 400);
      if (role === "idle") {
        const outcome = text(message.outcome);
        if (outcome && outcome !== "succeeded") {
          const idleError = message.error;
          failure = typeof idleError === "string"
            ? idleError
            : idleError && typeof idleError === "object"
              ? (text((idleError as Record<string, unknown>).message) ?? JSON.stringify(idleError).slice(0, 400))
              : `provider idle: ${outcome}`;
        }
      }
      continue;
    }
    const infoError = info.error ?? message.error;
    if (infoError) {
      failure = typeof infoError === "string" ? infoError : JSON.stringify(infoError).slice(0, 400);
    }
    const direct = text(message.text) ?? text(info.text);
    if (direct) answer = direct;
    const parts = [
      ...(Array.isArray(message.content) ? message.content : []),
      ...(Array.isArray(message.parts) ? message.parts : []),
      ...(Array.isArray(info.parts) ? info.parts : []),
    ];
    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (text(part.type) === "text") {
        const value = text(part.text);
        if (value) answer = value;
      }
    }
  }
  return { text: answer, error: failure };
}

/**
 * Real existence check: open a throwaway session on the agent's own server,
 * request one token of output, and report what the provider actually answered.
 * Catalogs can lag a retired model; only a live turn proves it.
 */
export async function probeOpenCodeGatewayModel(input: AgentModelRequestInput & {
  model: string;
  prompt?: string;
  pollIntervalMs?: number;
}): Promise<OpenCodeModelProbeResult> {
  const startedAt = Date.now();
  const { origin, username, password } = requestBase(input.config);
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(password ? { authorization: buildBasicAuthHeader(username, password) } : {}),
  };
  const slash = input.model.indexOf("/");
  if (slash <= 0 || slash === input.model.length - 1) {
    return { ok: false, code: "invalid_model", message: "Model must be provider/model", latencyMs: 0, sessionId: null };
  }
  const providerID = input.model.slice(0, slash);
  const modelID = input.model.slice(slash + 1);

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetchImpl(`${origin}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null);
    return { response, body };
  };

  let sessionId: string | null = null;
  try {
    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: `Paperclip model check ${new Date().toISOString()}`, model: { providerID, id: modelID } }),
    });
    if (!created.response.ok) {
      return {
        ok: false,
        code: `session_http_${created.response.status}`,
        message: `OpenCode refused the session (HTTP ${created.response.status}): ${JSON.stringify(created.body).slice(0, 300)}`,
        latencyMs: Date.now() - startedAt,
        sessionId: null,
      };
    }
    sessionId = text((created.body as { data?: { id?: unknown } })?.data?.id);
    if (!sessionId) {
      return { ok: false, code: "session_missing_id", message: "OpenCode created no session id", latencyMs: Date.now() - startedAt, sessionId: null };
    }

    const prompted = await request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: input.prompt ?? "Reply with the single word: ok" }),
    });
    if (!prompted.response.ok) {
      return {
        ok: false,
        code: `prompt_http_${prompted.response.status}`,
        message: `Provider rejected the prompt (HTTP ${prompted.response.status}): ${JSON.stringify(prompted.body).slice(0, 300)}`,
        latencyMs: Date.now() - startedAt,
        sessionId,
      };
    }

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const listed = await request(`/api/session/${encodeURIComponent(sessionId)}/message`);
      if (listed.response.ok) {
        const { text: answer, error } = readOpenCodeAssistantReply((listed.body as { data?: unknown })?.data);
        if (error) return { ok: false, code: "provider_error", message: error, latencyMs: Date.now() - startedAt, sessionId };
        if (answer !== null) return { ok: true, code: null, message: answer.slice(0, 300), latencyMs: Date.now() - startedAt, sessionId };
      }
      await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 500));
    }
    return { ok: false, code: "timeout", message: "No assistant answer within 25s", latencyMs: Date.now() - startedAt, sessionId };
  } catch (error) {
    return {
      ok: false,
      code: "probe_failed",
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      latencyMs: Date.now() - startedAt,
      sessionId,
    };
  } finally {
    if (sessionId) {
      await fetchImpl(`${origin}/api/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }
  }
}
