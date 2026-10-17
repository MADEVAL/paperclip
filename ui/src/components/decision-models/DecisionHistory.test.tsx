// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DecisionHistoryTable } from "./DecisionHistory";
import { entry } from "../../../storybook/support/decision-models/fixtures";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACM" } }),
}));

describe("decision history feature labels", () => {
  it.each([
    ["issues.dedupe", "Duplicate check"],
    ["settings.test", "Setup test"],
    ["future.feature", "future.feature"],
  ])("shows %s as %s", (feature, label) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<MemoryRouter><DecisionHistoryTable entries={[{ ...entry, feature }]} /></MemoryRouter>));
      expect(container.textContent).toContain(label);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe("model history setup links", () => {
  it.each([
    [false, true, "/ACM/company/settings/connections", "Configure a decision model"],
    [false, false, "/ACM/company/settings", "Configure a decision model"],
    [true, true, "/ACM/company/settings/connections", "Configure fast response"],
    [true, false, "/ACM/company/settings/instance/experimental", "Enable experimental fast responses"],
  ] as const)("routes setup with fast response %s and experiment %s", (fastResponse, connectionsEnabled, href, label) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(
        <MemoryRouter>
          <DecisionHistoryTable entries={[]} fastResponse={fastResponse} connectionsEnabled={connectionsEnabled} />
        </MemoryRouter>,
      ));
      expect(container.querySelector("a")?.getAttribute("href")).toBe(href);
      expect(container.querySelector("a")?.textContent).toBe(label);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
