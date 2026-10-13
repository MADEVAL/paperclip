import { describe, expect, it } from "vitest";
import {
  DECISION_FEATURE_CATALOG,
  DECISION_FEATURE_IDS,
  TYPESAFE_PURPOSE_IDS,
  decisionFeatureDefinition,
  decisionFeatureLabel,
  decisionFeaturesForPurpose,
} from "./index.js";

describe("company decision feature catalog", () => {
  it("keeps ids unique, stable, and every purpose a real TypeSafe purpose", () => {
    expect(new Set(DECISION_FEATURE_IDS).size).toBe(DECISION_FEATURE_CATALOG.length);
    for (const entry of DECISION_FEATURE_CATALOG) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9_.-]{0,99}$/);
      expect(TYPESAFE_PURPOSE_IDS).toContain(entry.purpose);
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.confidence).toBeGreaterThan(0);
      expect(entry.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("covers the shipped feature and the rollout without duplicates", () => {
    expect(DECISION_FEATURE_IDS).toEqual([
      "issues.classify",
      "issues.dedupe",
      "issues.triage",
      "plans.gate",
      "qa.acceptance",
    ]);
  });

  it("labels a product feature, the setup test, and an unknown id distinctly", () => {
    expect(decisionFeatureLabel("issues.classify")).toBe("Issue priority");
    expect(decisionFeatureLabel("settings.test")).toBe("Setup test");
    expect(decisionFeatureLabel("future.feature")).toBe("future.feature");
  });

  it("groups features by the purpose that enables them", () => {
    expect(decisionFeaturesForPurpose("issue_triage").map((entry) => entry.id)).toEqual([
      "issues.dedupe",
      "issues.triage",
    ]);
    expect(decisionFeaturesForPurpose("task_planning").map((entry) => entry.id)).toEqual([
      "plans.gate",
    ]);
    expect(decisionFeaturesForPurpose("guardrails")).toEqual([]);
    expect(decisionFeatureDefinition("plans.gate")).toMatchObject({
      purpose: "task_planning",
      background: true,
      fallback: "current-behaviour",
    });
    expect(decisionFeatureDefinition("missing")).toBeNull();
  });
});
