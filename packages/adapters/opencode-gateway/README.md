# OpenCode Gateway Adapter

`@paperclipai/adapter-opencode-gateway` connects Paperclip to an **already-running**
OpenCode HTTP/SSE server (`opencode serve`). It does not launch an OpenCode
process — that is what `opencode_local` does.

This is its own `adapterType` (`opencode_gateway`), the gateway counterpart to
`opencode_local`, exactly as `hermes_gateway` sits next to `hermes_local` and
`openclaw_gateway` stands alone.

## When to use it

- OpenCode already runs as a server on another host, process, or container.
- You cannot or do not want Paperclip to spawn the OpenCode CLI per heartbeat.
- You accept that the OpenCode server owns the workspace directory, provider
  credentials, and model catalog.

Do **not** use it when Paperclip should start the OpenCode CLI locally; use
`opencode_local`.

## Protocol mapping

The adapter is version-aware and talks to either server family end to end.

| Concern | V1 (`opencode-ai` 1.x) | V2 (`@opencode/cli` 2.x) |
|---|---|---|
| Version probe | `GET /global/health` | `GET /api/info` |
| Create session | `POST /session` | `POST /api/session` |
| Prompt | `POST /session/:id/prompt_async` | `POST /api/session/:id/prompt` |
| Events | `GET /event` (SSE) | `GET /api/event` (SSE) |
| Interrupt | `POST /session/:id/abort` | `POST /api/session/:id/interrupt` |
| Permission reply | `POST /permission/:id/reply` | `POST /api/session/:id/permission/:rid/reply` |
| Interactive input | `/question` | forms API |

Qualified version windows: `1.18.34 <= v < 2.0.0` and `2.0.0 <= v < 2.1.0`.
`1.18.35` is admitted without any bypass variable. Versions outside every
window are rejected unless `PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_GATEWAY_VERSION=1`
is set or `adapterConfig.version` is pinned to `v1`/`v2`.

`version: "auto"` probes V1 (`/global/health`) first and falls back to V2
(`/api/info`). The V2 event family (`session.execution.succeeded`,
`session.text.delta`, …) is normalized into the V1 event shapes the adapter's
mapper consumes.

## Authentication

HTTP basic auth. `Authorization: Basic base64(username:password)`.

- V1 honours `OPENCODE_SERVER_USERNAME` (default `opencode`).
- V2 hard-codes the username to `opencode`.
- The password is `OPENCODE_SERVER_PASSWORD`.

Credentials are never logged; the adapter redacts the password and the encoded
`Authorization` header from every emitted line.

## Configuration

See `agentConfigurationDoc` (exported from the package root) and the schema from
`getConfigSchema()`. Required: `apiBaseUrl`, `password`, `model`
(`provider/model`). Key optionals: `version`, `directory`,
`sessionKeyStrategy`, `permissionMode`, `questionPolicy`, `timeoutSec`.

## Workspace and location

OpenCode operates on a **directory**. The gateway host must already be able to
see the workspace the agent should work in (co-location or a shared volume).
Paperclip does **not** create, sync, or restore that directory for gateway runs;
it is not a local worktree. Set `adapterConfig.directory` to make the target
explicit; otherwise OpenCode uses its own server working directory.

## Session continuity

OpenCode has no external session-key parameter, so the adapter owns the mapping
between a Paperclip work-key and the OpenCode session id:

- `sessionKeyStrategy`: `issue` (default), `agent`, `run`, or `none`.
- The chosen strategy plus the OpenCode session id are persisted through
  `sessionCodec` and replayed on the next heartbeat.
- A stored session is resumed only when the strategy is stable (`issue`/`agent`),
  the resolved work-key still matches, and the API version family is unchanged.
- `run` and `none` always start a fresh session.

## Runtime tools

`runtimeToolDelivery` is `invocation_context`. Paperclip does not inject
environment variables or a materialized MCP config into a server it does not
own. Instead the adapter embeds the Paperclip remote MCP endpoint, bearer token,
and tool guidance in the run prompt so the gateway host can attach the
`paperclip` MCP server for the run. The token is never persisted.

## Security

- One basic-auth password, no per-tenant isolation. Prefer HTTPS or a private
  overlay network for any non-loopback host; the adapter refuses remote plain
  HTTP unless the escape hatch is set.
- Do not run one server for multiple untrusted companies: providers, files, and
  sessions are shared. `testEnvironment` warns about this.
- The gateway owns provider credentials; Paperclip routes no AI connections for
  it. See `tests/runner-e2e/connection-cases.ts` for the routing exclusion
  pattern used by the other gateways.

## No-remote-git contract

Like every adapter, this one treats the local execution-workspace cwd as the
only cross-run persistence boundary. It never `git push`es and never assumes a
`git remote`. When code must reach the gateway host, use the round-trip helpers
in `@paperclipai/adapter-utils`
(`prepareWorkspaceForSshExecution` → `restoreWorkspaceFromSshExecution`). See
[`packages/adapters/AUTHORING.md`](../AUTHORING.md#no-remote-git-contract-cross-run-persistence).

## Installation (external plugin, for evaluation)

```sh
# from a checkout, in the package directory
pnpm --filter @paperclipai/adapter-opencode-gateway typecheck
pnpm --filter @paperclipai/adapter-opencode-gateway test

# install into a running Paperclip instance (dev server runs via tsx, so the
# TypeScript source entry resolves directly)
curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/absolute/path/to/packages/adapters/opencode-gateway"}'
```

## Testing

- Unit tests cover the version windows, V1/V2 request shapes, event mapping,
  permission/question handling, session codec, config parsing, `testEnvironment`,
  and full `execute()` runs against fake HTTP/SSE servers.
- Live smoke test (not run in CI): start `opencode serve --port 4096` with
  `OPENCODE_SERVER_PASSWORD`, then run a short prompt through an agent whose
  adapter is `opencode_gateway` and confirm the terminal event and usage.

## Promotion to built-in (follow-up)

This package currently loads as an external plugin, with **no core changes**.
To promote it to a built-in type, the follow-up work is:

1. Register in `server/src/adapters/registry.ts` (import `execute`,
   `testEnvironment`, `getConfigSchema` from `./server`, and
   `agentConfigurationDoc`/`models` from the package root), setting
   `runtimeToolDelivery: "invocation_context"`.
2. Add `"opencode_gateway"` to `AGENT_ADAPTER_TYPES` in
   `packages/shared/src/constants.ts`.
3. Add `"opencode_gateway"` to `server/src/adapters/builtin-adapter-types.ts`.
4. Add a row to `docs/adapters/overview.md` and, if needed, a row in
   `tests/runner-e2e/connection-cases.ts` marking it `excluded`.
5. Wire the create-agent UI (`ui/` NewAgent flow) to
   `buildOpenCodeGatewayConfig`, and decide whether to surface
   `listOpenCodeGatewayModels`.
6. Add a `connectionFailure` provider variant in
   `packages/adapter-utils/src/connection-failure.ts` if first-party connection
   diagnosis is wanted (the external package intentionally does not extend the
   closed union).
