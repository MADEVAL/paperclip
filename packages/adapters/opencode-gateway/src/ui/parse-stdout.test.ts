import { describe, expect, it } from "vitest";
import { parseOpenCodeGatewayStdoutLine } from "./parse-stdout.js";

const ts = "2026-01-01T00:00:00.000Z";

describe("parseOpenCodeGatewayStdoutLine", () => {
  it("renders assistant text deltas", () => {
    const line = `[opencode-gateway:event] session=ses_1 event=message.part.updated data=${JSON.stringify({
      properties: { part: { id: "p1", type: "text", text: "hello" } },
    })}`;
    expect(parseOpenCodeGatewayStdoutLine(line, ts)).toEqual([{ kind: "assistant", ts, text: "hello" }]);
  });

  it("renders reasoning parts as thinking", () => {
    const line = `[opencode-gateway:event] session=ses_1 event=message.part.updated data=${JSON.stringify({
      properties: { part: { id: "r1", type: "reasoning", text: "hmm" } },
    })}`;
    expect(parseOpenCodeGatewayStdoutLine(line, ts)).toEqual([{ kind: "thinking", ts, text: "hmm" }]);
  });

  it("renders tool calls and results", () => {
    const running = `[opencode-gateway:event] session=ses_1 event=message.part.updated data=${JSON.stringify({
      properties: { part: { id: "t1", callID: "call-1", type: "tool", tool: "bash", state: { status: "running", input: { cmd: "ls" } } } },
    })}`;
    expect(parseOpenCodeGatewayStdoutLine(running, ts)).toEqual([
      { kind: "tool_call", ts, name: "bash", input: { cmd: "ls" }, toolUseId: "call-1" },
    ]);

    const done = `[opencode-gateway:event] session=ses_1 event=message.part.updated data=${JSON.stringify({
      properties: { part: { id: "t1", callID: "call-1", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } } },
    })}`;
    expect(parseOpenCodeGatewayStdoutLine(done, ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "call-1", content: "ok", isError: false },
    ]);
  });

  it("renders session errors as stderr and lifecycle lines as system", () => {
    const errorLine = `[opencode-gateway:event] session=ses_1 event=session.error data=${JSON.stringify({
      properties: { error: { message: "boom" } },
    })}`;
    expect(parseOpenCodeGatewayStdoutLine(errorLine, ts)).toEqual([{ kind: "stderr", ts, text: "boom" }]);
    expect(parseOpenCodeGatewayStdoutLine("[opencode-gateway] connected", ts)).toEqual([
      { kind: "system", ts, text: "connected" },
    ]);
  });

  it("falls back to stdout for unknown lines", () => {
    expect(parseOpenCodeGatewayStdoutLine("plain output", ts)).toEqual([{ kind: "stdout", ts, text: "plain output" }]);
  });
});
