import { expect, it } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { isTypesafeConnection } from "./TypesafePurposes";

const shape = (patch: Partial<ToolConnection>): ToolConnection => ({ ...patch } as ToolConnection);

it("recognizes only the agent-facing TypeSafe tool connector", () => {
  expect(isTypesafeConnection(shape({ config: { sourceTemplateKey: "typesafe" }, connectionPurpose: "tool", transport: "rest_api" }))).toBe(true);
  // A direct TypeSafe decision connection uses company-level purposes instead.
  expect(isTypesafeConnection(shape({ config: { sourceTemplateKey: "typesafe" }, connectionPurpose: "ai", transport: "runtime_auth" }))).toBe(false);
  expect(isTypesafeConnection(shape({ config: { sourceTemplateKey: "openai" }, connectionPurpose: "tool", transport: "rest_api" }))).toBe(false);
});
