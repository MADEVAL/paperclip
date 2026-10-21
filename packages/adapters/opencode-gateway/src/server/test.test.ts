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

  it("allows connecting without auth when allowNoAuth is set", async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.35" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "127.0.0.1", allowNoAuth: true, model: "a/b", directory: "/workspace" }),
    );
    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_gateway_no_auth_selected")).toBe(true);
  });

  it("reports an auth failure", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "wrong", model: "a/b" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_gateway_auth_failed")).toBe(true);
  });

  it("allows plain HTTP to a private LAN address without the escape hatch", async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/info") return json({ version: "2.0.26", capabilities: {} });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({
        apiBaseUrl: "http://192.168.0.117:4096",
        password: "s3cret",
        model: "a/b",
        directory: "/workspace",
      }),
    );
    expect(
      result.checks.some((check) => check.code === "opencode_gateway_plain_http_remote_denied"),
    ).toBe(false);
    expect(result.status).not.toBe("fail");
  });

  it("still blocks plain HTTP to a public host without the escape hatch", async () => {
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

  it("accepts an unqualified version when the protocol family is pinned", async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/info") return json({ version: "2.1.2", capabilities: {} });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "s3cret", model: "a/b", version: "v2" }),
    );
    const check = result.checks.find((entry) => entry.code === "opencode_gateway_version_unqualified");
    expect(check?.level).toBe("warn");
    expect(result.status).not.toBe("fail");
  });

  it("detects a V2 server whose /global/health returns the HTML app shell", async () => {
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      if (url.pathname === "/global/health") {
        return new Response("<!doctype html><html><body>app</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/api/info") return json({ version: "2.0.26", capabilities: {} });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "s3cret", model: "a/b", directory: "/workspace" }),
    );
    expect(
      result.checks.some(
        (check) => check.code === "opencode_gateway_reachable" && check.message.includes("V2"),
      ),
    ).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_gateway_version_qualified")).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_gateway_version_unknown")).toBe(false);
  });

  it("honours a pinned version and probes only that endpoint", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      seen.push(url.pathname);
      if (url.pathname === "/global/health") {
        return new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/api/info") return json({ version: "2.0.26" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await testEnvironment(
      makeContext({ apiBaseUrl: "http://127.0.0.1:4096", password: "s3cret", model: "a/b", version: "v2" }),
    );
    expect(seen).toContain("/api/info");
    expect(seen).not.toContain("/global/health");
    expect(result.checks.some((check) => check.code === "opencode_gateway_version_qualified")).toBe(true);
  });
});
