import { describe, expect, it } from "vitest";
import {
  buildModelFieldOptions,
  catalogToAdapterModels,
  FALLBACK_OPENCODE_MODELS,
  isFreeModelId,
  isRetiredOpenCodeModelId,
  RETIRED_OPENCODE_MODEL_IDS,
  loadOpenCodeModelCatalog,
  parseModelCatalog,
  parseZeroCostModelIds,
  resetOpenCodeModelCatalogCacheForTests,
} from "./free-models.js";

describe("isFreeModelId", () => {
  it("marks the -free suffix and stealth free ids", () => {
    expect(isFreeModelId("space-bunny-free")).toBe(true);
    expect(isFreeModelId("grok-code")).toBe(true);
    expect(isFreeModelId("gpt-5.2")).toBe(false);
  });
});

describe("retired models", () => {
  it("filters only ids a live probe confirmed dead", () => {
    RETIRED_OPENCODE_MODEL_IDS.add("test-dead");
    try {
      expect(isRetiredOpenCodeModelId("test-dead")).toBe(true);
      const models = parseModelCatalog(
        { object: "list", data: [{ id: "test-dead" }, { id: "grok-code" }, { id: "gpt-5.2" }] },
        "opencode",
      );
      expect(models.map((model) => model.id)).toEqual(["opencode/grok-code", "opencode/gpt-5.2"]);
    } finally {
      RETIRED_OPENCODE_MODEL_IDS.delete("test-dead");
    }
    // The live catalogs and both probe paths answer for big-pickle, so it stays.
    expect(isRetiredOpenCodeModelId("big-pickle")).toBe(false);
  });

  it("never resurrects a stealth id from the offline fallback", () => {
    expect(FALLBACK_OPENCODE_MODELS.some((model) => model.modelId === "big-pickle")).toBe(false);
  });
});

describe("parseModelCatalog", () => {
  it("qualifies ids with the provider and marks free models", () => {
    const models = parseModelCatalog(
      { object: "list", data: [{ id: "grok-code" }, { id: "gpt-5.2" }] },
      "opencode",
    );
    expect(models).toEqual([
      expect.objectContaining({ id: "opencode/grok-code", modelId: "grok-code", free: true }),
      expect.objectContaining({ id: "opencode/gpt-5.2", modelId: "gpt-5.2", free: false }),
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseModelCatalog(null, "opencode")).toEqual([]);
    expect(parseModelCatalog({ data: "nope" }, "opencode-go")).toEqual([]);
  });
});

describe("buildModelFieldOptions", () => {
  it("labels free models and groups by provider", () => {
    const options = buildModelFieldOptions(
      parseModelCatalog(
        { data: [{ id: "grok-code" }, { id: "gpt-5.2" }] },
        "opencode",
      ),
    );
    expect(options).toEqual([
      { value: "opencode/grok-code", label: "grok-code (free)", group: "OpenCode Zen (free)" },
      { value: "opencode/gpt-5.2", label: "gpt-5.2", group: "OpenCode Zen" },
    ]);
  });
});

describe("loadOpenCodeModelCatalog", () => {
  it("merges the Zen and Go catalogs, free models first", async () => {
    resetOpenCodeModelCatalogCacheForTests();
    const fetchImpl = (async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/zen/go/")) {
        return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }, { id: "step-5-preview-free" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "grok-code" }] }), { status: 200 });
    }) as typeof fetch;

    const models = await loadOpenCodeModelCatalog({ fetchImpl, force: true });
    expect(models.some((model) => model.id === "opencode-go/kimi-k3")).toBe(true);
    expect(models.some((model) => model.id === "opencode/grok-code" && model.free)).toBe(true);
    // Free models sort before paid ones regardless of provider.
    expect(models[0]!.free).toBe(true);
  });

  it("uses models.dev zero-cost metadata to mark stealth free models", async () => {
    resetOpenCodeModelCatalogCacheForTests();
    expect(parseZeroCostModelIds({
      opencode: { models: { "stealth-new": { cost: { input: 0, output: 0 } }, paid: { cost: { input: 1, output: 2 } } } },
      "opencode-go": { models: {} },
    })).toEqual(new Set(["stealth-new"]));
    const fetchImpl = (async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("models.dev")) {
        return new Response(JSON.stringify({
          opencode: { models: { "stealth-new": { cost: { input: 0, output: 0 } }, paid: { cost: { input: 1, output: 2 } } } },
          "opencode-go": { models: {} },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "stealth-new" }, { id: "paid" }] }), { status: 200 });
    }) as typeof fetch;

    const models = await loadOpenCodeModelCatalog({ fetchImpl, force: true });
    expect(models.find((model) => model.id === "opencode/stealth-new")?.free).toBe(true);
    expect(models.find((model) => model.id === "opencode/paid")?.free).toBe(false);
  });

  it("falls back to the baked list when every fetch fails", async () => {
    resetOpenCodeModelCatalogCacheForTests();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const models = await loadOpenCodeModelCatalog({ fetchImpl: failing, force: true });
    expect(models).toEqual(FALLBACK_OPENCODE_MODELS);
  });
});

describe("catalogToAdapterModels", () => {
  it("labels provider and free marker", () => {
    const [model] = catalogToAdapterModels([
      { id: "opencode/grok-code", provider: "opencode", providerLabel: "OpenCode Zen", modelId: "grok-code", free: true },
    ]);
    expect(model).toEqual({ id: "opencode/grok-code", label: "OpenCode Zen · grok-code (free)" });
  });
});
