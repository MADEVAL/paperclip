import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  ALLOW_UNQUALIFIED_VERSION_ENV,
} from "../shared/constants.js";
import { createOpenCodeApiClient, type OpenCodeApiClient, type OpenCodeTransport } from "./api-client.js";
import {
  allowsUnqualifiedOpenCodeGatewayVersion,
  isQualifiedOpenCodeVersion,
  unqualifiedOpenCodeVersionMessage,
  type OpenCodeApiVersion,
} from "./protocol.js";
import {
  apiUrl,
  createTransport,
  detectOpenCodeServerInfo,
  type OpenCodeConnection,
} from "./transport.js";
import {
  extractAssistantTextDelta,
  extractErrorEvent,
  extractEventUsage,
  extractPermissionRequest,
  extractQuestionRequest,
  isIdleEvent,
  parseEventData,
  parseSseFrames,
} from "./events.js";
import { parseGatewayConfig, resolveModelParts, type GatewayConfig } from "./config.js";
import { buildGatewayPrompt, resolvePaperclipApiUrlOverride } from "./prompt.js";
import {
  resolveSessionKey,
  shouldResumeStoredSession,
  type OpenCodeGatewaySessionState,
  type SessionKeyStrategy,
} from "./session.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";
import {
  createTextRedactor,
  redactForLog,
  stringifyForLog,
  type TextRedactor,
} from "./redact.js";

type TerminalState =
  | { kind: "idle" }
  | { kind: "error"; message: string };

