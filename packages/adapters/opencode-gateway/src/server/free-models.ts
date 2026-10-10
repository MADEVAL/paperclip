import type { AdapterModel } from "@paperclipai/adapter-utils";
import type { ConfigFieldOption } from "@paperclipai/adapter-utils";

/**
 * Public, machine-readable OpenCode model catalogs.
 *
 * - `https://opencode.ai/zen/v1/models` lists every OpenCode Zen model (no auth).
 * - `https://opencode.ai/zen/go/v1/models` lists every OpenCode Go model.
 *
 * Both are tiny OpenAI-style lists (`{ object, data: [{ id, ... }] }`). They do
 * not mark free models, so the adapter applies OpenCode's naming convention
 * (`-free` suffix) plus a small stealth set. `models.dev` (used by OpenCode
 * itself) is the authoritative cost source, and its `opencode` / `opencode-go`
 * providers report the same free ids; we keep a baked-in fallback so the field
 * is never empty when the network is unavailable.
 */

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const MODEL_CATALOG_TIMEOUT_MS = 3_000;

/** Free models that do NOT carry the `-free` suffix (stealth releases). */
export const KNOWN_FREE_MODEL_IDS = new Set(["big-pickle", "grok-code"]);

export type OpenCodeModelProvider = "opencode" | "opencode-go";

export interface OpenCodeCatalogModel {
  /** Fully-qualified OpenCode model id, `provider/model`. */
  id: string;
  provider: OpenCodeModelProvider;
  providerLabel: string;
  modelId: string;
  free: boolean;
}

const PROVIDER_LABELS: Record<OpenCodeModelProvider, string> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

export function isFreeModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.endsWith("-free") || KNOWN_FREE_MODEL_IDS.has(normalized);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Parse an OpenAI-style `{ data: [{ id }] }` catalog into qualified models. */
export function parseModelCatalog(
  raw: unknown,
  provider: OpenCodeModelProvider,
): OpenCodeCatalogModel[] {
  const record = asRecord(raw);
  const data = Array.isArray(record?.data) ? record!.data : Array.isArray(raw) ? raw : [];
  const providerLabel = PROVIDER_LABELS[provider];
  const seen = new Set<string>();
  const models: OpenCodeCatalogModel[] = [];
  for (const entry of data) {
    const modelId = nonEmpty(asRecord(entry)?.id);
    if (!modelId) continue;
    const id = `${provider}/${modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      provider,
      providerLabel,
      modelId,
      free: isFreeModelId(modelId),
    });
  }
  return models;
}

/**
 * Baked-in fallback used when the live catalogs cannot be fetched. Kept small
 * and limited to free models so the dropdown is still useful offline.
 */
export const FALLBACK_OPENCODE_MODELS: OpenCodeCatalogModel[] = [
  "opencode/big-pickle",
  "opencode/space-bunny-free",
  "opencode/step-5-preview-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/exo-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/ling-3.1-flash-free",
  "opencode-go/longcat-2.5-preview-free",
  "opencode-go/step-5-preview-free",
  "opencode-go/space-bunny-free",
].map((id) => {
  const provider = id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
  const modelId = id.slice(id.indexOf("/") + 1);
  return { id, provider, providerLabel: PROVIDER_LABELS[provider], modelId, free: true };
});

function orderCatalog(models: OpenCodeCatalogModel[]): OpenCodeCatalogModel[] {
  const rank = (model: OpenCodeCatalogModel): number => {
    const providerRank = model.provider === "opencode" ? 0 : 1;
    const freeRank = model.free ? 0 : 1;
    return freeRank * 2 + providerRank;
  };
  return [...models].sort(
    (a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

async function fetchCatalog(
  url: string,
  provider: OpenCodeModelProvider,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OpenCodeCatalogModel[]> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenCode model catalog ${url} returned HTTP ${response.status}`);
  return parseModelCatalog(await response.json(), provider);
}

interface CatalogCache {
  expiresAt: number;
  models: OpenCodeCatalogModel[];
}

let catalogCache: CatalogCache | null = null;

export interface LoadCatalogOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  force?: boolean;
}

/**
 * Load the live OpenCode Zen + Go catalogs. Never throws: on any failure the
 * baked-in fallback is returned so the config field is always populated.
 */
export async function loadOpenCodeModelCatalog(
  options: LoadCatalogOptions = {},
): Promise<OpenCodeCatalogModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS;
  const now = Date.now();
  if (!options.force && catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.models;
  }
  const results = await Promise.allSettled([
    fetchCatalog(OPENCODE_ZEN_MODELS_URL, "opencode", fetchImpl, timeoutMs),
    fetchCatalog(OPENCODE_GO_MODELS_URL, "opencode-go", fetchImpl, timeoutMs),
  ]);
  const merged: OpenCodeCatalogModel[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") merged.push(...result.value);
  }
  const models = merged.length > 0 ? orderCatalog(merged) : FALLBACK_OPENCODE_MODELS;
  if (merged.length > 0) {
    catalogCache = { expiresAt: now + MODEL_CATALOG_TTL_MS, models };
  }
  return models;
}

export function resetOpenCodeModelCatalogCacheForTests(): void {
  catalogCache = null;
}

/** Group order for the config combobox: free first, Zen before Go. */
export function groupForCatalogModel(model: OpenCodeCatalogModel): string {
  return `${model.providerLabel}${model.free ? " (free)" : ""}`;
}

export function buildModelFieldOptions(catalog: OpenCodeCatalogModel[]): ConfigFieldOption[] {
  return catalog.map((model) => ({
    value: model.id,
    label: `${model.modelId}${model.free ? " (free)" : ""}`,
    group: groupForCatalogModel(model),
  }));
}

export function catalogToAdapterModels(catalog: OpenCodeCatalogModel[]): AdapterModel[] {
  return catalog.map((model) => ({
    id: model.id,
    label: `${model.providerLabel} · ${model.modelId}${model.free ? " (free)" : ""}`,
  }));
}
