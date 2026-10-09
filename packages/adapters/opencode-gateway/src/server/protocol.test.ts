import { describe, expect, it } from "vitest";
import {
  classifyOpenCodeServerInfo,
  compareOpenCodeVersions,
  isQualifiedOpenCodeVersion,
  isSemanticVersion,
  normalizeApiVersionOverride,
  openCodeApiVersionForVersion,
  qualifiedOpenCodeWindows,
} from "./protocol.js";

describe("openCodeApiVersionForVersion", () => {
  it("classifies major 1 as v1 and major 2 as v2", () => {
    expect(openCodeApiVersionForVersion("1.18.35")).toBe("v1");
    expect(openCodeApiVersionForVersion("2.0.26")).toBe("v2");
  });

  it("rejects non-semantic and unqualified majors", () => {
    expect(openCodeApiVersionForVersion("nope")).toBeNull();
    expect(openCodeApiVersionForVersion("3.0.0")).toBeNull();
  });
});

describe("isQualifiedOpenCodeVersion", () => {
  it("admits the qualified windows including 1.18.35", () => {
    expect(isQualifiedOpenCodeVersion("1.18.34")).toBe(true);
    expect(isQualifiedOpenCodeVersion("1.18.35")).toBe(true);
    expect(isQualifiedOpenCodeVersion("1.99.99")).toBe(true);
    expect(isQualifiedOpenCodeVersion("2.0.0")).toBe(true);
    expect(isQualifiedOpenCodeVersion("2.0.26")).toBe(true);
  });

  it("rejects versions outside the windows", () => {
    expect(isQualifiedOpenCodeVersion("1.18.33")).toBe(false);
    expect(isQualifiedOpenCodeVersion("2.1.0")).toBe(false);
    expect(isQualifiedOpenCodeVersion("3.0.0")).toBe(false);
  });
});

describe("qualification helpers", () => {
  it("compares versions numerically", () => {
    expect(compareOpenCodeVersions("1.18.10", "1.18.9")).toBeGreaterThan(0);
    expect(compareOpenCodeVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareOpenCodeVersions("1.18.35", "1.18.35")).toBe(0);
  });

  it("recognizes semantic versions", () => {
    expect(isSemanticVersion("1.18.35")).toBe(true);
    expect(isSemanticVersion("1.18")).toBe(false);
    expect(isSemanticVersion("v1.18.35")).toBe(false);
  });

  it("lists both windows", () => {
    expect(qualifiedOpenCodeWindows()).toContain("1.18.34 <= v < 2.0.0");
    expect(qualifiedOpenCodeWindows()).toContain("2.0.0 <= v < 2.1.0");
  });
});

describe("classifyOpenCodeServerInfo", () => {
  it("normalizes a valid version payload", () => {
    expect(classifyOpenCodeServerInfo({ version: "2.0.26", apiVersion: "v2" })).toEqual({
      version: "2.0.26",
      apiVersion: "v2",
    });
  });

  it("returns null for a non-semantic version", () => {
    expect(classifyOpenCodeServerInfo({ version: "nope", apiVersion: "v1" })).toBeNull();
  });
});

describe("normalizeApiVersionOverride", () => {
  it("maps recognized overrides and defaults to auto", () => {
    expect(normalizeApiVersionOverride("v1")).toBe("v1");
    expect(normalizeApiVersionOverride("2")).toBe("v2");
    expect(normalizeApiVersionOverride("anything")).toBe("auto");
    expect(normalizeApiVersionOverride(undefined)).toBe("auto");
  });
});
