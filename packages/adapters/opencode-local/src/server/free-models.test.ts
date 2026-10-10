import { describe, expect, it } from "vitest";
import {
  FALLBACK_OPENCODE_FREE_MODELS,
  isFreeOpenCodeModelId,
  loadOpenCodeFreeModels,
  mergeFreeModels,
  parseFreeModelCatalog,
  resetOpenCodeFreeModelCacheForTests,
} from "./free-models.js";

describe("isFreeOpenCodeModelId", () => {
  it("detects the -free suffix and stealth ids", () => {
    expect(isFreeOpenCodeModelId("space-bunny-free")).toBe(true);
    expect(isFreeOpenCodeModelId("big-pickle")).toBe(true);
    expect(isFreeOpenCodeModelId("gpt-5.2")).toBe(false);
  });
});

describe("parseFreeModelCatalog", () => {
  it("keeps only free models and labels them", () => {
    const models = parseFreeModelCatalog(
      { data: [{ id: "gpt-5.2" }, { id: "big-pickle" }, { id: "step-5-preview-free" }] },
      "opencode",
    );
    expect(models).toEqual([
      { id: "opencode/big-pickle", label: "OpenCode Zen · big-pickle (free)" },
      { id: "opencode/step-5-preview-free", label: "OpenCode Zen · step-5-preview-free (free)" },
    ]);
  });
});

describe("mergeFreeModels", () => {
  it("marks discovered free models and appends ones the CLI missed", () => {
    const merged = mergeFreeModels(
      [{ id: "opencode/big-pickle", label: "opencode/big-pickle" }, { id: "openai/gpt-5.2", label: "openai/gpt-5.2" }],
      [{ id: "opencode-go/kimi-k3", label: "OpenCode Go · kimi-k3 (free)" }],
    );
    expect(merged).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle (free)" },
      { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
      { id: "opencode-go/kimi-k3", label: "OpenCode Go · kimi-k3 (free)" },
    ]);
  });

  it("does not double-label", () => {
    const merged = mergeFreeModels(
      [{ id: "opencode/big-pickle", label: "opencode/big-pickle (free)" }],
      [],
    );
    expect(merged[0]!.label).toBe("opencode/big-pickle (free)");
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
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "big-pickle" }] }), { status: 200 });
    }) as typeof fetch;
    const models = await loadOpenCodeFreeModels({ fetchImpl, force: true });
    expect(models.some((model) => model.id === "opencode/big-pickle")).toBe(true);
    expect(models.some((model) => model.id === "opencode-go/step-5-preview-free")).toBe(true);
    expect(models.some((model) => model.id === "opencode/gpt-5.2")).toBe(false);
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
