import { describe, expect, it } from "vitest";
import { createOpenCodeApiClient, type OpenCodeTransport } from "./api-client.js";

function captureClient(apiVersion: "v1" | "v2", directory = "/workspace") {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const transport: OpenCodeTransport = {
    async request(path, init) {
      calls.push({ path, init });
      return {};
    },
  };
  return { calls, client: createOpenCodeApiClient({ apiVersion, transport, directory }) };
}

describe("OpenCode V2 client request shapes", () => {
  it("creates sessions and prompts through the /api surface", async () => {
    const { calls, client } = captureClient("v2");
    await client.createSession({ title: "t", providerID: "anthropic", modelID: "claude" });
    await client.prompt({ sessionId: "ses_1", providerID: "anthropic", modelID: "claude", prompt: "hi" });
    await client.interrupt("ses_1");
    expect(calls[0]!.path).toBe("/api/session");
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ title: "t", model: { providerID: "anthropic", id: "claude" } }),
    );
    expect(calls[1]!.path).toBe("/api/session/ses_1/prompt");
    expect(calls[1]!.init?.body).toBe(JSON.stringify({ text: "hi" }));
    expect(calls[2]!.path).toBe("/api/session/ses_1/interrupt");
  });

  it("routes permission and form replies", async () => {
    const { calls, client } = captureClient("v2");
    await client.replyPermission({ sessionId: "ses_1", requestId: "per_1", action: "accept" });
    await client.replyQuestion({
      sessionId: "ses_1",
      requestId: "frm_1",
      nativeQuestions: [{ key: "choice", fieldType: "string" }],
      response: { schema: "paperclip.question_response.v1", answers: { choice: { selectedOptionIds: ["a"] } } },
    });
    await client.rejectQuestion({ sessionId: "ses_1", requestId: "frm_2" });
    expect(calls[0]!.path).toBe("/api/session/ses_1/permission/per_1/reply");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ decision: "once" }));
    expect(calls[1]!.path).toBe("/api/session/ses_1/form/frm_1/reply");
    expect(calls[2]!.path).toBe("/api/session/ses_1/form/frm_2");
  });

  it("normalizes V2 session execution events into V1-shaped terminals", () => {
    const { client } = captureClient("v2");
    expect(client.normalizeEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })).toEqual([
      expect.objectContaining({ type: "session.idle" }),
    ]);
    expect(
      client.normalizeEvent({ type: "session.text.delta", data: { assistantMessageID: "m1", ordinal: 0, delta: "hi" } }),
    ).toEqual([expect.objectContaining({ type: "message.part.updated" })]);
  });
});

describe("OpenCode V1 client request shapes", () => {
  it("uses prompt_async and directory-scoped permission replies", async () => {
    const { calls, client } = captureClient("v1", "/workspace");
    await client.prompt({ sessionId: "ses_1", providerID: "anthropic", modelID: "claude", prompt: "hi" });
    await client.replyPermission({ sessionId: "ses_1", requestId: "per_1", action: "accept_for_session" });
    await client.rejectQuestion({ sessionId: "ses_1", requestId: "q_1" });
    expect(calls[0]!.path).toBe("/session/ses_1/prompt_async");
    expect(calls[1]!.path).toBe("/permission/per_1/reply?directory=%2Fworkspace");
    expect(calls[1]!.init?.body).toBe(JSON.stringify({ reply: "always" }));
    expect(calls[2]!.path).toBe("/question/q_1/reject?directory=%2Fworkspace");
  });
});
