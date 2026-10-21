import type { AdapterModel, AdapterSessionManagement, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { ADAPTER_LABEL, ADAPTER_TYPE, ALLOW_UNQUALIFIED_VERSION_ENV } from "./shared/constants.js";
import { execute, getConfigSchema, sessionCodec, testEnvironment } from "./server/index.js";
import {
  catalogToAdapterModels,
  FALLBACK_OPENCODE_MODELS,
  loadOpenCodeModelCatalog,
} from "./server/free-models.js";

export { createOpenCodeApiClient, formFieldsToQuestions } from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Static last-resort list. Every create/edit surface that can enumerate models
 * uses `listModels`/`refreshModels` below or `getConfigSchema`; this list only
 * keeps a dropdown useful when the public catalog is unreachable.
 */
export const models: { id: string; label: string }[] = catalogToAdapterModels(FALLBACK_OPENCODE_MODELS);

/**
 * Live Zen/Go catalog in the shape the adapter model endpoint expects. Unlike
 * `models`, this includes new free models without a Paperclip release.
 */
export async function listOpenCodeGatewayCatalogModels(): Promise<AdapterModel[]> {
  return catalogToAdapterModels(await loadOpenCodeModelCatalog());
}

/** Force a catalog refetch for the model dropdown's Refresh action. */
export async function refreshOpenCodeGatewayCatalogModels(): Promise<AdapterModel[]> {
  return catalogToAdapterModels(await loadOpenCodeModelCatalog({ force: true }));
}

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
- apiBaseUrl (string): host, host:port, or full URL of the running server, for
  example 192.168.1.50, 127.0.0.1:4096, or http://127.0.0.1:4096. A missing port
  defaults to 4096. Paperclip does not launch this server. A non-loopback
  http:// URL is rejected unless dangerouslyAllowInsecureRemoteHttp is true.
- model (string): OpenCode model id in provider/model form, for example
  opencode/big-pickle (free) or anthropic/claude-sonnet-4-5. The gateway owns
  the provider catalog; the model works only if the gateway host has that
  provider connected.

Auth:
- V2 (@opencode/cli 2.x) always requires a password. If the server was started
  without OPENCODE_SERVER_PASSWORD, \`opencode serve\` generates one and prints
  \`server password <value>\` at startup; copy that value into password. You can
  also set OPENCODE_SERVER_PASSWORD yourself before starting the server.
- V1 (opencode-ai 1.x) can run without auth. In that case set allowNoAuth=true
  and leave password empty. Only do this on loopback or a trusted private
  network. V2 does not support this mode at all.

Optional fields:
- password (string): OPENCODE_SERVER_PASSWORD. Sent as HTTP basic auth.
- allowNoAuth (boolean): V1 only. Connect to a V1 server that runs without basic
  auth. V2 always requires a password.
- username (string): basic-auth username. V1 honours OPENCODE_SERVER_USERNAME;
  V2 hard-codes \`opencode\`. Default: opencode.
- version (v1 | v2 | auto): server protocol family. Default: auto, which probes
  /global/health (V1) and /api/info (V2) and picks whichever reports a semantic
  version. Pin v1 or v2 to force the family; pinning also bypasses the
  qualified-version guard.
- directory (string): directory on the gateway host OpenCode should operate in.
  A local path on that host is enough; a shared volume is only needed when the
  workspace lives on a different machine.
- agent (string): OpenCode agent profile name (V2 session creation).
- system (string): stable system prompt (V1 only; V2 ignores it).
- sessionKeyStrategy (issue | agent | run | none): defaults to issue.
- permissionMode (accept | accept_for_session | decline): defaults to accept.
- questionPolicy (reject | cancel): headless runs always decline questions; the
  value only changes the run-log label. Defaults to reject.
- timeoutSec (number): defaults to 600.
- eventReconnectMs (number): defaults to 2000.
- pollIntervalMs (number): defaults to 1000.
- paperclipApiUrl (string): Paperclip API URL reachable by the gateway host.
- headers (object or JSON string): extra noncritical headers.
- dangerouslyAllowInsecureRemoteHttp (boolean): unsafe dev escape hatch, off by
  default. Enables non-loopback plain HTTP.

Models:
- Every create and edit surface loads the public OpenCode Zen and OpenCode Go
  catalogs (https://opencode.ai/zen/v1/models and .../zen/go/v1/models), enriched
  with zero-cost metadata from https://models.dev/api.json. Free models are
  labelled "(free)", including stealth releases without a -free suffix. The
  catalog is cached for 30 minutes and can be force-refreshed. Any provider/model
  can be typed manually. A model works only if the gateway host has that provider
  connected.

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
    listModels: listOpenCodeGatewayCatalogModels,
    refreshModels: refreshOpenCodeGatewayCatalogModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
