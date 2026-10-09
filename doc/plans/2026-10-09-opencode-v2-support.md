# OpenCode V2 support

Date: 2026-10-09
Status: Phase 1 shipped (direct CLI adapter); Phases 2-4 planned

## Why

OpenCode V2 shipped as a breaking major: the server API, plugin API, and
terminal client configuration changed, and the `run` CLI contract dropped
`--variant` and `models --refresh`. Paperclip's direct `opencode_local` adapter
previously hard-rejected any non-1.x install, so a V2 user could not save or run
an agent. The Paperclip Runner's `opencode_server` driver additionally drives
the V1 HTTP server API (`/session`, `/session/:id/prompt_async`, `/event`,
`/permission`, `/question`), which V2 replaced under `/api/...`.

## Phase 1 - direct CLI adapter (`opencode_local`) - DONE

Qualified both majors and made the CLI flags version-aware:

- `SUPPORTED_OPENCODE_MAJOR_VERSIONS = [1, 2]`; the version guard accepts 1.x
  and 2.x and only rejects unknown majors (with the documented
  `PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION` bypass).
- V2 `run` args: the variant folds into `--model provider/model#variant` (V2 has
  no `--variant` flag); V1 keeps the separate flag.
- V2 `opencode models` never receives `--refresh` (V2 dropped it).
- The environment test's hello probe uses the same version-aware args.
- Verified empirically against `opencode v2.0.26`:
  - `opencode run --format json` emits compatible JSONL (`text`, `step_finish`,
    `tool_use`, `error`) with a top-level `sessionID`.
  - `--variant` and `models --refresh` are rejected by V2 (usage + exit 1).
  - `--model provider/model#variant` is accepted.
- The managed provider projection still uses the V1-shaped
  `OPENCODE_CONFIG_CONTENT`; V2's compatibility layer normalizes it (confirmed
  by a successful DeepSeek hello probe on V2).

## Phase 2 - V2-native projection (planned)

Emit V2-native provider config when the CLI is V2:
`providers.<id>.package = "@opencode/ai/providers/openai-compatible"`,
`settings.baseURL`/`settings.apiKey`, and `agents.title.model` for the pinned
small/title model, falling back to the V1 shape on 1.x. Add the `mcp.servers`
shape when the runner path lands.

## Phase 3 - runner server driver V2 (planned, large)

Port `packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts`
to the V2 HTTP API under `/api/...`: sessions (`/api/session`,
`/api/session/{id}/prompt`), events (`/api/event`), permissions
(`/api/session/{id}/permission/{requestID}/reply`), and forms/questions. Widen
the exact version pin to a tested window (1.x and 2.x) and re-run the
question-conformance qualification.

## Phase 4 - qualification (planned)

Live end-to-end runs on V2 for each harness (direct adapter and runner), sandbox
image pins, and user-facing docs.
