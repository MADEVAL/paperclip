import { afterEach, describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { testEnvironment } from "./test.js";

function makeContext(config: Record<string, unknown>): AdapterEnvironmentTestContext {
  return { companyId: "company-1", adapterType: "opencode_gateway", config };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("testEnvironment", () => {
  it("fails fast when required fields are missing", async () => {
    const result = await testEnvironment(makeContext({}));
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_gateway_api_base_url_missing")).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_gateway_password_missing")).toBe(true);
  });

  it("reports a reachable qualified V1 server (with gateway-ownership warnings)", async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.35" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "s3cret", model: "a/b", directory: "/workspace" }),
    );
    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === "opencode_gateway_reachable")).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_gateway_version_qualified")).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_gateway_gateway_owns_providers")).toBe(true);
  });

  it("reports an auth failure", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "wrong", model: "a/b" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_gateway_auth_failed")).toBe(true);
  });

  it("blocks remote plain HTTP", async () => {
    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://gateway.example.com:4096", password: "s3cret", model: "a/b" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_gateway_plain_http_remote_denied")).toBe(true);
  });

  it("reports an unqualified version as an error", async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname === "/global/health") return json({ healthy: true, version: "1.16.0" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "s3cret", model: "a/b" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_gateway_version_unqualified")).toBe(true);
  });
});
