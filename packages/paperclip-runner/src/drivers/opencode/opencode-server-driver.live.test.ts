import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OpenCodeServerDriver } from "./opencode-server-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

/**
 * Live qualification smoke for the OpenCode V2 server API. It is skipped unless
 * `PAPERCLIP_OPENCODE_LIVE_BIN` points at a V2 `opencode` binary (for example
 * `2.0.26`). The fake provider only streams text, so this covers session
 * creation, the native V2 config reload, text streaming, usage, and the
 * terminal turn event. Permission/form flows are covered by the mocked server.
 */
const liveBinary = process.env.PAPERCLIP_OPENCODE_LIVE_BIN;

const TERMINAL = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.cancelled",
]);

async function collectTurn(events: AsyncIterable<PrpEvent>): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (TERMINAL.has(event.eventType)) break;
  }
  return collected;
}

function fakeProvider() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed: { model?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* probe requests */
      }
      const model = parsed.model ?? "fake-model";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (
        delta: Record<string, unknown>,
        finish: string | null = null,
      ) =>
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: "assistant", content: "" });
      chunk({ content: "Live V2 hello." });
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

describe.skipIf(!liveBinary)("live OpenCode V2 driver smoke", () => {
  it("runs a full turn against the qualified v2 binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-live-v2-driver-"));
    const provider = fakeProvider();
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerAddress = provider.address();
    if (!providerAddress || typeof providerAddress === "string")
      throw new Error("provider address missing");
    const providerPort = providerAddress.port;

    const driver = new OpenCodeServerDriver({
      model: "paperclip/fake-model",
      runtimeDirectory: root,
      command: liveBinary!,
      environment: {
        PATH: process.env.PATH,
        PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${providerPort}/v1`,
        PAPERCLIP_AI_PROVIDER_KEY: "live-key",
      },
    });
    let session:
      | Awaited<ReturnType<OpenCodeServerDriver["openSession"]>>
      | undefined;
    try {
      session = await driver.openSession({
        runId: "live-v2",
        normalizedSessionId: "live-v2",
        workingDirectory: root,
      });
      await session.startTurn({ message: { role: "user", text: "say hi" } });
      const events = await collectTurn(session.events());
      const types = events.map((event) => event.eventType);
      expect(types).toContain("turn.completed");
      expect(
        events.filter((event) => event.eventType === "item.delta").length,
      ).toBeGreaterThan(0);
      expect(await session.usage()).toMatchObject({ input: 7, output: 8 });
    } finally {
      await session?.close({ reason: "cleanup" }).catch(() => {});
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
        provider.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
