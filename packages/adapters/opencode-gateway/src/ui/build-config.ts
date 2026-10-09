import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Map the shared create-agent form values into `opencode_gateway` adapterConfig.
 *
 * When the adapter is promoted to built-in this runs in the NewAgent flow. As
 * an external plugin the UI renders `getConfigSchema()` instead, but this stays
 * for parity and tests.
 */
export function buildOpenCodeGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  const schemaValues = (v.adapterSchemaValues ?? {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(schemaValues)) {
    ac[key] = value;
  }

  if (v.url && ac.apiBaseUrl == null) ac.apiBaseUrl = v.url;
  if (v.model && ac.model == null) ac.model = v.model;
  if (v.timeoutSec != null && ac.timeoutSec == null) ac.timeoutSec = v.timeoutSec;
  if (v.sessionKeyStrategy && ac.sessionKeyStrategy == null) ac.sessionKeyStrategy = v.sessionKeyStrategy;
  if (v.paperclipApiUrl && ac.paperclipApiUrl == null) ac.paperclipApiUrl = v.paperclipApiUrl;

  const headers = parseJsonObject(v.headersJson ?? "");
  if (headers && ac.headers == null) ac.headers = headers;

  if (ac.timeoutSec == null) ac.timeoutSec = 600;
  if (ac.eventReconnectMs == null) ac.eventReconnectMs = 2000;
  if (ac.pollIntervalMs == null) ac.pollIntervalMs = 1000;
  if (ac.permissionMode == null) ac.permissionMode = "accept";
  if (ac.questionPolicy == null) ac.questionPolicy = "reject";
  if (!ac.sessionKeyStrategy) ac.sessionKeyStrategy = "issue";
  if (!ac.version) ac.version = "auto";
  if (!ac.username) ac.username = "opencode";

  return ac;
}
