import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * Free OpenCode Zen / Go models for the local adapter's model picker.
 *
 * OpenCode's local `opencode models` output already lists Zen/Go models when the
 * machine is logged into those providers, but it does not mark which ones are
 * free. We load the public catalogs and mark / add the free entries so the model
 * dropdown shows them with a `(free)` label.
 *
 * The logic mirrors `@paperclipai/adapter-opencode-gateway`'s catalog loader.
 * Adapter packages do not import each other, so this stays self-contained; if a
 * third OpenCode-family adapter appears, extract a shared module.
 */

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const OPENCODE_MODEL_CATALOG_TIMEOUT_MS = 3_000;

/** Free models that do NOT carry the `-free` suffix (stealth releases). */
export const KNOWN_FREE_MODEL_IDS = new Set(["big-pickle", "grok-code"]);

type Provider = "opencode" | "opencode-go";

const PROVIDER_LABELS: Record<Provider, string> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

export function isFreeOpenCodeModelId(modelId: string): boolean {
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

export interface OpenCodeFreeModel {
  id: string;
  label: string;
}

export function parseFreeModelCatalog(raw: unknown, provider: Provider): OpenCodeFreeModel[] {
  const record = asRecord(raw);
  const data = Array.isArray(record?.data) ? record!.data : Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: OpenCodeFreeModel[] = [];
  for (const entry of data) {
    const modelId = nonEmpty(asRecord(entry)?.id);
    if (!modelId || !isFreeOpenCodeModelId(modelId)) continue;
    const id = `${provider}/${modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: `${PROVIDER_LABELS[provider]} · ${modelId} (free)` });
  }
  return out;
}

/** Baked-in fallback so the free models still show when the catalog fetch fails. */
export const FALLBACK_OPENCODE_FREE_MODELS: AdapterModel[] = [
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
  const provider: Provider = id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
  const label = id.slice(id.indexOf("/") + 1);
  return { id, label: `${PROVIDER_LABELS[provider]} · ${label} (free)` };
});

async function fetchFree(
  url: string,
  provider: Provider,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OpenCodeFreeModel[]> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenCode model catalog ${url} returned HTTP ${response.status}`);
  return parseFreeModelCatalog(await response.json(), provider);
}

let cache: { expiresAt: number; models: AdapterModel[] } | null = null;

export interface LoadFreeModelsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  force?: boolean;
}

/** Load the free Zen + Go models. Never throws; falls back to the baked list. */
export async function loadOpenCodeFreeModels(
  options: LoadFreeModelsOptions = {},
): Promise<AdapterModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPENCODE_MODEL_CATALOG_TIMEOUT_MS;
  const now = Date.now();
  if (!options.force && cache && cache.expiresAt > now) return cache.models;
  const results = await Promise.allSettled([
    fetchFree(OPENCODE_ZEN_MODELS_URL, "opencode", fetchImpl, timeoutMs),
    fetchFree(OPENCODE_GO_MODELS_URL, "opencode-go", fetchImpl, timeoutMs),
  ]);
  const merged: OpenCodeFreeModel[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") merged.push(...result.value);
  }
  const models = merged.length > 0 ? merged.map((model) => ({ id: model.id, label: model.label })) : FALLBACK_OPENCODE_FREE_MODELS;
  if (merged.length > 0) cache = { expiresAt: now + OPENCODE_MODEL_CATALOG_TTL_MS, models };
  return models;
}

export function resetOpenCodeFreeModelCacheForTests(): void {
  cache = null;
}

/**
 * Merge discovered local models with the free catalog: mark discovered free
 * models and append free models the CLI did not report.
 */
export function mergeFreeModels(
  discovered: AdapterModel[],
  freeModels: AdapterModel[],
): AdapterModel[] {
  const seen = new Set<string>();
  const merged: AdapterModel[] = [];
  for (const model of discovered) {
    const modelId = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
    const free = isFreeOpenCodeModelId(modelId);
    const label = free && !model.label.includes("(free)") ? `${model.label} (free)` : model.label;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push({ id: model.id, label });
  }
  for (const model of freeModels) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}
