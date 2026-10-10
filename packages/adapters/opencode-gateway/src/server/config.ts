import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type { OpenCodePermissionAction } from "./protocol.js";
import { normalizeApiVersionOverride, type OpenCodeApiVersion } from "./protocol.js";
import { normalizeSessionKeyStrategy, type SessionKeyStrategy } from "./session.js";
import {
  allowsInsecureRemoteHttp,
  isLoopbackHostname,
  isRemotePlainHttp,
} from "./transport-security.js";
import { DEFAULT_EVENT_RECONNECT_MS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_SERVER_USERNAME, DEFAULT_TIMEOUT_SEC } from "../shared/constants.js";

const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
]);

export interface GatewayConfig {
  raw: Record<string, unknown>;
  apiBaseUrl: string | null;
  baseUrl: URL | null;
  username: string;
  password: string | null;
  /** Operator explicitly opted into a server that runs without basic auth. */
  allowNoAuth: boolean;
  versionOverride: OpenCodeApiVersion | "auto";
  sessionKeyStrategy: SessionKeyStrategy;
  directory: string | null;
  model: string | null;
  providerID: string | null;
  modelID: string | null;
  agent: string | null;
  system: string | null;
  timeoutSec: number;
  eventReconnectMs: number;
  pollIntervalMs: number;
  permissionAction: OpenCodePermissionAction;
  questionPolicy: "reject" | "cancel";
  paperclipApiUrl: string | null;
  extraHeaders: Record<string, string>;
  allowsInsecureRemoteHttp: boolean;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const DEFAULT_OPENCODE_PORT = "4096";

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

/**
 * Accept a full URL, `host:port`, or a bare host/IP. A missing scheme defaults
 * to `http://`; a missing port defaults to OpenCode's server default (4096).
 */
export function normalizeBaseUrl(value: string): URL | null {
  const input = value.trim();
  if (!input) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.port) url.port = DEFAULT_OPENCODE_PORT;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function parseHeaders(value: unknown): Record<string, string> {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

function normalizePermissionAction(value: unknown): OpenCodePermissionAction {
  const raw = asString(value, "accept").trim().toLowerCase();
  if (raw === "accept_for_session" || raw === "decline" || raw === "cancel") return raw;
  return "accept";
}

function normalizeQuestionPolicy(value: unknown): "reject" | "cancel" {
  const raw = asString(value, "reject").trim().toLowerCase();
  return raw === "cancel" ? "cancel" : "reject";
}

/** Split a `provider/model` id into its OpenCode prompt components. */
export function resolveModelParts(input: {
  model: string | null;
  providerID: string | null;
  modelID: string | null;
}): { providerID: string | null; modelID: string | null } {
  if (input.providerID && input.modelID) {
    return { providerID: input.providerID, modelID: input.modelID };
  }
  const model = input.model;
  if (!model) return { providerID: input.providerID, modelID: input.modelID };
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    return { providerID: input.providerID, modelID: input.modelID };
  }
  return {
    providerID: input.providerID ?? model.slice(0, slashIndex),
    modelID: input.modelID ?? model.slice(slashIndex + 1),
  };
}

export function parseGatewayConfig(rawConfig: Record<string, unknown>): GatewayConfig {
  const config = parseObject(rawConfig);
  const apiBaseUrl = nonEmpty(config.apiBaseUrl) ?? nonEmpty(config.url);
  const directory = nonEmpty(config.directory) ?? nonEmpty(config.cwd);
  const timeoutSec = Math.max(0, asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC));
  return {
    raw: config,
    apiBaseUrl,
    baseUrl: apiBaseUrl ? normalizeBaseUrl(apiBaseUrl) : null,
    username: nonEmpty(config.username) ?? DEFAULT_SERVER_USERNAME,
    password: nonEmpty(config.password),
    allowNoAuth: parseBooleanLike(config.allowNoAuth ?? config.passwordless) === true,
    versionOverride: normalizeApiVersionOverride(config.version),
    sessionKeyStrategy: normalizeSessionKeyStrategy(config.sessionKeyStrategy),
    directory,
    model: nonEmpty(config.model),
    providerID: nonEmpty(config.providerID),
    modelID: nonEmpty(config.modelID),
    agent: nonEmpty(config.agent),
    system: nonEmpty(config.system),
    timeoutSec,
    eventReconnectMs: Math.floor(
      clamp(asNumber(config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000),
    ),
    pollIntervalMs: Math.floor(
      clamp(asNumber(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000),
    ),
    permissionAction: normalizePermissionAction(config.permissionMode ?? config.permissionAction),
    questionPolicy: normalizeQuestionPolicy(config.questionPolicy),
    paperclipApiUrl: nonEmpty(config.paperclipApiUrl),
    extraHeaders: parseHeaders(config.headers),
    allowsInsecureRemoteHttp: allowsInsecureRemoteHttp(config),
  };
}

export { isLoopbackHostname, isRemotePlainHttp };