interface ExecutionState {
  sessionId: string;
  outputChunks: string[];
  textByPartId: Map<string, string>;
  usage: UsageSummary | null;
  costUsd: number | null;
  model: string | null;
  provider: string | null;
  lastEventName: string | null;
  sawSessionEvent: boolean;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
  answeredPermissions: Set<string>;
  answeredQuestions: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

function buildAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function createExecutionState(sessionId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    sessionId,
    outputChunks: [],
    textByPartId: new Map(),
    usage: null,
    costUsd: null,
    model: null,
    provider: null,
    lastEventName: null,
    sawSessionEvent: false,
    terminal: null,
    resolveTerminal,
    terminalPromise,
    answeredPermissions: new Set(),
    answeredQuestions: new Set(),
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = terminal;
  state.resolveTerminal(terminal);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function sessionIdOfEvent(raw: unknown): string | null {
  const properties = asRecord(asRecord(raw)?.properties) ?? asRecord(asRecord(raw)?.data) ?? {};
  return (
    nonEmpty(properties.sessionID) ??
    nonEmpty(properties.sessionId) ??
    nonEmpty(asRecord(properties.info)?.sessionID) ??
    null
  );
}

async function handleEvent(input: {
  ctx: AdapterExecutionContext;
  client: OpenCodeApiClient;
  state: ExecutionState;
  raw: unknown;
  redactText: TextRedactor;
  permissionAction: GatewayConfig["permissionAction"];
  questionPolicy: GatewayConfig["questionPolicy"];
}): Promise<void> {
  const { ctx, client, state, raw, redactText } = input;
  const type = nonEmpty(asRecord(raw)?.type);
  state.lastEventName = type;
  const eventSessionId = sessionIdOfEvent(raw);
  if (eventSessionId && eventSessionId === state.sessionId) state.sawSessionEvent = true;

  await ctx.onLog(
    "stdout",
    `[opencode-gateway:event] session=${state.sessionId} event=${type ?? "message"} data=${stringifyForLog(redactForLog(raw, [], 0, redactText), 8_000)}\n`,
  );

  const delta = extractAssistantTextDelta(raw, state.textByPartId);
  if (delta) {
    const sanitized = redactText(delta.delta);
    state.outputChunks.push(sanitized);
    await ctx.onLog("stdout", sanitized);
  }

  const usage = extractEventUsage(raw);
  if (usage) {
    if (usage.usage) state.usage = usage.usage;
    if (usage.costUsd !== null && usage.costUsd !== undefined) state.costUsd = usage.costUsd;
    if (usage.model) state.model = usage.model;
    if (usage.provider) state.provider = usage.provider;
  }

  const permission = extractPermissionRequest(raw);
  if (permission && !state.answeredPermissions.has(permission.requestId)) {
    state.answeredPermissions.add(permission.requestId);
    const sessionId = permission.sessionId || state.sessionId;
    try {
      await client.replyPermission({
        sessionId,
        requestId: permission.requestId,
        action: input.permissionAction,
      });
      await ctx.onLog(
        "stdout",
        `[opencode-gateway] replied to permission ${permission.requestId} with ${input.permissionAction}\n`,
      );
    } catch (err) {
      await ctx.onLog("stderr", `[opencode-gateway] permission reply failed: ${redactText(errorString(err))}\n`);
    }
  }

  const question = extractQuestionRequest(raw);
  if (question && !state.answeredQuestions.has(question.requestId)) {
    state.answeredQuestions.add(question.requestId);
    const sessionId = question.sessionId || state.sessionId;
    try {
      await client.rejectQuestion({ sessionId, requestId: question.requestId });
      await ctx.onLog(
        "stdout",
        `[opencode-gateway] declined question ${question.requestId} (${input.questionPolicy}; headless gateway run)\n`,
      );
    } catch (err) {
      await ctx.onLog("stderr", `[opencode-gateway] question reply failed: ${redactText(errorString(err))}\n`);
    }
  }

  const error = extractErrorEvent(raw);
  if (error) {
    markTerminal(state, { kind: "error", message: redactText(error) });
    return;
  }
  if (isIdleEvent(raw)) {
    markTerminal(state, { kind: "idle" });
  }
}

function errorString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollSessionStatus(input: {
  ctx: AdapterExecutionContext;
  client: OpenCodeApiClient;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  redactText: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    // Only treat "not active" as completion after we have seen this session
    // participate in the event stream; a session that has not started yet must
    // not be read as idle.
    if (!input.state.sawSessionEvent) continue;
    try {
      const active = await input.client.activeSessionIds();
      if (!active.has(input.state.sessionId)) {
        markTerminal(input.state, { kind: "idle" });
      }
    } catch (err) {
      if (input.signal.aborted) return;
      await input.ctx.onLog(
        "stderr",
        `[opencode-gateway] status poll failed: ${input.redactText(errorString(err))}\n`,
      );
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  client: OpenCodeApiClient;
  connection: OpenCodeConnection;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText: TextRedactor;
  permissionAction: GatewayConfig["permissionAction"];
  questionPolicy: GatewayConfig["questionPolicy"];
}): Promise<void> {
  const eventUrl = apiUrl(input.connection.baseUrl, input.client.eventPath);
  while (!input.signal.aborted && !input.state.terminal) {
    try {
      const response = await input.connection.fetchImpl(eventUrl, {
        method: "GET",
        headers: {
          ...input.connection.extraHeaders,
          Accept: "text/event-stream",
          Authorization: input.connection.authHeader,
        },
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog(
          "stderr",
          `[opencode-gateway] event stream HTTP ${response.status}; falling back to status polling\n`,
        );
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog(
          "stderr",
          "[opencode-gateway] event stream response had no body; falling back to status polling\n",
        );
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted && !input.state.terminal) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFrames(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await processFrame(input, frame.data);
              if (input.state.terminal) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await processFrame(input, frame.data);
          if (input.state.terminal) break;
        }
      }
    } catch (err) {
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog(
        "stderr",
        `[opencode-gateway] event stream disconnected: ${input.redactText(errorString(err))}\n`,
      );
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

async function processFrame(
  input: Parameters<typeof consumeEvents>[0],
  data: string,
): Promise<void> {
  const raw = parseEventData(data);
  const normalized = input.client.normalizeEvent(raw);
  for (const event of normalized) {
    await handleEvent({
      ctx: input.ctx,
      client: input.client,
      state: input.state,
      raw: event,
      redactText: input.redactText,
      permissionAction: input.permissionAction,
      questionPolicy: input.questionPolicy,
    });
    if (input.state.terminal) break;
  }
}

interface GatewayFailure {
  errorCode: string;
  errorMessage: string;
  errorFamily?: AdapterExecutionResult["errorFamily"];
  errorMeta?: Record<string, unknown>;
}

function failureResult(failure: GatewayFailure, sessionParams?: Record<string, unknown>, displayId?: string | null): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    ...(failure.errorFamily ? { errorFamily: failure.errorFamily } : {}),
    ...(failure.errorMeta ? { errorMeta: failure.errorMeta } : {}),
    provider: "opencode",
    ...(sessionParams ? { sessionParams } : {}),
    sessionDisplayId: displayId ?? null,
  };
}

function errorResult(err: unknown, redactText: TextRedactor): GatewayFailure {
  const record = asRecord(err) ?? {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const code = nonEmpty(record.code) ?? "opencode_gateway_protocol_error";
  const message = redactText(errorString(err));
  const classified: GatewayFailure = { errorCode: code, errorMessage: message };
  if (status === 429 || (status !== undefined && status >= 500)) {
    classified.errorFamily = "transient_upstream";
  }
  if (status !== undefined) classified.errorMeta = { status };
  if (record.body !== undefined && record.body !== null) {
    classified.errorMeta = {
      ...(classified.errorMeta ?? {}),
      body: redactForLog(record.body, [], 0, redactText),
    };
  }
  return classified;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cfg = parseGatewayConfig(ctx.config);

  if (!cfg.apiBaseUrl) {
    return failureResult({
      errorCode: "opencode_gateway_api_base_url_missing",
      errorMessage: "OpenCode gateway adapter requires apiBaseUrl.",
    });
  }
  if (!cfg.baseUrl) {
    return failureResult({
      errorCode: "opencode_gateway_api_base_url_invalid",
      errorMessage: `Invalid OpenCode gateway apiBaseUrl: ${cfg.apiBaseUrl}`,
    });
  }
  if (isRemotePlainHttp(cfg.baseUrl) && !allowsInsecureRemoteHttp(cfg.raw)) {
    return failureResult({
      errorCode: "opencode_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(cfg.baseUrl.hostname),
    });
  }
  if (!cfg.password) {
    return failureResult({
      errorCode: "opencode_gateway_password_missing",
      errorMessage:
        "OpenCode gateway adapter requires password (the OpenCode server basic-auth password; set by OPENCODE_SERVER_PASSWORD).",
    });
  }

  const modelParts = resolveModelParts({
    model: cfg.model,
    providerID: cfg.providerID,
    modelID: cfg.modelID,
  });
  if (!modelParts.providerID || !modelParts.modelID) {
    return failureResult({
      errorCode: "opencode_gateway_model_missing",
      errorMessage:
        "OpenCode gateway adapter requires adapterConfig.model in provider/model form (the gateway owns the provider catalog).",
    });
  }

  const connection: OpenCodeConnection = {
    baseUrl: cfg.baseUrl,
    authHeader: buildAuthHeader(cfg.username, cfg.password),
    extraHeaders: cfg.extraHeaders,
    fetchImpl: fetch,
  };
  const redactText = createTextRedactor([
    cfg.password,
    connection.authHeader,
    ctx.runtimeTools?.bearerToken,
  ]);

  let serverInfo;
  try {
    serverInfo = await detectOpenCodeServerInfo(connection);
  } catch (err) {
    return failureResult(errorResult(err, redactText));
  }
  if (!serverInfo.reachable) {
    return failureResult({
      errorCode: "opencode_gateway_unreachable",
      errorMessage:
        `Could not reach OpenCode server at ${cfg.apiBaseUrl}. ` +
        "Check apiBaseUrl, basic-auth credentials, and that `opencode serve` is reachable from the Paperclip server.",
      errorFamily: "transient_upstream",
    });
  }

  const apiVersion: OpenCodeApiVersion =
    cfg.versionOverride === "auto" ? serverInfo.apiVersion : cfg.versionOverride;
  const detectedVersion = serverInfo.version;
  const qualified = detectedVersion ? isQualifiedOpenCodeVersion(detectedVersion) : false;
  if (cfg.versionOverride === "auto" && detectedVersion && !qualified) {
    if (!allowsUnqualifiedOpenCodeGatewayVersion()) {
      return failureResult({
        errorCode: "opencode_gateway_version_unqualified",
        errorMessage: unqualifiedOpenCodeVersionMessage(detectedVersion),
        errorMeta: { detectedVersion, apiVersion },
      });
    }
    await ctx.onLog(
      "stdout",
      `[opencode-gateway] warning: ${ALLOW_UNQUALIFIED_VERSION_ENV} admitted unqualified OpenCode ${detectedVersion}\n`,
    );
  }

  const transport: OpenCodeTransport = createTransport(connection);
  const directory = cfg.directory ?? "";
  const client = createOpenCodeApiClient({ apiVersion, transport, directory });

  const strategy: SessionKeyStrategy = cfg.sessionKeyStrategy;
  const issueId = issueIdFromContext(ctx);
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId,
  });

  const stored: OpenCodeGatewaySessionState | null = sessionKeyCodecInput(ctx, strategy);
  const resume = shouldResumeStoredSession({
    stored,
    strategy,
    sessionKey,
    apiVersion: cfg.versionOverride,
  });
  const resumedSession = resume && Boolean(stored?.opencodeSessionId);

  const paperclipApiUrl = resolvePaperclipApiUrlOverride(cfg.paperclipApiUrl);
  const { prompt } = buildGatewayPrompt(ctx, { paperclipApiUrl, resumedSession });

  const timeoutMs = cfg.timeoutSec > 0 ? Math.ceil(cfg.timeoutSec * 1000) : 0;
  const baseSessionParams: Record<string, unknown> = {
    sessionKey,
    strategy,
    directory: directory || null,
    apiVersion,
    version: detectedVersion ?? null,
  };

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: `OpenCode ${apiVersion} HTTP/SSE`,
    commandArgs: [apiUrl(cfg.baseUrl, apiVersion === "v2" ? "/api/session" : "/session")],
    context: {
      runId: ctx.runId,
      apiVersion,
      version: detectedVersion ?? null,
      sessionKeyStrategy: strategy,
      resumedSession,
      timeoutSec: cfg.timeoutSec,
      permissionMode: cfg.permissionAction,
    },
  });
  await ctx.onLog(
    "stdout",
    `[opencode-gateway] server=${cfg.apiBaseUrl} api=${apiVersion} version=${detectedVersion ?? "unknown"} qualified=${qualified} session=${strategy}\n`,
  );

  // ---- Find or create the OpenCode session --------------------------------
  let sessionId: string | null = null;
  if (resumedSession && stored) {
    try {
      const existing = await client.getSession(stored.opencodeSessionId);
      if (nonEmpty(existing.id) || Object.keys(existing).length > 0) {
        sessionId = stored.opencodeSessionId;
        await ctx.onLog("stdout", `[opencode-gateway] resuming session ${sessionId}\n`);
      }
    } catch (err) {
      await ctx.onLog(
        "stdout",
        `[opencode-gateway] stored session ${stored.opencodeSessionId} not resumable (${redactText(errorString(err))}); creating a new session\n`,
      );
    }
  }

  if (!sessionId) {
    try {
      const created = await client.createSession({
        title: `Paperclip ${ctx.agent.name} ${ctx.runId}`,
        providerID: modelParts.providerID,
        modelID: modelParts.modelID,
        ...(cfg.agent ? { agent: cfg.agent } : {}),
      });
      sessionId = nonEmpty(created.id) ?? nonEmpty(created.sessionID);
      if (!sessionId) {
        return failureResult(
          {
            errorCode: "opencode_gateway_session_create_failed",
            errorMessage: "OpenCode session create response did not include an id.",
            errorMeta: { response: redactForLog(created, [], 0, redactText) },
          },
          baseSessionParams,
          null,
        );
      }
      await ctx.onLog("stdout", `[opencode-gateway] created session ${sessionId}\n`);
    } catch (err) {
      return failureResult(errorResult(err, redactText), baseSessionParams, null);
    }
  }

  const sessionParams: Record<string, unknown> = {
    ...baseSessionParams,
    opencodeSessionId: sessionId,
  };
  const sessionDisplayId = sessionId;

  const state = createExecutionState(sessionId);
  const controller = new AbortController();
  if (ctx.signal) {
    ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // ---- Send the prompt -----------------------------------------------------
  try {
    ctx.onDispatch?.();
    await client.prompt({
      sessionId,
      providerID: modelParts.providerID,
      modelID: modelParts.modelID,
      prompt,
      ...(cfg.system ? { system: cfg.system } : {}),
    });
  } catch (err) {
    return failureResult(errorResult(err, redactText), sessionParams, sessionDisplayId);
  }

  void consumeEvents({
    ctx,
    client,
    connection,
    state,
    signal: controller.signal,
    reconnectMs: cfg.eventReconnectMs,
    redactText,
    permissionAction: cfg.permissionAction,
    questionPolicy: cfg.questionPolicy,
  }).catch(() => undefined);
  void pollSessionStatus({
    ctx,
    client,
    state,
    signal: controller.signal,
    intervalMs: cfg.pollIntervalMs,
    redactText,
  }).catch(() => undefined);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([state.terminalPromise, timeoutPromise]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  controller.abort();

  if (outcome === "timeout") {
    try {
      await client.interrupt(sessionId);
      await ctx.onLog("stdout", `[opencode-gateway] interrupted session ${sessionId} after timeout\n`);
    } catch (err) {
      await ctx.onLog("stderr", `[opencode-gateway] interrupt failed: ${redactText(errorString(err))}\n`);
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorCode: "opencode_gateway_timeout",
      errorMessage: `OpenCode gateway run timed out after ${cfg.timeoutSec}s.`,
      provider: "opencode",
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.costUsd !== null ? { costUsd: state.costUsd } : {}),
      ...(state.model ? { model: state.model } : {}),
      sessionParams,
      sessionId,
      sessionDisplayId,
      resultJson: {
        sessionId,
        strategy,
        apiVersion,
        status: "timeout",
        last_event: state.lastEventName,
      },
    };
  }

  const output = state.outputChunks.join("").trim();
  const common = {
    provider: "opencode" as const,
    ...(state.model ? { model: state.model } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.costUsd !== null ? { costUsd: state.costUsd } : {}),
    sessionParams,
    sessionId,
    sessionDisplayId,
  };

  if (outcome.kind === "error") {
    await ctx.onLog("stderr", `[opencode-gateway] session error: ${outcome.message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "opencode_gateway_session_error",
      errorMessage: outcome.message,
      errorFamily: "transient_upstream",
      ...common,
      resultJson: {
        sessionId,
        strategy,
        apiVersion,
        status: "error",
        last_event: state.lastEventName,
        error: outcome.message,
      },
      ...(output ? { summary: output.slice(0, 2_000) } : {}),
    };
  }

  await ctx.onLog("stdout", `[opencode-gateway] session ${sessionId} completed\n`);
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...common,
    resultJson: {
      sessionId,
      strategy,
      apiVersion,
      status: "completed",
      last_event: state.lastEventName,
      output,
      usage: state.usage ?? null,
      cost_usd: state.costUsd,
    },
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
  };
}

function sessionKeyCodecInput(
  ctx: AdapterExecutionContext,
  strategy: SessionKeyStrategy,
): OpenCodeGatewaySessionState | null {
  const raw = ctx.runtime?.sessionParams ?? null;
  const record = asRecord(raw);
  const opencodeSessionId =
    nonEmpty(record?.opencodeSessionId) ??
    nonEmpty(ctx.runtime?.sessionId) ??
    null;
  if (!opencodeSessionId) return null;
  const storedStrategy = nonEmpty(record?.strategy);
  return {
    opencodeSessionId,
    sessionKey: nonEmpty(record?.sessionKey),
    strategy:
      storedStrategy === "issue" || storedStrategy === "agent" || storedStrategy === "run" || storedStrategy === "none"
        ? storedStrategy
        : strategy,
    directory: nonEmpty(record?.directory),
    apiVersion: record?.apiVersion === "v1" || record?.apiVersion === "v2" ? record.apiVersion : null,
    version: nonEmpty(record?.version),
  };
}
