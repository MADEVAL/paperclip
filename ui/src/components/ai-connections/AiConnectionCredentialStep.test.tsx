// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { create: vi.fn(async () => ({ connectionId: "connection", grantId: "grant" })) } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders the TypeSafe API-key card for the direct Jev decision provider", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <AiConnectionCredentialStep companyId="company" provider="typesafe" fixedMethod initialMethod="api_key"
        name="My TypeSafe API" ownership="shared" agentIds={[]} allAgents onComplete={vi.fn()} onCancel={vi.fn()} />
    </QueryClientProvider>));
    // The API-key card proves the step did not fall through to the OpenAI/Codex
    // subscription chrome that a mismatched provider would render.
    expect(container.textContent).toContain("Provide your TypeSafe API key to connect");
    expect(container.textContent).not.toContain("OpenAI");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
