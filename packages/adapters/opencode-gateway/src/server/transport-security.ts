import { INSECURE_REMOTE_HTTP_ESCAPE_HATCH } from "../shared/constants.js";

export { INSECURE_REMOTE_HTTP_ESCAPE_HATCH };

export function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    value === "127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

export function isPrivateNetworkHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // RFC1918 / link-local / CGNAT IPv4, plus IPv6 ULA and link-local.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
}

export function isRemotePlainHttp(url: URL): boolean {
  return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
}

export function allowsInsecureRemoteHttp(config: Record<string, unknown>): boolean {
  return parseBooleanLike(config[INSECURE_REMOTE_HTTP_ESCAPE_HATCH]) === true;
}

export function remotePlainHttpDeniedMessage(hostname: string): string {
  return (
    `OpenCode gateway apiBaseUrl uses remote plain HTTP for "${hostname}". ` +
    `Use HTTPS or a private overlay network, or set ${INSECURE_REMOTE_HTTP_ESCAPE_HATCH}=true ` +
    `only for unsafe local development.`
  );
}
