import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, parseGatewayConfig, resolveModelParts } from "./config.js";

describe("normalizeBaseUrl", () => {
  it("accepts http/https and strips trailing path/search/hash", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:4096/")?.toString()).toBe("http://127.0.0.1:4096/");
    expect(normalizeBaseUrl("https://host:8443/base/?x=1#y")?.toString()).toBe("https://host:8443/base");
  });

  it("rejects non-http protocols", () => {
    expect(normalizeBaseUrl("ftp://host")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });
});

describe("resolveModelParts", () => {
  it("splits provider/model", () => {
    expect(resolveModelParts({ model: "anthropic/claude-sonnet-4-5", providerID: null, modelID: null })).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  it("prefers explicit ids and tolerates a slashless model", () => {
    expect(
      resolveModelParts({ model: "a/b", providerID: "p", modelID: "m" }),
    ).toEqual({ providerID: "p", modelID: "m" });
    expect(resolveModelParts({ model: "gpt", providerID: null, modelID: null })).toEqual({
      providerID: null,
      modelID: null,
    });
  });
});

describe("parseGatewayConfig", () => {
  it("applies documented defaults", () => {
    const cfg = parseGatewayConfig({
      apiBaseUrl: "http://127.0.0.1:4096",
      password: "secret",
      model: "anthropic/claude",
    });
    expect(cfg.username).toBe("opencode");
    expect(cfg.versionOverride).toBe("auto");
    expect(cfg.sessionKeyStrategy).toBe("issue");
    expect(cfg.timeoutSec).toBe(600);
    expect(cfg.eventReconnectMs).toBe(2000);
    expect(cfg.pollIntervalMs).toBe(1000);
    expect(cfg.permissionAction).toBe("accept");
    expect(cfg.questionPolicy).toBe("reject");
  });

  it("reads the url alias and normalizes overrides", () => {
    const cfg = parseGatewayConfig({
      url: "http://127.0.0.1:4096",
      password: "secret",
      model: "a/b",
      version: "v2",
      sessionKeyStrategy: "run",
      permissionMode: "decline",
      timeoutSec: 30,
    });
    expect(cfg.apiBaseUrl).toBe("http://127.0.0.1:4096");
    expect(cfg.versionOverride).toBe("v2");
    expect(cfg.sessionKeyStrategy).toBe("run");
    expect(cfg.permissionAction).toBe("decline");
    expect(cfg.timeoutSec).toBe(30);
  });

  it("drops security-critical headers from extra headers", () => {
    const cfg = parseGatewayConfig({
      apiBaseUrl: "http://127.0.0.1:4096",
      password: "secret",
      model: "a/b",
      headers: { Authorization: "Basic abc", "X-Trace": "1", "Content-Type": "application/json" },
    });
    expect(cfg.extraHeaders).toEqual({ "X-Trace": "1" });
  });
});
