import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
} from "../shared/constants.js";
import {
  buildModelFieldOptions,
  FALLBACK_OPENCODE_MODELS,
  loadOpenCodeModelCatalog,
  type OpenCodeCatalogModel,
} from "./free-models.js";

export interface ConfigSchemaDeps {
  /** Override the model-catalog loader (used by tests to avoid network). */
  loadCatalog?: () => Promise<OpenCodeCatalogModel[]>;
}

async function resolveCatalog(deps: ConfigSchemaDeps): Promise<OpenCodeCatalogModel[]> {
  const loader = deps.loadCatalog ?? (() => loadOpenCodeModelCatalog());
  try {
    const catalog = await loader();
    return catalog.length > 0 ? catalog : FALLBACK_OPENCODE_MODELS;
  } catch {
    return FALLBACK_OPENCODE_MODELS;
  }
}

export async function getConfigSchema(deps: ConfigSchemaDeps = {}): Promise<AdapterConfigSchema> {
  const modelOptions = buildModelFieldOptions(await resolveCatalog(deps));
  return {
    fields: [
      {
        key: "apiBaseUrl",
        label: "Server base URL",
        type: "text",
        required: true,
        hint: "URL of an already-running `opencode serve`. Accepts a bare host, `host:port`, or a full URL; a missing port defaults to 4096. Example: `http://127.0.0.1:4096` or `192.168.1.50:4096`. Paperclip only connects over HTTP/SSE — it never launches OpenCode. A non-loopback `http://` URL is rejected unless 'Dangerously allow remote HTTP' is also enabled.",
      },
      {
        key: "password",
        label: "Server password",
        type: "text",
        hint: "The server's `OPENCODE_SERVER_PASSWORD`, sent as HTTP basic auth. V2 (`@opencode/cli` 2.x) always requires a password: if you did not set that environment variable, `opencode serve` generates one and prints `server password <value>` at startup — copy that value here. Only a V1 server can run without a password, and then you must also switch on 'Connect without a password'.",
        meta: { secret: true },
      },
      {
        key: "allowNoAuth",
        label: "Connect without a password",
        type: "toggle",
        default: false,
        hint: "V1 only. Turn on when a V1 server truly runs without basic auth (no `OPENCODE_SERVER_PASSWORD`). V2 always requires a password — leave this off for a V2 server and fill 'Server password' instead. Only safe on loopback or a trusted private network: an unauthenticated server lets anyone on the network drive this agent.",
      },
      {
        key: "username",
        label: "Basic-auth username",
        type: "text",
        default: "opencode",
        hint: "Basic-auth username. The default and the V2 value is `opencode`; only V1 honours a custom `OPENCODE_SERVER_USERNAME`. Leave empty to use the default.",
      },
      {
        key: "version",
        label: "Server version",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto-detect" },
          { value: "v1", label: "V1 (opencode-ai 1.x)" },
          { value: "v2", label: "V2 (@opencode/cli 2.x)" },
        ],
        hint: "Protocol family of the running server. `Auto-detect` probes `/global/health` (V1) and `/api/info` (V2) and picks whichever reports a semantic version. Pin `v1` or `v2` to force the family when auto-detection is wrong; pinning also bypasses the qualified-version guard, so do it deliberately.",
      },
      {
        key: "directory",
        label: "Workspace directory",
        type: "text",
        hint: "Directory on the machine that runs `opencode serve` (the gateway host) where OpenCode should operate. A local path on that host is enough; a shared volume is only needed when the workspace actually lives on a different machine. Paperclip does not create or sync this directory. Leave empty to use the server's own working directory.",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        required: true,
        options: modelOptions,
        hint: "OpenCode model id in `provider/model` form, for example `opencode/big-pickle` (free) or `anthropic/claude-sonnet-4-5`. The list is loaded from the OpenCode Zen and Go catalogs; entries ending in (free) cost nothing. You can also type any provider/model. The model works only if the gateway host has that provider connected.",
      },
      {
        key: "agent",
        label: "OpenCode agent",
        type: "text",
        hint: "Optional OpenCode agent profile name passed when a V2 session is created. Leave empty to use the server default.",
      },
      {
        key: "system",
        label: "System prompt",
        type: "textarea",
        hint: "Optional stable system prompt prepended to the first prompt. V1 only — V2 ignores it. For V2, use the `agent` profile or a project instruction file instead.",
      },
      {
        key: "sessionKeyStrategy",
        label: "Session key strategy",
        type: "select",
        default: "issue",
        options: [
          { value: "issue", label: "Issue scoped" },
          { value: "agent", label: "Agent scoped" },
          { value: "run", label: "Run scoped" },
          { value: "none", label: "None (fresh every run)" },
        ],
        hint: "Controls session continuity across heartbeats. `Issue scoped` (default) keeps one OpenCode session per Paperclip issue, so memory does not bleed across tasks. `Agent scoped` keeps one session per agent. `Run scoped` and `None` create a fresh session every run (Run scoped still records a key; None records none).",
      },
      {
        key: "permissionMode",
        label: "Permission replies",
        type: "select",
        default: "accept",
        options: [
          { value: "accept", label: "Accept once" },
          { value: "accept_for_session", label: "Accept for session" },
          { value: "decline", label: "Decline" },
        ],
        hint: "How the adapter answers OpenCode permission requests in a headless run. `Accept once` approves the single request; `Accept for session` approves every request for the session; `Decline` rejects the request.",
      },
      {
        key: "questionPolicy",
        label: "Question policy",
        type: "select",
        default: "reject",
        options: [
          { value: "reject", label: "Reject" },
          { value: "cancel", label: "Cancel" },
        ],
        hint: "Headless runs cannot answer interactive questions, so the adapter always declines them. Both choices decline; the value only changes the label recorded in the run log ('reject' or 'cancel').",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
        hint: "Wall-clock budget for one run, in seconds (default 600). On timeout the adapter interrupts the OpenCode session.",
      },
      {
        key: "eventReconnectMs",
        label: "Event reconnect ms",
        type: "number",
        default: DEFAULT_EVENT_RECONNECT_MS,
        hint: "Delay before reconnecting the SSE event stream after a non-terminal disconnect, in milliseconds (default 2000).",
      },
      {
        key: "pollIntervalMs",
        label: "Status poll ms",
        type: "number",
        default: DEFAULT_POLL_INTERVAL_MS,
        hint: "Fallback status-poll interval used when the SSE event stream is unavailable, in milliseconds (default 1000).",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional Paperclip API URL that the gateway host can reach. When set, the agent is told this address so it can call Paperclip back. This is not a credential.",
      },
      {
        key: "headers",
        label: "Extra headers",
        type: "textarea",
        hint: "Optional JSON object of extra non-secret request headers sent to the OpenCode server. `Authorization`, `Content-Type`, and `Accept` are generated by the adapter and cannot be overridden here.",
      },
      {
        key: INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
        label: "Dangerously allow remote HTTP",
        type: "toggle",
        default: false,
        hint: "Unsafe development escape hatch, off by default. When off, a non-loopback `http://` server URL is rejected. When on, credentials are sent to a non-loopback server in plain HTTP, where anyone on the network can read them. Loopback `http://localhost` and `http://127.0.0.1` are always allowed. Use HTTPS or a private overlay network for anything real.",
      },
    ],
  };
}
