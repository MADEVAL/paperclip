import { describe, expect, it } from "vitest";
import { parseOpenCodeAgentModels, readOpenCodeAssistantReply } from "./agent-models.js";
import { RETIRED_OPENCODE_MODEL_IDS } from "./free-models.js";

describe("parseOpenCodeAgentModels", () => {
  it("keeps enabled models, filters disabled ones and labels free cost", () => {
    const models = parseOpenCodeAgentModels({
      data: [
        { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", status: "active", enabled: true, cost: [{ input: 0, output: 0 }] },
        { providerID: "opencode", modelID: "disabled-model", status: "disabled", enabled: true },
        { providerID: "opencode", modelID: "toggled-off", status: "active", enabled: false },
        { providerID: "openai", modelID: "gpt-5.2", status: "active", enabled: true, cost: [{ input: 3, output: 15 }] },
      ],
    });
    expect(models).toEqual([
      { id: "opencode/deepseek-v4.1-flash-free", label: "opencode · deepseek-v4.1-flash-free (free)" },
      { id: "openai/gpt-5.2", label: "openai · gpt-5.2" },
    ]);
  });

  it("drops a model only after the probe kill-switch marks it dead", () => {
    RETIRED_OPENCODE_MODEL_IDS.add("test-dead");
    try {
      expect(parseOpenCodeAgentModels({
        data: [{ providerID: "opencode", modelID: "test-dead", status: "active", enabled: true }],
      })).toEqual([]);
    } finally {
      RETIRED_OPENCODE_MODEL_IDS.delete("test-dead");
    }
  });

  it("survives a malformed payload", () => {
    expect(parseOpenCodeAgentModels(null)).toEqual([]);
    expect(parseOpenCodeAgentModels({ data: "nope" })).toEqual([]);
  });
});

describe("readOpenCodeAssistantReply", () => {
  it("reads the v2 flattened assistant content", () => {
    expect(readOpenCodeAssistantReply([
      { type: "idle", outcome: "succeeded" },
      { type: "assistant", content: [{ type: "text", text: "ok" }], finish: "stop" },
      { type: "user", text: "Reply with ok" },
    ])).toEqual({ text: "ok", error: null });
  });

  it("reports provider errors and the nested info.role shape", () => {
    expect(readOpenCodeAssistantReply([
      { info: { role: "assistant", error: "provider.no-route" }, parts: [] },
    ])).toEqual({ text: null, error: "provider.no-route" });
    expect(readOpenCodeAssistantReply([{ type: "error", text: "boom" }])).toEqual({ text: null, error: "boom" });
  });

  it("reports a failed idle outcome as the provider error", () => {
    expect(readOpenCodeAssistantReply([
      { type: "idle", outcome: "failed", error: { type: "provider.no-route", message: "Model unavailable: opencode/definitely-not-a-model" } },
      { type: "user", text: "Reply with ok" },
    ])).toEqual({ text: null, error: "Model unavailable: opencode/definitely-not-a-model" });
  });
});
