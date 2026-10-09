import { describe, expect, it } from "vitest";
import {
  agentConfigurationDoc,
  createServerAdapter,
  label,
  models,
  type as adapterType,
} from "./index.js";

describe("opencode_gateway package exports", () => {
  it("exposes the metadata the plugin loader and UI expect", () => {
    expect(adapterType).toBe("opencode_gateway");
    expect(label).toBe("OpenCode Gateway");
    expect(Array.isArray(models)).toBe(true);
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

  it("getConfigSchema marks apiBaseUrl and password required", () => {
    const schema = createServerAdapter().getConfigSchema?.();
    const fields = typeof schema === "object" && schema !== null && "fields" in schema ? schema.fields : [];
    const byKey = new Map(fields.map((field) => [field.key, field]));
    expect(byKey.get("apiBaseUrl")?.required).toBe(true);
    expect(byKey.get("password")?.required).toBe(true);
    expect(byKey.get("password")?.meta?.secret).toBe(true);
    expect(byKey.get("version")?.default).toBe("auto");
    expect(byKey.get("sessionKeyStrategy")?.default).toBe("issue");
  });
});
