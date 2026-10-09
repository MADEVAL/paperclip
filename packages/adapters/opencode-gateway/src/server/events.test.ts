import { describe, expect, it } from "vitest";
import {
  extractAssistantTextDelta,
  extractErrorEvent,
  extractEventUsage,
  extractPermissionRequest,
  extractQuestionRequest,
  isIdleEvent,
  parseSseFrames,
} from "./events.js";

describe("parseSseFrames", () => {
  it("parses complete frames and returns the trailing remainder", () => {
    const buffer = "event: message\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: {\"c\":3}";
    const { frames, rest } = parseSseFrames(buffer);
    expect(frames).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: null, data: '{"b":2}' },
    ]);
    expect(rest).toBe('data: {"c":3}');
  });

  it("tolerates CRLF and comment lines", () => {
    const { frames } = parseSseFrames(": keep-alive\r\ndata: hello\r\n\r\n");
    expect(frames).toEqual([{ event: null, data: "hello" }]);
  });
});

describe("extractAssistantTextDelta", () => {
  it("emits only the new suffix of cumulative part text", () => {
    const state = new Map<string, string>();
    const first = extractAssistantTextDelta(
      { type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "Hel" } } },
      state,
    );
    expect(first).toEqual({ partId: "p1", channel: "text", delta: "Hel" });

    const second = extractAssistantTextDelta(
      { type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "Hello" } } },
      state,
    );
    expect(second).toEqual({ partId: "p1", channel: "text", delta: "lo" });
  });

  it("classifies reasoning parts", () => {
    const delta = extractAssistantTextDelta(
      { type: "message.part.updated", properties: { part: { id: "r1", type: "reasoning", text: "think" } } },
      new Map(),
    );
    expect(delta?.channel).toBe("reasoning");
  });

  it("ignores non-part events", () => {
    expect(extractAssistantTextDelta({ type: "session.idle" }, new Map())).toBeNull();
  });
});

describe("extractEventUsage", () => {
  it("reads V1 message.updated token and cost shapes", () => {
    const usage = extractEventUsage({
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          tokens: { input: 40, output: 12, cache: { read: 3, write: 1 } },
          cost: 0.02,
          modelID: "gpt-5.2",
        },
      },
    });
    expect(usage?.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      cachedInputTokens: 3,
      cacheWriteTokens: 1,
    });
    expect(usage?.costUsd).toBe(0.02);
    expect(usage?.model).toBe("gpt-5.2");
  });

  it("returns null for unrelated events", () => {
    expect(extractEventUsage({ type: "session.idle" })).toBeNull();
  });
});

describe("terminal and control events", () => {
  it("detects idle and error terminals", () => {
    expect(isIdleEvent({ type: "session.idle" })).toBe(true);
    expect(isIdleEvent({ type: "session.error" })).toBe(false);
    expect(extractErrorEvent({ type: "session.error", properties: { error: { message: "boom" } } })).toBe("boom");
  });

  it("extracts permission requests", () => {
    expect(
      extractPermissionRequest({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "bash" } }),
    ).toEqual({ requestId: "per_1", sessionId: "ses_1", title: "bash" });
  });

  it("extracts question requests with native questions", () => {
    const question = extractQuestionRequest({
      type: "question.asked",
      properties: { id: "q_1", sessionID: "ses_1", questions: [{ id: "q1", question: "Pick" }] },
    });
    expect(question?.requestId).toBe("q_1");
    expect(question?.questions).toHaveLength(1);
  });
});
