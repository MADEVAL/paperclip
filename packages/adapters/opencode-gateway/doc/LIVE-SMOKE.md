# OpenCode Gateway — live smoke test

This is the manual, non-CI verification for `opencode_gateway`. It exercises a
real `opencode serve` over HTTP/SSE with basic auth, first on V1 then on V2.

The adapter is HTTP/SSE only; nothing here launches OpenCode from Paperclip.

## 1. Start the OpenCode server

V1 (`opencode-ai` 1.18.35):

```sh
OPENCODE_SERVER_PASSWORD='smoke-pass' \
OPENCODE_SERVER_USERNAME='opencode' \
npx -y opencode-ai@1.18.35 serve --port 4096
```

V2 (`@opencode/cli` 2.0.26):

```sh
OPENCODE_SERVER_PASSWORD='smoke-pass' \
npx -y @opencode/cli@2.0.26 serve --port 4096
```

Confirm the version probe (username is `opencode`; V2 ignores the username):

```sh
curl -s -u opencode:smoke-pass http://127.0.0.1:4096/global/health   # V1 -> {"healthy":true,"version":"1.18.35"}
curl -s -u opencode:smoke-pass http://127.0.0.1:4096/api/info        # V2 -> {"version":"2.0.26", ...}
```

## 2. Install the adapter into Paperclip (dev server)

```sh
# from the repo root, start Paperclip with the dev server (tsx resolves the TS entry)
pnpm dev

curl -X POST http://localhost:3100/api/adapters \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/absolute/path/to/packages/adapters/opencode-gateway"}'
```

Create (or edit) an agent with `adapterType: "opencode_gateway"` and:

```json
{
  "apiBaseUrl": "http://127.0.0.1:4096",
  "password": "smoke-pass",
  "model": "<provider>/<model>",
  "version": "auto",
  "sessionKeyStrategy": "issue",
  "directory": "<a directory the gateway host can see>",
  "timeoutSec": 600
}
```

## 3. Verify the environment probe

Use the agent's "Test environment" action, or POST the adapter test endpoint.
Expected checks for a healthy loopback server:

- `opencode_gateway_reachable` (info) via `/global/health` (V1) or `/api/info` (V2)
- `opencode_gateway_version_qualified` (info) for `1.18.35` / `2.0.26`
- `opencode_gateway_gateway_owns_providers` (warn) — the gateway owns providers
- no `opencode_gateway_auth_failed`

`1.18.35` must pass without setting
`PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_GATEWAY_VERSION`.

## 4. Run a short prompt

Wake the agent on a trivial issue ("reply with the word pong and stop"). Then
confirm in the run log/transcript:

- `[opencode-gateway] server=... api=v1 version=1.18.35 qualified=true`
- `[opencode-gateway] created session <id>`
- `[opencode-gateway:event] session=<id> event=message.part.updated ...`
- `[opencode-gateway] session <id> completed`
- a non-zero `usage`/`costUsd` on the run when the model reports tokens
- the agent's session id persisted (`sessionId` / `sessionParams.opencodeSessionId`)

Repeat once to confirm resume: on an issue-scoped agent the second run should log
`resuming session <id>` and not print `created session`.

## 5. Negative checks

- Wrong password → run fails with `opencode_gateway_auth_failed` / `..._auth_failed`.
- Non-loopback `http://` without the escape hatch → `opencode_gateway_plain_http_remote_denied`.
- `version` outside the qualified windows → `opencode_gateway_version_unqualified`
  unless the bypass env or an explicit `version` pin is set.
- Long-running prompt with `timeoutSec` small → `opencode_gateway_timeout` and a
  logged `interrupted session <id>`.

## 6. Cleanup

```sh
curl -X DELETE http://localhost:3100/api/adapters/opencode_gateway
# stop the opencode serve process
```
