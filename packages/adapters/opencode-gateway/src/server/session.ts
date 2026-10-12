import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

export type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

export function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface OpenCodeGatewaySessionState {
  opencodeSessionId: string;
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  directory: string | null;
  apiVersion: "v1" | "v2" | null;
  version: string | null;
}

function readStrategy(value: unknown): SessionKeyStrategy | null {
  const raw = readString(value)?.toLowerCase();
  if (raw === "issue" || raw === "agent" || raw === "run" || raw === "none") return raw;
  return null;
}

function readApiVersion(value: unknown): "v1" | "v2" | null {
  const raw = readString(value)?.toLowerCase();
  if (raw === "v1" || raw === "v2") return raw;
  return null;
}

/**
 * Serializes the OpenCode session identity for continuity across heartbeats.
 *
 * OpenCode has no external session-key parameter: the adapter owns the mapping
 * between a Paperclip work-key (`sessionKey`) and the OpenCode session id it
 * created. We persist both so a later run can resume the right conversation and
 * decide whether a stored session still matches the resolved work-key.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const opencodeSessionId =
      readString(record.opencodeSessionId) ??
      readString(record.sessionId) ??
      readString(record.session_id);
    if (!opencodeSessionId) return null;
    const strategy = readStrategy(record.strategy) ?? "issue";
    const apiVersion = readApiVersion(record.apiVersion);
    return {
      opencodeSessionId,
      sessionKey: readString(record.sessionKey),
      strategy,
      directory: readString(record.directory),
      ...(apiVersion ? { apiVersion } : {}),
      version: readString(record.version),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const opencodeSessionId =
      readString(params.opencodeSessionId) ??
      readString(params.sessionId) ??
      readString(params.session_id);
    if (!opencodeSessionId) return null;
    const strategy = readStrategy(params.strategy) ?? "issue";
    const apiVersion = readApiVersion(params.apiVersion);
    return {
      opencodeSessionId,
      sessionKey: readString(params.sessionKey),
      strategy,
      directory: readString(params.directory),
      ...(apiVersion ? { apiVersion } : {}),
      version: readString(params.version),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readString(params.opencodeSessionId) ??
      readString(params.sessionId) ??
      readString(params.session_id)
    );
  },
};

/**
 * Decide whether a stored session may be resumed for this run.
 *
 * A stored session is reused only when its strategy is stable (issue/agent),
 * the resolved work-key still matches, and the OpenCode version family is
 * unchanged. Run-scoped and `none` strategies always create a fresh session.
 */
export function shouldResumeStoredSession(input: {
  stored: OpenCodeGatewaySessionState | null;
  strategy: SessionKeyStrategy;
  sessionKey: string | null;
  apiVersion: "v1" | "v2" | "auto";
}): boolean {
  const stored = input.stored;
  if (!stored) return false;
  if (input.strategy === "run" || input.strategy === "none") return false;
  if (!input.sessionKey) return false;
  if (stored.strategy !== input.strategy) return false;
  if (stored.sessionKey !== input.sessionKey) return false;
  if (input.apiVersion !== "auto" && stored.apiVersion && stored.apiVersion !== input.apiVersion) {
    return false;
  }
  return true;
}
