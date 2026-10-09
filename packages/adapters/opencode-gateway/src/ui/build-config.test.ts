import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildOpenCodeGatewayConfig } from "./build-config.js";

function baseValues(): CreateConfigValues {
  return {
    adapterType: "opencode_gateway",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 0,
  };
}

describe("buildOpenCodeGatewayConfig", () => {
  it("applies documented defaults", () => {
    const config = buildOpenCodeGatewayConfig(baseValues());
    expect(config.username).toBe("opencode");
    expect(config.version).toBe("auto");
    expect(config.timeoutSec).toBe(600);
    expect(config.eventReconnectMs).toBe(2000);
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.permissionMode).toBe("accept");
    expect(config.questionPolicy).toBe("reject");
    expect(config.sessionKeyStrategy).toBe("issue");
  });

  it("maps shared form fields and schema values", () => {
    const config = buildOpenCodeGatewayConfig({
      ...baseValues(),
      url: "http://127.0.0.1:4096",
      model: "anthropic/claude",
      timeoutSec: 30,
      sessionKeyStrategy: "agent",
      adapterSchemaValues: { password: "s3cret", directory: "/workspace" },
    });
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:4096");
    expect(config.model).toBe("anthropic/claude");
    expect(config.timeoutSec).toBe(30);
    expect(config.sessionKeyStrategy).toBe("agent");
    expect(config.password).toBe("s3cret");
    expect(config.directory).toBe("/workspace");
  });
});
