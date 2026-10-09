import { describe, expect, it } from "vitest";
import {
  allowsUnsupportedOpenCodeVersion,
  parseOpenCodeCliVersion,
  unsupportedOpenCodeVersionMessage,
} from "./version.js";

describe("parseOpenCodeCliVersion", () => {
  it("parses a bare semantic version", () => {
    expect(parseOpenCodeCliVersion("1.18.34")).toMatchObject({
      version: "1.18.34",
      major: 1,
      minor: 18,
      patch: 34,
      supported: true,
    });
  });

  it("extracts the version from prefixed CLI output", () => {
    expect(parseOpenCodeCliVersion("opencode 1.18.34\n")).toMatchObject({
      version: "1.18.34",
      supported: true,
    });
  });

  it("flags a newer major as unsupported", () => {
    expect(parseOpenCodeCliVersion("2.0.1")).toMatchObject({
      version: "2.0.1",
      major: 2,
      supported: false,
    });
  });

  it("returns null when no version is present", () => {
    expect(parseOpenCodeCliVersion("")).toBeNull();
    expect(parseOpenCodeCliVersion("command not found")).toBeNull();
    expect(parseOpenCodeCliVersion(null)).toBeNull();
    expect(parseOpenCodeCliVersion(undefined)).toBeNull();
  });
});

describe("unsupportedOpenCodeVersionMessage", () => {
  it("names the qualified version and the remediation", () => {
    const message = unsupportedOpenCodeVersionMessage("2.0.1");
    expect(message).toContain("OpenCode 2.0.1 is not supported");
    expect(message).toContain("1.18.34");
    expect(message).toContain("--version 1.18.34");
    expect(message).toContain("PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION=1");
  });
});

describe("allowsUnsupportedOpenCodeVersion", () => {
  it("honours only truthy flag values", () => {
    expect(
      allowsUnsupportedOpenCodeVersion({
        PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "1",
      }),
    ).toBe(true);
    expect(
      allowsUnsupportedOpenCodeVersion({
        PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "true",
      }),
    ).toBe(true);
    expect(
      allowsUnsupportedOpenCodeVersion({
        PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "0",
      }),
    ).toBe(false);
    expect(allowsUnsupportedOpenCodeVersion({})).toBe(false);
  });
});
