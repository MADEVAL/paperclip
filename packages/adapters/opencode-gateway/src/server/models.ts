import type { AdapterModel } from "@paperclipai/adapter-utils";
import { detectOpenCodeServerInfo, requestJson, type OpenCodeConnection } from "./transport.js";
import { parseGatewayConfig } from "./config.js";
import type { OpenCodeApiVersion } from "./protocol.js";

/**
 * Best-effort model discovery from the OpenCode server.
 *
 * OpenCode does not guarantee a stable model-catalog endpoint across the V1/V2
 * line, and the gateway may route models Paperclip can never enumerate. We
 * therefore probe a few known shapes and return an empty list on any failure:
 * the gateway owns the model, and the operator sets `model` explicitly.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pushModel(seen: Set<string>, out: AdapterModel[], providerID: string, modelID: string): void {
  const id = `${providerID}/${modelID}`;
  if (!providerID || !modelID || seen.has(id)) return;
  seen.add(id);
  out.push({ id, label: id });
}

/** Parse several plausible provider/model catalog shapes defensively. */
export function parseProviderModelCatalog(raw: unknown): AdapterModel[] {
  const root = asRecord(raw);
  if (!root) return [];
  const source = asRecord(root.data) ?? root;
  const providersRaw = Array.isArray(source.providers)
    ? source.providers
    : Array.isArray(source.all)
      ? source.all
      : Array.isArray(source)
        ? (source as unknown[])
        : [];
  const seen = new Set<string>();
  const out: AdapterModel[] = [];
  for (const entry of providersRaw) {
    const provider = asRecord(entry);
    if (!provider) continue;
    const providerID = nonEmpty(provider.id) ?? nonEmpty(provider.providerID) ?? nonEmpty(provider.name);
    if (!providerID) continue;
    const models = provider.models;
    if (Array.isArray(models)) {
      for (const model of models) {
        const record = asRecord(model);
        if (!record) continue;
        pushModel(seen, out, providerID, nonEmpty(record.id) ?? nonEmpty(record.modelID) ?? nonEmpty(record.name) ?? "");
      }
    } else {
      const modelMap = asRecord(models);
      if (modelMap) {
        for (const [modelID, value] of Object.entries(modelMap)) {
          const record = asRecord(value);
          pushModel(seen, out, providerID, nonEmpty(record?.id) ?? modelID);
        }
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

function candidatePaths(apiVersion: OpenCodeApiVersion): string[] {
  return apiVersion === "v2"
    ? ["/api/provider", "/api/config/providers"]
    : ["/config/providers", "/provider"];
}

export async function listOpenCodeGatewayModels(config: Record<string, unknown>): Promise<AdapterModel[]> {
  const cfg = parseGatewayConfig(config);
  if (!cfg.baseUrl || !cfg.password) return [];
  const connection: OpenCodeConnection = {
    baseUrl: cfg.baseUrl,
    authHeader: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`, "utf8").toString("base64")}`,
    extraHeaders: cfg.extraHeaders,
    fetchImpl: fetch,
  };
  let apiVersion: OpenCodeApiVersion = "v1";
  try {
    const info = await detectOpenCodeServerInfo(connection);
    apiVersion = info.apiVersion;
  } catch {
    return [];
  }
  for (const path of candidatePaths(apiVersion)) {
    try {
      const raw = await requestJson(connection, path);
      const models = parseProviderModelCatalog(raw);
      if (models.length > 0) return models;
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}
