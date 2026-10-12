import { ALLOW_UNQUALIFIED_VERSION_ENV } from "../shared/constants.js";

/**
 * OpenCode ships two incompatible server HTTP APIs:
 *
 * - V1 (`opencode-ai` 1.x) serves `/global/health`, `/session`,
 *   `/session/:id/prompt_async`, `/event`, `/permission`, `/question`.
 * - V2 (2.x) serves `/api/info`, `/api/session`, `/api/session/{id}/prompt`,
 *   `/api/event`, `/api/session/{id}/permission/{requestID}/reply`, and the
 *   forms API in place of questions.
 *
 * This client is a port of the Paperclip Runner's `drivers/opencode/api-client.ts`
 * so the adapter package never imports `@paperclipai/paperclip-runner` (adapter
 * packages must not depend on the Runner). The request shapes and version
 * windows below are intentionally identical to that source of truth.
 */

export type OpenCodeApiVersion = "v1" | "v2";
export type OpenCodeProtocolVersion = "http+sse/v1" | "http+sse/v2";
export type OpenCodePermissionAction =
  | "accept"
  | "accept_for_session"
  | "decline"
  | "cancel";

/** The one V1 release Paperclip qualified end-to-end. */
export const QUALIFIED_OPENCODE_V1_VERSION = "1.18.34" as const;
/** The one V2 release Paperclip qualified live against `opencode serve`. */
export const QUALIFIED_OPENCODE_V2_VERSION = "2.0.26" as const;

const VERSION_WINDOWS = [
  { minimum: [1, 18, 34], maximum: [2, 0, 0], label: "1.18.34 <= v < 2.0.0" },
  { minimum: [2, 0, 0], maximum: [2, 1, 0], label: "2.0.0 <= v < 2.1.0" },
] as const;

export function compareOpenCodeVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function isSemanticVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/** Protocol family for an exact semantic version, or null when unrecognized. */
export function openCodeApiVersionForVersion(
  version: string,
): OpenCodeApiVersion | null {
  const major = Number(version.split(".")[0]);
  if (!Number.isSafeInteger(major)) return null;
  if (major === 1) return "v1";
  if (major === 2) return "v2";
  return null;
}

export function isQualifiedOpenCodeVersion(version: string): boolean {
  return VERSION_WINDOWS.some(
    (window) =>
      compareOpenCodeVersions(version, `${window.minimum.join(".")}`) >= 0 &&
      compareOpenCodeVersions(version, `${window.maximum.join(".")}`) < 0,
  );
}

export function qualifiedOpenCodeWindows(): string {
  return VERSION_WINDOWS.map((window) => window.label).join(" or ");
}

export function unqualifiedOpenCodeVersionMessage(version: string): string {
  return (
    `OpenCode ${version} is not a qualified server release. ` +
    `Paperclip supports ${qualifiedOpenCodeWindows()} ` +
    `(qualified: ${QUALIFIED_OPENCODE_V1_VERSION}, ${QUALIFIED_OPENCODE_V2_VERSION}). ` +
    `Set ${ALLOW_UNQUALIFIED_VERSION_ENV}=1 to bypass this guard for an unverified run, ` +
    `or pin adapterConfig.version to v1 or v2 when you accept the protocol risk.`
  );
}

export function allowsUnqualifiedOpenCodeGatewayVersion(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = environment[ALLOW_UNQUALIFIED_VERSION_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Classify a server-info payload once the transport has resolved it. */
export function classifyOpenCodeServerInfo(input: {
  version: unknown;
  apiVersion: OpenCodeApiVersion;
}): { version: string; apiVersion: OpenCodeApiVersion } | null {
  if (typeof input.version !== "string" || !isSemanticVersion(input.version))
    return null;
  const detected = openCodeApiVersionForVersion(input.version);
  if (detected === null) return null;
  return { version: input.version, apiVersion: detected };
}

export function normalizeApiVersionOverride(value: unknown): OpenCodeApiVersion | "auto" {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "v1" || normalized === "1") return "v1";
  if (normalized === "v2" || normalized === "2") return "v2";
  return "auto";
}
