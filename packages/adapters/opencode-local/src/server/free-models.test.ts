import { describe, expect, it } from "vitest";
import {
  FALLBACK_OPENCODE_FREE_MODELS,
  isFreeOpenCodeModelId,
  isRetiredOpenCodeModelId,
  RETIRED_OPENCODE_MODEL_IDS,
  loadOpenCodeFreeModelData,
  loadOpenCodeFreeModels,
  mergeFreeModels,
  parseFreeModelCatalog,
  parseZeroCostModelIds,
  resetOpenCodeFreeModelCacheForTests,
} from "./free-models.js";

describe("isFreeOpenCodeModelId", () => {
  it("detects the -free suffix and stealth ids", () => {
    expect(isFreeOpenCodeModelId("space-bunny-free")).toBe(true);
    expect(isFreeOpenCodeModelId("grok-code")).toBe(true);
    expect(isFreeOpenCodeModelId("gpt-5.2")).toBe(false);
  });
});

describe("retired models", () => {
  it("filters only ids a live probe confirmed dead", () => {
    RETIRED_OPENCODE_MODEL_IDS.add("test-dead");
    try {
      expect(isRetiredOpenCodeModelId("test-dead")).toBe(true);
      expect(parseFreeModelCatalog(
        { data: [{ id: "test-dead" }, { id: "step-5-preview-free" }] },
        "opencode",
      ).map((model) => model.id)).toEqual(["opencode/step-5-preview-free"]);
      expect(mergeFreeModels(
        [{ id: "opencode/test-dead", label: "opencode/test-dead" }, { id: "openai/gpt-5.2", label: "openai/gpt-5.2" }],
        [],
      ).map((model) => model.id)).toEqual(["openai/gpt-5.2"]);
    } finally {
      RETIRED_OPENCODE_MODEL_IDS.delete("test-dead");
    }
    // Local CLI answers for big-pickle too, so it is not retired.
    expect(isRetiredOpenCodeModelId("big-pickle")).toBe(false);
  });

  it("never resurrects a stealth id from the offline fallback", () => {
    expect(FALLBACK_OPENCODE_FREE_MODELS.some((model) => model.id === "opencode/big-pickle")).toBe(false);
  });
});

describe("parseFreeModelCatalog", () => {
  it("keeps only free models and labels them", () => {
    const models = parseFreeModelCatalog(
      { data: [{ id: "gpt-5.2" }, { id: "grok-code" }, { id: "step-5-preview-free" }] },
      "opencode",
    );
    expect(models).toEqual([
      { id: "opencode/grok-code", label: "OpenCode Zen · grok-code (free)" },
      { id: "opencode/step-5-preview-free", label: "OpenCode Zen · step-5-preview-free (free)" },
    ]);
  });
});

describe("mergeFreeModels", () => {
  it("marks discovered free models and appends ones the CLI missed", () => {
    const merged = mergeFreeModels(
      [{ id: "opencode/grok-code", label: "opencode/grok-code" }, { id: "openai/gpt-5.2", label: "openai/gpt-5.2" }],
      [{ id: "opencode-go/kimi-k3", label: "OpenCode Go · kimi-k3 (free)" }],
    );
    expect(merged).toEqual([
      { id: "opencode/grok-code", label: "opencode/grok-code (free)" },
      { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
      { id: "opencode-go/kimi-k3", label: "OpenCode Go · kimi-k3 (free)" },
    ]);
  });

  it("does not double-label", () => {
    const merged = mergeFreeModels(
      [{ id: "opencode/grok-code", label: "opencode/grok-code (free)" }],
      [],
    );
    expect(merged[0]!.label).toBe("opencode/grok-code (free)");
  });
});

describe("loadOpenCodeFreeModels", () => {
  it("merges the Zen and Go free catalogs", async () => {
    resetOpenCodeFreeModelCacheForTests();
    const fetchImpl = (async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/zen/go/")) {
        return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }, { id: "step-5-preview-free" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "grok-code" }] }), { status: 200 });
    }) as typeof fetch;
    const models = await loadOpenCodeFreeModels({ fetchImpl, force: true });
    expect(models.some((model) => model.id === "opencode/grok-code")).toBe(true);
    expect(models.some((model) => model.id === "opencode-go/step-5-preview-free")).toBe(true);
    expect(models.some((model) => model.id === "opencode/gpt-5.2")).toBe(false);
  });

  it("uses models.dev zero-cost metadata to mark stealth free models", async () => {
    resetOpenCodeFreeModelCacheForTests();
    expect(parseZeroCostModelIds({
      opencode: { models: { "stealth-new": { cost: { input: 0, output: 0 } }, paid: { cost: { input: 1, output: 2 } } } },
      "opencode-go": { models: {} },
    })).toEqual(new Set(["stealth-new"]));
    const fetchImpl = (async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("models.dev")) {
        return new Response(JSON.stringify({
          opencode: { models: { "stealth-new": { cost: { input: 0, output: 0 } } } },
          "opencode-go": { models: {} },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "stealth-new" }, { id: "paid" }] }), { status: 200 });
    }) as typeof fetch;

    const data = await loadOpenCodeFreeModelData({ fetchImpl, force: true });
    expect(data.models.some((model) => model.id === "opencode/stealth-new")).toBe(true);
    expect(data.models.some((model) => model.id === "opencode/paid")).toBe(false);
    expect(data.zeroCostIds.has("stealth-new")).toBe(true);
  });

  it("falls back to the baked list on failure", async () => {
    resetOpenCodeFreeModelCacheForTests();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const models = await loadOpenCodeFreeModels({ fetchImpl: failing, force: true });
    expect(models).toEqual(FALLBACK_OPENCODE_FREE_MODELS);
  });
});
