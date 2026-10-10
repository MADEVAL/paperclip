import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  readPaperclipIssueWorkModeFromContext,
  selectPaperclipPromptSections,
  stringifyPaperclipWakePayload,
  paperclipWakeCommentsArePromptOwned,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

export interface GatewayPrompt {
  prompt: string;
  wakePayloadJson: string | null;
  paperclipEnv: Record<string, string>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolvePaperclipApiUrlOverride(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function runtimeToolsLines(runtimeTools: AdapterExecutionContext["runtimeTools"]): string[] {
  if (!runtimeTools) return [];
  return [
    "Paperclip runtime tools (delivered as invocation context; the gateway host owns the harness):",
    runtimeTools.guidance,
    "Connect the Paperclip remote MCP server to your OpenCode session for this run:",
    `- MCP endpoint: ${runtimeTools.mcpEndpoint}`,
    `- Bearer token: ${runtimeTools.bearerToken}`,
    `- Available tools: ${runtimeTools.tools.join(", ")}`,
    `- Connections search REST: ${runtimeTools.rest.connectionsSearch}`,
    `- Connection request REST: ${runtimeTools.rest.connectionRequest}`,
    `- Token expiry: ${runtimeTools.expiresAt}`,
    "Do not print or persist the token. A gateway host must not know the Paperclip API key.",
  ];
}

/**
 * Build the wake prompt for one OpenCode gateway run.
 *
 * Because the gateway owns the harness and Paperclip does not inject environment
 * variables or a materialized MCP config, everything the agent needs for the run
 * — identity, execution contract, wake context, and runtime-tool guidance —
 * travels in the prompt text.
 */
export function buildGatewayPrompt(
  ctx: AdapterExecutionContext,
  opts: { paperclipApiUrl: string | null; resumedSession: boolean },
): GatewayPrompt {
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
    PAPERCLIP_RUN_ID: ctx.runId,
  };
  if (opts.paperclipApiUrl) paperclipEnv.PAPERCLIP_API_URL = opts.paperclipApiUrl;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  if (issueWorkMode) paperclipEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;

  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(ctx.context, {
    resumedSession: opts.resumedSession,
    includeExecutionContract: false,
  });
  const wakePayloadJson = paperclipWakeCommentsArePromptOwned(ctx.context)
    ? null
    : stringifyPaperclipWakePayload(ctx.context.paperclipWake, {
        omitIssueDescription: Boolean(taskContextNote),
      });
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const recovery = isPaperclipRecoveryWakePayload(ctx.context.paperclipWake);
  const conversationMode = ctx.context.conversationMode === true;

  const lines: string[] = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    ...(opts.paperclipApiUrl ? [`- Paperclip API URL: ${opts.paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
  ];

  if (!conversationMode && !recovery) {
    lines.push(
      "Execution contract:",
      "- Take concrete action in this run when the task is actionable.",
      "- Do not stop at a plan unless the issue asks for planning only.",
      "- Leave durable progress and update the issue to a clear final disposition.",
      "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
      "",
    );
  }

  lines.push(wakePrompt);
  if (sessionHandoff) lines.push("", sessionHandoff);
  if (taskContextNote) lines.push("", taskContextNote);
  if (wakePayloadJson) {
    lines.push("", "Structured wake payload JSON:", "```json", wakePayloadJson, "```");
  }
  const tools = runtimeToolsLines(ctx.runtimeTools);
  if (tools.length > 0) lines.push("", ...tools);

  return {
    prompt: lines.filter((line) => line !== null && line !== undefined).join("\n").trim(),
    wakePayloadJson,
    paperclipEnv,
  };
}
