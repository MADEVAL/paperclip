import { describe, expect, it } from "vitest";
import { defineDecisionFeature } from "../services/decision-models.js";
import { answerConfidence, decisionFeatureStatuses, decisionGuidance } from "../services/decision-features.js";

describe("decision feature registry", () => {
  it("carries the shared catalog label and confidence and is frozen", () => {
    const feature = defineDecisionFeature("issues.classify", { background: true, purpose: "priority" });
    expect(feature).toMatchObject({
      id: "issues.classify", background: true, purpose: "priority", label: "Issue priority", confidence: 0.7,
    });
    expect(Object.isFrozen(feature)).toBe(true);
  });

  it("refuses a catalog feature whose purpose, background, or confidence drifts", () => {
    expect(() => defineDecisionFeature("issues.classify", { background: true, purpose: "guardrails" })).toThrow(/purpose/);
    expect(() => defineDecisionFeature("issues.classify", { background: false, purpose: "priority" })).toThrow(/background/);
    expect(() => defineDecisionFeature("issues.classify", { background: true, purpose: "priority", confidence: 0.5 })).toThrow(/confidence/);
    // A server-sweep feature must stay company-sponsored (background) to run as a system actor.
    expect(() => defineDecisionFeature("issues.triage", { background: false, purpose: "issue_triage" })).toThrow(/background/);
    // A resolver-gated feature must not be sponsored as background.
    expect(() => defineDecisionFeature("qa.acceptance", { background: true, purpose: "qa_acceptance" })).toThrow(/background/);
  });

  it("allows an internal feature outside the catalog and rejects a malformed id or purpose", () => {
    expect(defineDecisionFeature("test.internal", { background: true }))
      .toMatchObject({ id: "test.internal", background: true, purpose: null, confidence: 0 });
    expect(() => defineDecisionFeature("Bad Id")).toThrow(/identifier/);
    expect(() => defineDecisionFeature("test.bad", { purpose: "not_a_purpose" as never })).toThrow(/purpose/);
  });
});

describe("decision feature presentation", () => {
  it("advertises only registered features and marks purpose enablement", () => {
    const statuses = decisionFeatureStatuses({ priority: true, issue_triage: false });
    expect(statuses.map((entry) => entry.id)).toEqual(["issues.classify", "issues.dedupe", "issues.triage", "plans.gate", "qa.acceptance"]);
    expect(statuses.map((entry) => entry.enabled)).toEqual([true, false, false, false, false]);
    expect(statuses[0]).toMatchObject({ label: "Issue priority", purpose: "priority", background: true, confidence: 0.7 });
    expect(decisionFeatureStatuses()[0]?.enabled).toBe(false);
  });

  it("ranks an answer's confidence and treats a missing answer as no confidence", () => {
    expect(answerConfidence(undefined)).toBe(0);
    expect(answerConfidence({ type: "boolean", probability: 0.8 })).toBe(0.8);
    expect(answerConfidence({ type: "choice", choice: "duplicate", confidence: 0.9 })).toBe(0.9);
    expect(answerConfidence({ type: "score", score: 1 })).toBe(0);
  });

  it("gates guidance on an available decision path and names the agent path only for TypeSafe", () => {
    expect(decisionGuidance({ provider: null, purposes: [] })).toBeNull();
    const typesafe = decisionGuidance({ provider: "typesafe", purposes: ["priority"] });
    expect(typesafe).toContain("Calibrated decision service");
    expect(typesafe).toContain("priority");
    expect(typesafe).toContain("typesafe_ask");
    const openai = decisionGuidance({ provider: "openai", purposes: [] });
    expect(openai).toContain("Calibrated decision service");
    expect(openai).not.toContain("typesafe_ask");
  });
});
