/**
 * Self-contained UI transcript parser for the opencode_gateway adapter.
 *
 * Contract: `paperclip.adapterUiParser` 1.0.0. The Paperclip UI evaluates this
 * source inside a sandboxed worker via `new Function("exports", "module", ...)`,
 * so it must be plain CJS with zero imports, no DOM/Node APIs, and no side
 * effects beyond assigning `exports`.
 */
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function parseEventLine(line, ts) {
  var match = line.match(
    /^\[opencode-gateway:event\]\s+session=([^\s]+)\s+event=([^\s]+)\s+data=(.*)$/s
  );
  if (!match) return [{ kind: "stdout", ts: ts, text: line }];

  var eventType = asString(match[2]).toLowerCase();
  var data = asRecord(safeJsonParse(asString(match[3]).trim()));

  if (eventType === "session.error") {
    var properties = asRecord(data && data.properties) || asRecord(data) || {};
    var error = asRecord(properties.error);
    var message =
      asString(error && error.message) ||
      asString(properties.message) ||
      asString(properties.error) ||
      "OpenCode session failed";
    return [{ kind: "stderr", ts: ts, text: message }];
  }

  if (eventType === "message.part.updated") {
    var props = asRecord(data && data.properties) || asRecord(data);
    var part = asRecord(props && props.part);
    if (!part) return [];
    var partType = asString(part.type).toLowerCase();
    if (partType === "text" || partType === "reasoning") {
      var text = asString(part.text);
      if (!text) return [];
      return [{ kind: partType === "reasoning" ? "thinking" : "assistant", ts: ts, text: text }];
    }
    if (partType === "tool") {
      var state = asRecord(part.state) || {};
      var toolUseId = asString(part.callID) || asString(part.id);
      var name = asString(part.tool) || asString(part.name) || "tool";
      var status = asString(state.status).toLowerCase();
      if (status === "completed") {
        return [{
          kind: "tool_result",
          ts: ts,
          toolUseId: toolUseId,
          content: typeof state.output === "string" ? state.output : JSON.stringify(state.output == null ? "" : state.output),
          isError: false,
        }];
      }
      if (status === "error") {
        return [{
          kind: "tool_result",
          ts: ts,
          toolUseId: toolUseId,
          content: asString(state.error) || "OpenCode tool call failed",
          isError: true,
        }];
      }
      if (status === "running") {
        return [{ kind: "tool_call", ts: ts, name: name, input: state.input == null ? {} : state.input, toolUseId: toolUseId }];
      }
    }
    return [];
  }

  return [];
}

function parseStdoutLine(line, ts) {
  var trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return [];

  if (trimmed.indexOf("[opencode-gateway:event]") === 0) {
    return parseEventLine(trimmed, ts);
  }

  if (trimmed.indexOf("[opencode-gateway]") === 0) {
    return [{ kind: "system", ts: ts, text: trimmed.replace(/^\[opencode-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts: ts, text: line }];
}

exports.parseStdoutLine = parseStdoutLine;
