import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildGatewayPrompt } from "./prompt.js";

function makeContext(servers: { url: string; token: string }[]): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Research Manager" },
    runtime: {},
    config: {},
    context: {},
    runtimeMcp: {
      getServers: () =>
        servers.map((server) => ({
          name: "Paperclip projects",
          url: server.url,
          token: server.token,
          connectionId: "paperclip-project-tools",
        })),
    },
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("buildGatewayPrompt", () => {
  it("carries the run-scoped Paperclip API token and base URL", () => {
    const { prompt } = buildGatewayPrompt(
      makeContext([{ url: "http://host:3100/api/mcp/project-tools", token: "run-token" }]),
      { paperclipApiUrl: null, resumedSession: false },
    );
    expect(prompt).toContain("API base URL: http://host:3100");
    expect(prompt).toContain("Bearer token: run-token");
    expect(prompt).toContain("X-Paperclip-Run-Id");
  });

  it("prefers the configured API URL override", () => {
    const { prompt } = buildGatewayPrompt(
      makeContext([{ url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "run-token" }]),
      { paperclipApiUrl: "http://192.168.0.115:3100/", resumedSession: false },
    );
    expect(prompt).toContain("API base URL: http://192.168.0.115:3100/");
  });

  it("omits the API block when Paperclip did not deliver a run token", () => {
    const { prompt } = buildGatewayPrompt(makeContext([]), {
      paperclipApiUrl: null,
      resumedSession: false,
    });
    expect(prompt).not.toContain("Bearer token:");
  });
});
