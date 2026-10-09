# Changelog

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
