import { describe, expect, it } from "vitest";
import {
  agentConfigurationDoc,
  createServerAdapter,
  label,
  models,
  type as adapterType,
} from "./index.js";
import { getConfigSchema } from "./server/config-schema.js";

describe("opencode_gateway package exports", () => {
  it("exposes the metadata the plugin loader and UI expect", () => {
    expect(adapterType).toBe("opencode_gateway");
    expect(label).toBe("OpenCode Gateway");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.label.includes("(free)"))).toBe(true);
    expect(agentConfigurationDoc).toContain("opencode_gateway");
    expect(agentConfigurationDoc).toContain("Workspace and location");
    expect(agentConfigurationDoc).toContain("1.18.34 <= v < 2.0.0");
  });

  it("createServerAdapter returns a valid ServerAdapterModule", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("opencode_gateway");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(typeof adapter.getConfigSchema).toBe("function");
    expect(adapter.sessionCodec).toBeDefined();
    expect(adapter.sessionManagement?.supportsSessionResume).toBe(true);
    expect(adapter.supportsLocalAgentJwt).toBe(false);
    expect(adapter.supportsInstructionsBundle).toBe(false);
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(false);
  });

  it("getConfigSchema requires apiBaseUrl and model, and offers the free-model combobox", async () => {
    const schema = await getConfigSchema({
      loadCatalog: async () => [
        { id: "opencode/big-pickle", provider: "opencode", providerLabel: "OpenCode Zen", modelId: "big-pickle", free: true },
      ],
    });
    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    expect(byKey.get("apiBaseUrl")?.required).toBe(true);
    expect(byKey.get("model")?.required).toBe(true);
    expect(byKey.get("model")?.type).toBe("combobox");
    expect(byKey.get("model")?.options?.some((option) => option.value === "opencode/big-pickle")).toBe(true);
    expect(byKey.get("password")?.required).not.toBe(true);
    expect(byKey.get("password")?.meta?.secret).toBe(true);
    expect(byKey.get("allowNoAuth")?.type).toBe("toggle");
    expect(byKey.get("version")?.default).toBe("auto");
    expect(byKey.get("sessionKeyStrategy")?.default).toBe("issue");
  });
});
