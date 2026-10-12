import type { OpenCodeTransport } from "./api-client.js";
import type { OpenCodeApiVersion } from "./protocol.js";
import { classifyOpenCodeServerInfo } from "./protocol.js";

export type OpenCodeFetch = typeof fetch;

export interface OpenCodeHttpError extends Error {
  status?: number;
  code?: string;
  body?: unknown;
}

export interface OpenCodeConnection {
  baseUrl: URL;
  /** `Basic base64(user:password)`, or null when the server runs without auth. */
  authHeader: string | null;
  extraHeaders: Record<string, string>;
  fetchImpl: OpenCodeFetch;
}

export function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export interface OpenCodeServerInfo {
  version: string | null;
  apiVersion: OpenCodeApiVersion;
  raw: unknown;
  /** True when one of the version probes (`/global/health` or `/api/info`) answered. */
  reachable: boolean;
}

export function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;
  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function buildHeaders(
  connection: OpenCodeConnection,
  init: RequestInit | undefined,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...connection.extraHeaders,
    Accept: accept,
    ...(connection.authHeader ? { Authorization: connection.authHeader } : {}),
  };
  const initHeaders = init?.headers;
  if (initHeaders) {
    const entries = initHeaders instanceof Headers
      ? [...initHeaders.entries()]
      : Array.isArray(initHeaders)
        ? initHeaders
        : Object.entries(initHeaders);
    for (const [key, value] of entries) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  if (init?.body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/** Execute one JSON request; throws a classified `OpenCodeHttpError` on failure. */
export async function requestJson(
  connection: OpenCodeConnection,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await connection.fetchImpl(apiUrl(connection.baseUrl, path), {
      ...init,
      headers: buildHeaders(connection, init, "application/json"),
    });
  } catch (err) {
    const failure = new Error(
      `OpenCode gateway request failed: ${fetchFailureMessage(err)}`,
    ) as OpenCodeHttpError;
    failure.code = "opencode_gateway_connect_failed";
    (failure as { cause?: unknown }).cause = err instanceof Error ? err.cause : undefined;
    throw failure;
  }
  const body = await readResponseBody(response);
  if (!response.ok) {
    const failure = new Error(`OpenCode gateway HTTP ${response.status}`) as OpenCodeHttpError;
    failure.status = response.status;
    failure.body = body;
    if (response.status === 401 || response.status === 403) {
      failure.code = "opencode_gateway_auth_failed";
    } else if (response.status === 404) {
      failure.code = "opencode_gateway_endpoint_not_found";
    } else if (response.status >= 500) {
      failure.code = "opencode_gateway_upstream_error";
    } else {
      failure.code = "opencode_gateway_protocol_error";
    }
    throw failure;
  }
  return body;
}

export function createTransport(connection: OpenCodeConnection): OpenCodeTransport {
  return {
    request: (path, init) => requestJson(connection, path, init),
  };
}

async function tryGetVersion(
  connection: OpenCodeConnection,
  path: string,
): Promise<{ ok: boolean; version: string | null; raw: unknown }> {
  try {
    const raw = await requestJson(connection, path);
    const record = asRecord(raw);
    const version = nonEmpty(record?.version);
    return { ok: true, version, raw };
  } catch {
    return { ok: false, version: null, raw: null };
  }
}

function serverInfoFromProbe(
  probe: { version: string | null; raw: unknown },
  apiVersion: OpenCodeApiVersion,
): OpenCodeServerInfo {
  const classified = classifyOpenCodeServerInfo({ version: probe.version, apiVersion });
  return {
    version: classified?.version ?? probe.version,
    apiVersion: classified?.apiVersion ?? apiVersion,
    raw: probe.raw,
    reachable: true,
  };
}

/**
 * Determine the server API family. V1 exposes `/global/health`; V2 exposes
 * `/api/info`.
 *
 * Auto-detection probes both endpoints and prefers whichever reports a
 * semantic version. A V2 server may answer `/global/health` with its HTML web
 * shell (HTTP 200, no version); probing V1 first and accepting that shell would
 * misclassify the server as a versionless V1. `versionOverride` of `v1` or `v2`
 * probes only that endpoint, so an operator can force the family deliberately.
 */
export async function detectOpenCodeServerInfo(
  connection: OpenCodeConnection,
  versionOverride: OpenCodeApiVersion | "auto" = "auto",
): Promise<OpenCodeServerInfo> {
  if (versionOverride === "v1") {
    const health = await tryGetVersion(connection, "/global/health");
    return health.ok
      ? serverInfoFromProbe(health, "v1")
      : { version: null, apiVersion: "v1", raw: null, reachable: false };
  }
  if (versionOverride === "v2") {
    const info = await tryGetVersion(connection, "/api/info");
    return info.ok
      ? serverInfoFromProbe(info, "v2")
      : { version: null, apiVersion: "v2", raw: null, reachable: false };
  }

  const health = await tryGetVersion(connection, "/global/health");
  const info = await tryGetVersion(connection, "/api/info");

  // Prefer the versioned probe. Fall back to any reachable probe so a server
  // that hides its version still reports as reachable.
  if (info.ok && info.version) return serverInfoFromProbe(info, "v2");
  if (health.ok && health.version) return serverInfoFromProbe(health, "v1");
  if (info.ok) return serverInfoFromProbe(info, "v2");
  if (health.ok) return serverInfoFromProbe(health, "v1");
  return { version: null, apiVersion: "v1", raw: null, reachable: false };
}
