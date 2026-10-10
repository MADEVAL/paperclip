export const ADAPTER_TYPE = "opencode_gateway";
export const ADAPTER_LABEL = "OpenCode Gateway";

export const DEFAULT_TIMEOUT_SEC = 600;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const STOP_GRACE_MS = 10_000;

/**
 * V1 lets the operator choose the basic-auth username; V2 hard-codes it.
 * `opencode` is the OpenCode default when `OPENCODE_SERVER_USERNAME` is unset.
 */
export const DEFAULT_SERVER_USERNAME = "opencode";

export const INSECURE_REMOTE_HTTP_ESCAPE_HATCH = "dangerouslyAllowInsecureRemoteHttp";

/**
 * Set to `1`/`true`/`yes` to admit an OpenCode server version that is outside
 * the qualified windows. Kept behind an explicit operator opt-in because a
 * mismatched server protocol can silently corrupt a run rather than fail it.
 */
export const ALLOW_UNQUALIFIED_VERSION_ENV = "PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_GATEWAY_VERSION";
