import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseEventLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(/^\[opencode-gateway:event\]\s+session=([^\s]+)\s+event=([^\s]+)\s+data=(.*)$/s);
  if (!match) return [{ kind: "stdout", ts, text: line }];

  const eventType = asString(match[2]).toLowerCase();
  const data = asRecord(safeJsonParse(asString(match[3]).trim()));

  if (eventType === "session.error") {
    const properties = asRecord(data?.properties) ?? asRecord(data);
    const error = asRecord(properties?.error);
    const message =
      asString(error?.message) ||
      asString(properties?.message) ||
      asString(properties?.error) ||
      "OpenCode session failed";
    return [{ kind: "stderr", ts, text: message }];
  }

  if (eventType === "message.part.updated") {
    const properties = asRecord(data?.properties) ?? asRecord(data);
    const part = asRecord(properties?.part);
    if (!part) return [];
    const partType = asString(part.type).toLowerCase();
    if (partType === "text" || partType === "reasoning") {
      const text = asString(part.text);
      if (!text) return [];
      return [{ kind: partType === "reasoning" ? "thinking" : "assistant", ts, text }];
    }
    if (partType === "tool") {
      const state = asRecord(part.state) ?? {};
      const toolUseId = asString(part.callID) || asString(part.id);
      const name = asString(part.tool) || asString(part.name) || "tool";
      const status = asString(state.status).toLowerCase();
      if (status === "completed") {
        return [{
          kind: "tool_result",
          ts,
          toolUseId,
          content: typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? ""),
          isError: false,
        }];
      }
      if (status === "error") {
        return [{
          kind: "tool_result",
          ts,
          toolUseId,
          content: asString(state.error) || "OpenCode tool call failed",
          isError: true,
        }];
      }
      if (status === "running") {
        return [{ kind: "tool_call", ts, name, input: state.input ?? {}, toolUseId }];
      }
    }
    return [];
  }

  return [];
}

export function parseOpenCodeGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[opencode-gateway:event]")) {
    return parseEventLine(trimmed, ts);
  }

  if (trimmed.startsWith("[opencode-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[opencode-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
