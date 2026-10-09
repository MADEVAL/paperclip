import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

type RawEvent = Record<string, unknown>;

function safeBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return null;
  try {
    return JSON.parse(String(body));
  } catch {
    return String(body);
  }
}

function createFakeServer(input: {
  version: "v1" | "v2";
  versionString: string;
  sessionId: string;
  frames: RawEvent[];
}) {
  const requests: string[] = [];
  const replies: Array<{ path: string; body: unknown }> = [];
  const queued = input.frames.map((event) => `data: ${JSON.stringify(event)}\n\n`);

  const fakeFetch: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    const method = String(init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${url.pathname}`);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

    if (input.version === "v1") {
      if (url.pathname === "/global/health") return json({ healthy: true, version: input.versionString });
    } else {
      if (url.pathname === "/global/health") return new Response(null, { status: 404 });
      if (url.pathname === "/api/info") return json({ version: input.versionString });
    }

    if (method === "POST" && url.pathname === "/session") return json({ id: input.sessionId });
    if (method === "GET" && url.pathname === `/session/${input.sessionId}`) return json({ id: input.sessionId });
    if (method === "POST" && url.pathname === `/session/${input.sessionId}/prompt_async`) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname === "/api/session") return json({ data: { id: input.sessionId } });
    if (method === "GET" && url.pathname === `/api/session/${input.sessionId}`) {
      return json({ data: { id: input.sessionId } });
    }
    if (method === "POST" && url.pathname === `/api/session/${input.sessionId}/prompt`) return json({});
    if (method === "GET" && (url.pathname === "/event" || url.pathname === "/api/event")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of queued) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (method === "GET" && url.pathname === "/session/status") return json({});
    if (method === "GET" && url.pathname === "/api/session/active") return json({ data: {} });
    if (method === "POST" && url.pathname.startsWith("/permission/")) {
      replies.push({ path: url.pathname, body: safeBody(init?.body) });
      return json({});
    }
    if (method === "POST" && url.pathname.startsWith("/question/")) {
      replies.push({ path: url.pathname, body: safeBody(init?.body) });
      return json({});
    }
    if (method === "POST" && url.pathname === `/session/${input.sessionId}/abort`) return json({});
    if (method === "POST" && url.pathname === `/api/session/${input.sessionId}/interrupt`) return json({});
    if (url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/form")) return json({ data: [] });
    return new Response(null, { status: 404 });
  };

  return { fakeFetch, requests, replies };
}

function makeContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Ada",
      adapterType: "opencode_gateway",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      apiBaseUrl: "http://127.0.0.1:4096",
      password: "s3cret",
      model: "anthropic/claude-sonnet-4-5",
    },
    context: { taskId: "issue-1", issueId: "issue-1" },
    onLog: async () => {},
    async onMeta() {},
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("execute", () => {
  it("runs a V1 session end to end and returns usage", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.18.35",
      sessionId: "ses_1",
      frames: [
        { type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "Hello world" } } },
        { type: "message.updated", properties: { info: { tokens: { input: 10, output: 5 }, cost: 0.01, modelID: "claude" } } },
        { type: "session.idle", properties: { sessionID: "ses_1" } },
      ],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(makeContext());
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("Hello world");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.costUsd).toBe(0.01);
    expect(result.sessionDisplayId).toBe("ses_1");
    expect(result.sessionParams).toMatchObject({ opencodeSessionId: "ses_1", strategy: "issue", apiVersion: "v1" });
    expect(server.requests).toContain("POST /session");
    expect(server.requests).toContain("POST /session/ses_1/prompt_async");
    expect(server.requests).toContain("GET /event");
  });

  it("runs a V2 session end to end through the /api surface", async () => {
    const server = createFakeServer({
      version: "v2",
      versionString: "2.0.26",
      sessionId: "ses_2",
      frames: [
        { type: "session.text.delta", data: { assistantMessageID: "m1", ordinal: 0, delta: "Hi V2" } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_2" } },
      ],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(makeContext());
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Hi V2");
    expect(result.sessionParams).toMatchObject({ opencodeSessionId: "ses_2", apiVersion: "v2" });
    expect(server.requests).toContain("POST /api/session");
    expect(server.requests).toContain("POST /api/session/ses_2/prompt");
    expect(server.requests).toContain("GET /api/event");
  });

  it("auto-approves permission requests", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.18.35",
      sessionId: "ses_1",
      frames: [
        { type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "bash" } },
        { type: "session.idle", properties: { sessionID: "ses_1" } },
      ],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(makeContext());
    expect(result.exitCode).toBe(0);
    expect(server.replies).toContainEqual({ path: "/permission/per_1/reply", body: { reply: "once" } });
  });

  it("declines interactive questions in headless mode", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.18.35",
      sessionId: "ses_1",
      frames: [
        { type: "question.asked", properties: { id: "q_1", sessionID: "ses_1", questions: [{ id: "q1" }] } },
        { type: "session.idle", properties: { sessionID: "ses_1" } },
      ],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(makeContext());
    expect(result.exitCode).toBe(0);
    expect(server.replies.some((entry) => entry.path === "/question/q_1/reject")).toBe(true);
  });

  it("maps a session error terminal to a failed run", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.18.35",
      sessionId: "ses_1",
      frames: [{ type: "session.error", properties: { error: { message: "provider exploded" } } }],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(makeContext());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("opencode_gateway_session_error");
    expect(result.errorMessage).toContain("provider exploded");
  });

  it("resumes a stored session when the work-key matches", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.18.35",
      sessionId: "ses_existing",
      frames: [{ type: "session.idle", properties: { sessionID: "ses_existing" } }],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(
      makeContext({
        runtime: {
          sessionId: "ses_existing",
          sessionParams: {
            opencodeSessionId: "ses_existing",
            sessionKey: "paperclip:company:company-1:agent:agent-1:issue:issue-1",
            strategy: "issue",
            apiVersion: "v1",
          },
          sessionDisplayId: "ses_existing",
          taskKey: null,
        },
      }),
    );
    expect(result.sessionDisplayId).toBe("ses_existing");
    expect(server.requests).toContain("GET /session/ses_existing");
    expect(server.requests).not.toContain("POST /session");
  });

  it("times out and interrupts the session", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.18.35",
      sessionId: "ses_1",
      frames: [],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(
      makeContext({ config: { apiBaseUrl: "http://127.0.0.1:4096", password: "s3cret", model: "a/b", timeoutSec: 0.3 } }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("opencode_gateway_timeout");
    expect(server.requests).toContain("POST /session/ses_1/abort");
  });

  it("rejects an unqualified version unless explicitly bypassed", async () => {
    const server = createFakeServer({
      version: "v1",
      versionString: "1.17.0",
      sessionId: "ses_1",
      frames: [],
    });
    globalThis.fetch = server.fakeFetch;

    const result = await execute(makeContext());
    expect(result.errorCode).toBe("opencode_gateway_version_unqualified");
  });

  it("surfaces missing configuration", async () => {
    const missingUrl = await execute(makeContext({ config: { password: "x", model: "a/b" } }));
    expect(missingUrl.errorCode).toBe("opencode_gateway_api_base_url_missing");

    const missingPassword = await execute(makeContext({ config: { apiBaseUrl: "http://127.0.0.1:4096", model: "a/b" } }));
    expect(missingPassword.errorCode).toBe("opencode_gateway_password_missing");

    const missingModel = await execute(makeContext({ config: { apiBaseUrl: "http://127.0.0.1:4096", password: "x" } }));
    expect(missingModel.errorCode).toBe("opencode_gateway_model_missing");
  });

  it("blocks remote plain HTTP unless the escape hatch is set", async () => {
    const blocked = await execute(
      makeContext({ config: { apiBaseUrl: "http://gateway.example.com:4096", password: "x", model: "a/b" } }),
    );
    expect(blocked.errorCode).toBe("opencode_gateway_plain_http_remote_denied");
  });
});
