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
  /** `Basic base64(user:password)` or any configured Authorization override. */
  authHeader: string;
  extraHeaders: Record<string, string>;
  fetchImpl: OpenCodeFetch;
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
    Authorization: connection.authHeader,
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

/**
 * Determine the server API family. V1 exposes `/global/health`; V2 exposes
 * `/api/info`. We probe V1 first (the historical shape) and fall back to V2.
 */
export async function detectOpenCodeServerInfo(
  connection: OpenCodeConnection,
): Promise<OpenCodeServerInfo> {
  const health = await tryGetVersion(connection, "/global/health");
  if (health.ok) {
    const classified = classifyOpenCodeServerInfo({ version: health.version, apiVersion: "v1" });
    return {
      version: classified?.version ?? health.version,
      apiVersion: classified?.apiVersion ?? "v1",
      raw: health.raw,
      reachable: true,
    };
  }
  const info = await tryGetVersion(connection, "/api/info");
  if (info.ok) {
    const classified = classifyOpenCodeServerInfo({ version: info.version, apiVersion: "v2" });
    return {
      version: classified?.version ?? info.version,
      apiVersion: classified?.apiVersion ?? "v2",
      raw: info.raw,
      reachable: true,
    };
  }
  return { version: null, apiVersion: "v1", raw: null, reachable: false };
}
