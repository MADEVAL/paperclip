import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  QUALIFIED_OPENCODE_VERSION,
  SUPPORTED_OPENCODE_MAJOR_VERSION,
} from "../index.js";

const OPENCODE_VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

export interface OpenCodeCliVersion {
  /** Normalized `major.minor.patch`. */
  version: string;
  major: number;
  minor: number;
  patch: number;
  /** Whether Paperclip's `opencode_local` adapter qualifies this version. */
  supported: boolean;
}

/**
 * Extract the first semantic version from arbitrary `opencode --version` output.
 * Returns null when no `major.minor.patch` is present so a probe that cannot
 * report a version is treated as "unknown" rather than "unsupported".
 */
export function parseOpenCodeCliVersion(
  raw: string | null | undefined,
): OpenCodeCliVersion | null {
  if (typeof raw !== "string") return null;
  const match = OPENCODE_VERSION_PATTERN.exec(raw);
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  const patch = Number.parseInt(match[3]!, 10);
  if (![major, minor, patch].every((value) => Number.isSafeInteger(value))) {
    return null;
  }
  return {
    version: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
    supported: major === SUPPORTED_OPENCODE_MAJOR_VERSION,
  };
}

export function unsupportedOpenCodeVersionMessage(
  version: OpenCodeCliVersion | string,
): string {
  const value = typeof version === "string" ? version : version.version;
  return (
    `OpenCode ${value} is not supported by the opencode_local adapter. ` +
    `Paperclip qualifies OpenCode ${QUALIFIED_OPENCODE_VERSION}. ` +
    `Install it with \`curl -fsSL https://opencode.ai/install | bash -s -- --version ${QUALIFIED_OPENCODE_VERSION}\`, ` +
    `or point the agent "command" at a ${SUPPORTED_OPENCODE_MAJOR_VERSION}.x binary. ` +
    `Set PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION=1 to bypass this guard for an unverified run.`
  );
}

/**
 * Best-effort `opencode --version` probe. A probe that cannot spawn or that
 * reports no parseable version returns null; callers treat null as "unknown"
 * and never fail a run on it, because the run invocation is authoritative.
 */
export async function probeOpenCodeCliVersion(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
}): Promise<OpenCodeCliVersion | null> {
  try {
    const result = await runChildProcess(
      `opencode-version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      input.command,
      ["--version"],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec ?? 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    return parseOpenCodeCliVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}

/** True when the caller explicitly opts out of the version guard. */
export function allowsUnsupportedOpenCodeVersion(
  env: Record<string, string>,
): boolean {
  const value = (
    env.PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION ??
    process.env.PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION
  )?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
