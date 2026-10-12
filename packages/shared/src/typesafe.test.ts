import { describe, expect, it } from "vitest";
import {
  enabledTypesafePurposes,
  isTypesafePurposeAllowed,
  TYPESAFE_PURPOSE_IDS,
  typesafeAskSchema,
} from "./typesafe.js";

const ask = (questions: unknown) => ({ state: "text", questions });

describe("typesafeAskSchema", () => {
  it("accepts the three question types", () => {
    const parsed = typesafeAskSchema.parse(
      ask({
        urgent: { type: "noul", instructions: "Urgent?", criteria: { true: "yes", false: "no" } },
        team: { type: "choice", instructions: "Team?", criteria: { billing: "Payments", sales: null } },
        mood: { type: "score", instructions: { question: "Mood?" }, criteria: ["Calm", "Angry"] },
      }),
    );
    expect(Object.keys(parsed.questions)).toEqual(["urgent", "team", "mood"]);
  });

  it("accepts structured state and an explicit model and connection", () => {
    const parsed = typesafeAskSchema.parse({
      ...ask({ q: { type: "noul", instructions: "?" } }),
      state: [{ a: 1 }],
      model: "jev-preview",
      connectionId: "5b0e9d0c-3c1b-4a53-9d0e-6a1f6f0f6a11",
    });
    expect(parsed.model).toBe("jev-preview");
  });

  it.each([
    ["no questions", {}],
    ["unknown type", { q: { type: "essay", instructions: "?" } }],
    ["one score level", { q: { type: "score", instructions: "?", criteria: ["only"] } }],
    ["eleven score levels", { q: { type: "score", instructions: "?", criteria: Array(11).fill("x") } }],
    ["empty choice", { q: { type: "choice", instructions: "?", criteria: {} } }],
    [
      "256 choice options",
      {
        q: {
          type: "choice",
          instructions: "?",
          criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])),
        },
      },
    ],
    ["unknown field", { q: { type: "noul", instructions: "?", extra: 1 } }],
  ])("rejects %s", (_name, questions) => {
    expect(typesafeAskSchema.safeParse(ask(questions)).success).toBe(false);
  });

  it("rejects a missing state", () => {
    expect(
      typesafeAskSchema.safeParse({ questions: { q: { type: "noul", instructions: "?" } } }).success,
    ).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    expect(
      typesafeAskSchema.safeParse({ ...ask({ q: { type: "noul", instructions: "?" } }), apiKey: "x" }).success,
    ).toBe(false);
  });

  it("accepts a known purpose and rejects an unknown one", () => {
    expect(typesafeAskSchema.safeParse({ ...ask({ q: { type: "noul", instructions: "?" } }), purpose: "issue_triage" }).success).toBe(true);
    expect(typesafeAskSchema.safeParse({ ...ask({ q: { type: "noul", instructions: "?" } }), purpose: "freestyle" }).success).toBe(false);
  });

  it("reads enabled purposes from a connection's methodConfig", () => {
    expect(TYPESAFE_PURPOSE_IDS).toContain("issue_triage");
    expect(enabledTypesafePurposes({ purposeIssueTriage: true, purposePriority: false })).toEqual(["issue_triage"]);
    expect(isTypesafePurposeAllowed({ purposeIssueTriage: true }, "issue_triage")).toBe(true);
    expect(isTypesafePurposeAllowed({ purposeIssueTriage: false }, "issue_triage")).toBe(false);
    expect(isTypesafePurposeAllowed(undefined, undefined)).toBe(true);
  });
});
