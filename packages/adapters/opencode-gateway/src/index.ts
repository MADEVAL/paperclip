import type { AdapterSessionManagement, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { ADAPTER_LABEL, ADAPTER_TYPE, ALLOW_UNQUALIFIED_VERSION_ENV } from "./shared/constants.js";
import { execute, getConfigSchema, sessionCodec, testEnvironment } from "./server/index.js";

export { createOpenCodeApiClient, formFieldsToQuestions } from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * The gateway owns the provider/model catalog. Paperclip cannot reliably
 * enumerate models from an arbitrary already-running OpenCode server, so the
 * static list stays empty and the operator sets `adapterConfig.model`
 * explicitly. See `listOpenCodeGatewayModels` for the best-effort probe used by
 * other surfaces.
 */
export const models: { id: string; label: string }[] = [];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

export const agentConfigurationDoc = `# opencode_gateway agent configuration

Adapter: opencode_gateway

Use when:
- OpenCode is already running as an HTTP/SSE server (\`opencode serve\`) on another
  host or process, and Paperclip should drive sessions over HTTP/SSE.
- You cannot or do not want Paperclip to launch the OpenCode CLI as a child process.

Don't use when:
- Paperclip should start the OpenCode CLI locally for each heartbeat; use
  \`opencode_local\` instead.
- The OpenCode server is only reachable over unsafe public plain HTTP.

Required fields:
- apiBaseUrl (string): base URL of the running server, for example
  http://127.0.0.1:4096. Paperclip does not launch this server.
- password (string): OPENCODE_SERVER_PASSWORD. Sent as HTTP basic auth.
- model (string): OpenCode model id in provider/model form, for example
  anthropic/claude-sonnet-4-5. The gateway owns the provider catalog.

Optional fields:
- username (string): basic-auth username. V1 honours OPENCODE_SERVER_USERNAME;
  V2 hard-codes \`opencode\`. Default: opencode.
- version (v1 | v2 | auto): server protocol family. Default: auto, detected from
  /global/health (V1) then /api/info (V2).
- directory (string): directory on the gateway host OpenCode should operate in.
- agent (string): OpenCode agent profile name (V2 session creation).
- system (string): stable system prompt (V1).
- sessionKeyStrategy (issue | agent | run | none): defaults to issue.
- permissionMode (accept | accept_for_session | decline): defaults to accept.
- questionPolicy (reject | cancel): defaults to reject.
- timeoutSec (number): defaults to 600.
- eventReconnectMs (number): defaults to 2000.
- pollIntervalMs (number): defaults to 1000.
- paperclipApiUrl (string): Paperclip API URL reachable by the gateway host.
- headers (object or JSON string): extra noncritical headers.
- dangerouslyAllowInsecureRemoteHttp (boolean): unsafe dev escape hatch.

Protocol mapping:
- V1 (opencode-ai 1.x): GET /global/health, POST /session,
  POST /session/:id/prompt_async, SSE GET /event, /permission, /question,
  POST /session/:id/abort.
- V2 (2.x): GET /api/info, POST /api/session,
  POST /api/session/:id/prompt, SSE GET /api/event,
  /api/session/:id/permission/:requestID/reply, forms instead of questions,
  POST /api/session/:id/interrupt.
- Qualified windows: 1.18.34 <= v < 2.0.0 and 2.0.0 <= v < 2.1.0. Set
  ${ALLOW_UNQUALIFIED_VERSION_ENV}=1 or pin \`version\` to bypass the guard.

Workspace and location:
- OpenCode operates on a DIRECTORY, not a Paperclip-managed worktree. The
  gateway host must already see the workspace (co-location or a shared volume).
  Paperclip does not create, sync, or restore this directory for gateway runs.
  Set \`directory\` to make the target explicit; otherwise OpenCode uses its own
  server working directory.

Security:
- The server has a single basic-auth password with no per-tenant isolation.
  Prefer HTTPS or a private overlay network for any non-loopback host.
- Do not run one server for multiple untrusted companies. Its providers, files,
  and sessions are shared.
- The gateway owns provider credentials; Paperclip does not route AI connections
  for it.

Runtime tools:
- Paperclip delivers run-scoped \`paperclip_*\` tools as invocation context. The
  gateway host must attach the Paperclip remote MCP server to the session; the
  adapter embeds the MCP endpoint and bearer token in the run prompt.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
