const SENSITIVE_KEY_PATTERN =
  /(^|[_\-.])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key|credential)([_\-.]|$)/i;
const BASIC_AUTH_PATTERN = /(Basic\s+)([A-Za-z0-9+/=]+)/gi;
const HEADER_LINE_PATTERN = /((?:authorization|open[-_]?code|api[_-]?key|token|password)\s*[:=]\s*)(\S+)/gi;

export type TextRedactor = (value: string) => string;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BASIC_AUTH_PATTERN, "$1[redacted]")
    .replace(HEADER_LINE_PATTERN, "$1[redacted]");
}

export function createTextRedactor(
  secrets: Array<string | null | undefined>,
): TextRedactor {
  const exactSecrets = [
    ...new Set(
      secrets.filter(
        (secret): secret is string => typeof secret === "string" && secret.length >= 4,
      ),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({ secret, regex: new RegExp(escapeRegExp(secret), "g") }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

export function truncateForLog(value: string, maxChars = 500): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

export function redactForLog(
  value: unknown,
  keyPath: string[] = [],
  depth = 0,
  redactText: TextRedactor = sanitizeSensitiveText,
): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    return truncateForLog(redactText(value));
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value
      .slice(0, 40)
      .map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

export function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
