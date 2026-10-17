import type { AdapterModel } from "@paperclipai/adapter-utils";
import type { ConfigFieldOption } from "@paperclipai/adapter-utils";

/**
 * Public, machine-readable OpenCode model catalogs.
 *
 * - `https://opencode.ai/zen/v1/models` lists every OpenCode Zen model (no auth).
 * - `https://opencode.ai/zen/go/v1/models` lists every OpenCode Go model.
 * - `https://models.dev/api.json` provides the zero-cost metadata OpenCode itself
 *   uses, so a free model without a `-free` suffix is still labelled correctly.
 *
 * The Zen/Go lists are tiny OpenAI-style lists (`{ object, data: [{ id, ... }] }`)
 * and do not mark free models. We combine the `-free` suffix, a small stealth set,
 * and the `models.dev` zero-cost ids. `models.dev` is fetched in parallel with the
 * catalogs and a failure only degrades the free marker, never the model list.
 */

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_MODELS_DEV_URL = "https://models.dev/api.json";
export const MODEL_CATALOG_TTL_MS = 30 * 60 * 1000;
export const MODEL_CATALOG_TIMEOUT_MS = 3_000;
export const MODELS_DEV_TIMEOUT_MS = 8_000;
/**
 * The full `models.dev` catalog is several megabytes, so it is refreshed far
 * less often than the tiny Zen/Go lists. Most free ids also carry `-free`; this
 * metadata only improves stealth-release detection.
 */
const ZERO_COST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** How long an offline fallback is reused before retrying the network. */
const FALLBACK_TTL_MS = 60_000;

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

export function isFreeModelId(
  modelId: string,
  zeroCostIds?: ReadonlySet<string>,
): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.endsWith("-free") ||
    KNOWN_FREE_MODEL_IDS.has(normalized) ||
    zeroCostIds?.has(normalized) === true
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Extract ids whose `models.dev` `cost.input` and `cost.output` are both zero.
 *
 * Only ids already present in the live Zen/Go catalogs are labelled, so a
 * deprecated zero-cost entry in `models.dev` never adds a dead model.
 */
export function parseZeroCostModelIds(raw: unknown): Set<string> {
  const root = asRecord(raw);
  const ids = new Set<string>();
  if (!root) return ids;
  for (const provider of ["opencode", "opencode-go"] as const) {
    const models = asRecord(asRecord(root[provider])?.models);
    if (!models) continue;
    for (const [modelId, value] of Object.entries(models)) {
      const cost = asRecord(asRecord(value)?.cost);
      if (cost?.input === 0 && cost.output === 0) ids.add(modelId.trim().toLowerCase());
    }
  }
  return ids;
}

/** Parse an OpenAI-style `{ data: [{ id }] }` catalog into qualified models. */
export function parseModelCatalog(
  raw: unknown,
  provider: OpenCodeModelProvider,
  zeroCostIds?: ReadonlySet<string>,
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
      free: isFreeModelId(modelId, zeroCostIds),
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
  "opencode/beam-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/nemotron-3.5-super-vl-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/jev-1.13-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/space-bunny-free",
  "opencode-go/longcat-2.5-preview-free",
  "opencode-go/beam-free",
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

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenCode model catalog ${url} returned HTTP ${response.status}`);
  return response.json();
}

interface CatalogCache {
  expiresAt: number;
  models: OpenCodeCatalogModel[];
}

let catalogCache: CatalogCache | null = null;
let zeroCostCache: { expiresAt: number; ids: Set<string> } | null = null;

export interface LoadCatalogOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  modelsDevTimeoutMs?: number;
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
  const modelsDevTimeoutMs = options.modelsDevTimeoutMs ?? MODELS_DEV_TIMEOUT_MS;
  const now = Date.now();
  if (!options.force && catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.models;
  }

  const zeroCostFresh = Boolean(zeroCostCache && zeroCostCache.expiresAt > now);
  const results = await Promise.allSettled([
    fetchJson(OPENCODE_ZEN_MODELS_URL, fetchImpl, timeoutMs),
    fetchJson(OPENCODE_GO_MODELS_URL, fetchImpl, timeoutMs),
    zeroCostFresh
      ? Promise.resolve(null)
      : fetchJson(OPENCODE_MODELS_DEV_URL, fetchImpl, modelsDevTimeoutMs),
  ]);
  let zeroCostIds = zeroCostCache?.ids ?? new Set<string>();
  if (!zeroCostFresh && results[2].status === "fulfilled" && results[2].value !== null) {
    zeroCostIds = parseZeroCostModelIds(results[2].value);
    zeroCostCache = { expiresAt: now + ZERO_COST_CACHE_TTL_MS, ids: zeroCostIds };
  }
  const merged: OpenCodeCatalogModel[] = [];
  if (results[0].status === "fulfilled") {
    merged.push(...parseModelCatalog(results[0].value, "opencode", zeroCostIds));
  }
  if (results[1].status === "fulfilled") {
    merged.push(...parseModelCatalog(results[1].value, "opencode-go", zeroCostIds));
  }

  const live = merged.length > 0;
  const models = live ? orderCatalog(merged) : FALLBACK_OPENCODE_MODELS;
  catalogCache = {
    expiresAt: now + (live ? MODEL_CATALOG_TTL_MS : FALLBACK_TTL_MS),
    models,
  };
  return models;
}

export function resetOpenCodeModelCatalogCacheForTests(): void {
  catalogCache = null;
  zeroCostCache = null;
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
