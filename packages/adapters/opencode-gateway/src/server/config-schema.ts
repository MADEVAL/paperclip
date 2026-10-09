import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
} from "../shared/constants.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "apiBaseUrl",
        label: "Server base URL",
        type: "text",
        required: true,
        hint: "Base URL of an already-running `opencode serve`, such as http://127.0.0.1:4096 or a private HTTPS URL. Paperclip connects to it over HTTP/SSE; it does not launch OpenCode.",
      },
      {
        key: "password",
        label: "Server password",
        type: "text",
        required: true,
        hint: "OPENCODE_SERVER_PASSWORD for the running server. Sent as HTTP basic auth. Stored as a Paperclip secret reference.",
        meta: { secret: true },
      },
      {
        key: "username",
        label: "Basic-auth username",
        type: "text",
        default: "opencode",
        hint: "V1 honours OPENCODE_SERVER_USERNAME; V2 hard-codes `opencode`. Leave empty for the default.",
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
        hint: "Auto probes /global/health (V1) then /api/info (V2). Pin only to bypass the qualified-version guard deliberately.",
      },
      {
        key: "directory",
        label: "Workspace directory",
        type: "text",
        hint: "Directory on the gateway host that OpenCode should operate in. The Paperclip server does not create or sync this directory; it must already be visible there (co-location or shared volume).",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        required: true,
        hint: "OpenCode model id in provider/model form, for example anthropic/claude-sonnet-4-5. The gateway owns the provider catalog, so Paperclip cannot validate this.",
      },
      {
        key: "agent",
        label: "OpenCode agent",
        type: "text",
        hint: "Optional OpenCode agent profile name passed to session creation (V2).",
      },
      {
        key: "system",
        label: "System prompt",
        type: "textarea",
        hint: "Optional stable system prompt sent with the first prompt (V1 only).",
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
        hint: "Controls OpenCode session continuity across heartbeats. Issue scoped prevents cross-task memory bleed by default.",
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
        hint: "How the adapter answers OpenCode permission requests during a headless run.",
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
        hint: "Headless runs cannot answer interactive questions, so the adapter declines them.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
        hint: "Wall-clock budget for the run. On timeout the adapter interrupts the OpenCode session.",
      },
      {
        key: "eventReconnectMs",
        label: "Event reconnect ms",
        type: "number",
        default: DEFAULT_EVENT_RECONNECT_MS,
        hint: "Delay before reconnecting the SSE event stream after a nonterminal disconnect.",
      },
      {
        key: "pollIntervalMs",
        label: "Status poll ms",
        type: "number",
        default: DEFAULT_POLL_INTERVAL_MS,
        hint: "Fallback status-poll interval when the SSE stream is unavailable.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional Paperclip API URL reachable by the gateway host. This is not a credential.",
      },
      {
        key: "headers",
        label: "Extra headers",
        type: "textarea",
        hint: "Optional JSON object of extra nonsecret headers. Authorization and Accept are generated by the adapter.",
      },
      {
        key: INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
        label: "Dangerously allow remote HTTP",
        type: "toggle",
        default: false,
        hint: "Unsafe dev-only escape hatch. Remote OpenCode servers should use HTTPS; loopback HTTP remains allowed.",
      },
    ],
  };
}
