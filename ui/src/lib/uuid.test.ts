import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files that may call the secure-context API directly because they guard it. */
const ALWAYS_ALLOWED = new Set(["lib/uuid.ts", "lib/cross-tab-poll.ts"]);
const ALLOWED_PREFIXES = ["lib/uuid.test.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe("createUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the browser UUID when the page is a secure context", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID });
    expect(createUuid()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("still returns a valid v4 UUID on a plain-HTTP LAN origin without crypto.randomUUID", () => {
    // Chrome only exposes crypto.randomUUID in secure contexts, so an
    // http://<lan-ip>:3100 dashboard has getRandomValues but no randomUUID.
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index++) bytes[index] = index * 7;
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(createUuid()).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("keeps the insecure-context fallback behind the shared helper", () => {
    const offenders = sourceFiles(sourceRoot)
      .map((file) => path.relative(sourceRoot, file).replaceAll("\\", "/"))
      .filter((file) => !ALWAYS_ALLOWED.has(file) && !ALLOWED_PREFIXES.includes(file))
      .filter((file) => !file.includes(".test."))
      .filter((file) => readFileSync(path.join(sourceRoot, file), "utf8").includes("crypto.randomUUID()"));
    // A raw call throws on http://<lan-ip>:3100 and disables composer sends.
    expect(offenders).toEqual([]);
  });
});
