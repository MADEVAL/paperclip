import { describe, expect, it } from "vitest";
import {
  normalizeSessionKeyStrategy,
  resolveSessionKey,
  sessionCodec,
  shouldResumeStoredSession,
} from "./session.js";

describe("resolveSessionKey", () => {
  it("scopes by issue by default", () => {
    expect(
      resolveSessionKey({ strategy: "issue", companyId: "c1", agentId: "a1", runId: "r1", issueId: "i1" }),
    ).toBe("paperclip:company:c1:agent:a1:issue:i1");
  });

  it("falls back to run scope when no issue is present", () => {
    expect(
      resolveSessionKey({ strategy: "issue", companyId: "c1", agentId: "a1", runId: "r1", issueId: null }),
    ).toBe("paperclip:company:c1:agent:a1:run:r1");
  });

  it("supports agent, run, and none strategies", () => {
    expect(
      resolveSessionKey({ strategy: "agent", companyId: "c1", agentId: "a1", runId: "r1", issueId: null }),
    ).toBe("paperclip:company:c1:agent:a1");
    expect(
      resolveSessionKey({ strategy: "run", companyId: "c1", agentId: "a1", runId: "r1", issueId: null }),
    ).toBe("paperclip:run:r1");
    expect(
      resolveSessionKey({ strategy: "none", companyId: "c1", agentId: "a1", runId: "r1", issueId: null }),
    ).toBeNull();
  });
});

describe("normalizeSessionKeyStrategy", () => {
  it("defaults unknown values to issue", () => {
    expect(normalizeSessionKeyStrategy("nope")).toBe("issue");
    expect(normalizeSessionKeyStrategy("AGENT")).toBe("agent");
  });
});

describe("sessionCodec", () => {
  it("round-trips the OpenCode session identity", () => {
    const serialized = sessionCodec.serialize({
      opencodeSessionId: "ses_1",
      sessionKey: "paperclip:run:r1",
      strategy: "run",
      directory: "/workspace",
      apiVersion: "v1",
      version: "1.18.35",
    });
    expect(serialized).toEqual({
      opencodeSessionId: "ses_1",
      sessionKey: "paperclip:run:r1",
      strategy: "run",
      directory: "/workspace",
      apiVersion: "v1",
      version: "1.18.35",
    });
    expect(sessionCodec.deserialize(serialized)).toEqual(serialized);
    expect(sessionCodec.getDisplayId?.(serialized)).toBe("ses_1");
  });

  it("rejects state without a session id", () => {
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });
});

describe("shouldResumeStoredSession", () => {
  const stored = {
    opencodeSessionId: "ses_1",
    sessionKey: "paperclip:run:r1",
    strategy: "issue" as const,
    directory: "/workspace",
    apiVersion: "v1" as const,
    version: "1.18.35",
  };

  it("resumes a stable strategy when the work-key matches", () => {
    expect(
      shouldResumeStoredSession({ stored, strategy: "issue", sessionKey: "paperclip:run:r1", apiVersion: "auto" }),
    ).toBe(true);
  });

  it("does not resume a mismatched work-key, run scope, or changed family", () => {
    expect(
      shouldResumeStoredSession({ stored, strategy: "issue", sessionKey: "other", apiVersion: "auto" }),
    ).toBe(false);
    expect(
      shouldResumeStoredSession({ stored, strategy: "run", sessionKey: "paperclip:run:r1", apiVersion: "auto" }),
    ).toBe(false);
    expect(
      shouldResumeStoredSession({ stored, strategy: "issue", sessionKey: "paperclip:run:r1", apiVersion: "v2" }),
    ).toBe(false);
  });
});
