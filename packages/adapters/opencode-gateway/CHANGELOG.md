# Changelog

## Unreleased

- `password` is now optional. A new `allowNoAuth` toggle connects to a **V1**
  OpenCode server that runs without basic auth (no `OPENCODE_SERVER_PASSWORD`);
  the adapter sends no `Authorization` header and warns for non-loopback hosts.
  V2 always requires a password, so `allowNoAuth` does not apply to V2.
- Model/version detection now probes V1 (`/global/health`) and V2 (`/api/info`)
  and prefers whichever reports a semantic version, so a V2 server that answers
  `/global/health` with its HTML shell is no longer misread as a versionless V1.
  A pinned `version` probes only that endpoint.
- Config-schema hints and `testEnvironment` messages now state the V2 password
  requirement, the `server password <value>` startup banner, the remote
  plain-HTTP rule, and the workspace-directory rule exactly.
- `apiBaseUrl` accepts a bare host or IP, defaults the scheme to `http://`, and
  defaults a missing port to `4096`.
- The `model` config field is now a combobox loaded from the public OpenCode Zen
  and OpenCode Go model catalogs, with free models labelled `(free)`. The list is
  cached, never throws, and falls back to a baked-in set of known free models.

## 0.1.0

- Initial external-package release of `opencode_gateway`.
- HTTP/SSE client for an already-running `opencode serve`, version-aware across
  the V1 (`opencode-ai` 1.x) and V2 (`@opencode/cli` 2.x) server APIs.
- Qualified version windows: `1.18.34 <= v < 2.0.0` and `2.0.0 <= v < 2.1.0`
  (`1.18.35` needs no bypass variable).
- `testEnvironment`, `getConfigSchema`, `sessionCodec`, and MCP-based
  `invocation_context` runtime-tool delivery.
- Loads as an external plugin with no core changes; built-in promotion is a
  documented follow-up.
