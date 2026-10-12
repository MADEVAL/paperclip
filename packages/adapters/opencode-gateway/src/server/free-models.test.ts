import { describe, expect, it } from "vitest";
import {
  buildModelFieldOptions,
  catalogToAdapterModels,
  FALLBACK_OPENCODE_MODELS,
  isFreeModelId,
  loadOpenCodeModelCatalog,
  parseModelCatalog,
  resetOpenCodeModelCatalogCacheForTests,
} from "./free-models.js";

describe("isFreeModelId", () => {
  it("marks the -free suffix and stealth free ids", () => {
    expect(isFreeModelId("space-bunny-free")).toBe(true);
    expect(isFreeModelId("big-pickle")).toBe(true);
    expect(isFreeModelId("gpt-5.2")).toBe(false);
  });
});

describe("parseModelCatalog", () => {
  it("qualifies ids with the provider and marks free models", () => {
    const models = parseModelCatalog(
      { object: "list", data: [{ id: "big-pickle" }, { id: "gpt-5.2" }] },
      "opencode",
    );
    expect(models).toEqual([
      expect.objectContaining({ id: "opencode/big-pickle", modelId: "big-pickle", free: true }),
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
        { data: [{ id: "big-pickle" }, { id: "gpt-5.2" }] },
        "opencode",
      ),
    );
    expect(options).toEqual([
      { value: "opencode/big-pickle", label: "big-pickle (free)", group: "OpenCode Zen (free)" },
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
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "big-pickle" }] }), { status: 200 });
    }) as typeof fetch;

    const models = await loadOpenCodeModelCatalog({ fetchImpl, force: true });
    expect(models.some((model) => model.id === "opencode-go/kimi-k3")).toBe(true);
    expect(models.some((model) => model.id === "opencode/big-pickle" && model.free)).toBe(true);
    // Free models sort before paid ones regardless of provider.
    expect(models[0]!.free).toBe(true);
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
      { id: "opencode/big-pickle", provider: "opencode", providerLabel: "OpenCode Zen", modelId: "big-pickle", free: true },
    ]);
    expect(model).toEqual({ id: "opencode/big-pickle", label: "OpenCode Zen · big-pickle (free)" });
  });
});
