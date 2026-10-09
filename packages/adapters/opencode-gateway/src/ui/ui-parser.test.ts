import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The UI parser is evaluated by Paperclip in a sandboxed worker via
 * `new Function("exports", "module", "self", "globalThis", source)`. This test
 * pins that contract: zero imports, CJS exports, and the transcript shapes.
 */
function loadUiParser(): { parseStdoutLine: (line: string, ts: string) => unknown[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.resolve(here, "../../ui-parser.cjs"), "utf-8");
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const factory = new Function("exports", "module", "self", "globalThis", `"use strict";\n{\n${source}\n}`);
  factory(exports, module, undefined, undefined);
  const resolved = Object.keys(module.exports).length > 0 ? module.exports : exports;
  return resolved as { parseStdoutLine: (line: string, ts: string) => unknown[] };
}

const ts = "2026-01-01T00:00:00.000Z";

describe("ui-parser.cjs", () => {
  it("exports a usable parseStdoutLine with no imports", () => {
    const parser = loadUiParser();
    expect(typeof parser.parseStdoutLine).toBe("function");
  });

  it("parses assistant text and tool events", () => {
    const parser = loadUiParser();
    const text = `[opencode-gateway:event] session=ses_1 event=message.part.updated data=${JSON.stringify({
      properties: { part: { id: "p1", type: "text", text: "hi" } },
    })}`;
    expect(parser.parseStdoutLine(text, ts)).toEqual([{ kind: "assistant", ts, text: "hi" }]);

    const tool = `[opencode-gateway:event] session=ses_1 event=message.part.updated data=${JSON.stringify({
      properties: { part: { id: "t1", callID: "c1", type: "tool", tool: "bash", state: { status: "completed", output: "ok" } } },
    })}`;
    expect(parser.parseStdoutLine(tool, ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "c1", content: "ok", isError: false },
    ]);
  });

  it("falls back to stdout and system lines", () => {
    const parser = loadUiParser();
    expect(parser.parseStdoutLine("plain", ts)).toEqual([{ kind: "stdout", ts, text: "plain" }]);
    expect(parser.parseStdoutLine("[opencode-gateway] note", ts)).toEqual([{ kind: "system", ts, text: "note" }]);
  });
});
