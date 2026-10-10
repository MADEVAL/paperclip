# Changelog

## Unreleased

- `password` is now optional. A new `allowNoAuth` toggle connects to an OpenCode
  server that runs without basic auth (no `OPENCODE_SERVER_PASSWORD`); the
  adapter sends no `Authorization` header and warns for non-loopback hosts.
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
