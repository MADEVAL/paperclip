import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  apiUrl,
  buildBasicAuthHeader,
  detectOpenCodeServerInfo,
  fetchFailureMessage,
  type OpenCodeConnection,
} from "./transport.js";
import {
  isQualifiedOpenCodeVersion,
  qualifiedOpenCodeWindows,
  unqualifiedOpenCodeVersionMessage,
  type OpenCodeApiVersion,
} from "./protocol.js";
import { parseGatewayConfig } from "./config.js";
import {
  allowsInsecureRemoteHttp,
  isLoopbackHostname,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";
import { DEFAULT_SERVER_USERNAME } from "../shared/constants.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function result(
  ctx: AdapterEnvironmentTestContext,
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult {
  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const cfg = parseGatewayConfig(config);

  if (!cfg.apiBaseUrl) {
    checks.push({
      code: "opencode_gateway_api_base_url_missing",
      level: "error",
      message: "OpenCode Gateway requires apiBaseUrl.",
      hint: "Run `opencode serve --port 4096` and set apiBaseUrl, for example http://127.0.0.1:4096.",
    });
  } else if (!cfg.baseUrl) {
    checks.push({
      code: "opencode_gateway_api_base_url_invalid",
      level: "error",
      message: "apiBaseUrl must be an http:// or https:// URL.",
    });
  } else {
    checks.push({
      code: "opencode_gateway_api_base_url_valid",
      level: "info",
      message: `Configured OpenCode server: ${cfg.baseUrl.toString()}`,
    });
    if (isRemotePlainHttp(cfg.baseUrl) && !allowsInsecureRemoteHttp(config)) {
      checks.push({
        code: "opencode_gateway_plain_http_remote_denied",
        level: "error",
        message: remotePlainHttpDeniedMessage(cfg.baseUrl.hostname),
        hint: "Use https:// (TLS) or a private overlay network, or enable adapterConfig.dangerouslyAllowInsecureRemoteHttp only for a trusted local network. Loopback http://localhost and http://127.0.0.1 remain allowed.",
      });
    } else if (isRemotePlainHttp(cfg.baseUrl)) {
      checks.push({
        code: "opencode_gateway_plain_http_remote_unsafe_allowed",
        level: "warn",
        message: "Unsafe dev escape hatch enabled for non-loopback HTTP OpenCode traffic.",
        hint: "Remove the escape hatch and use TLS before sending real credentials across a network.",
      });
    } else if (cfg.baseUrl.protocol === "http:" && isLoopbackHostname(cfg.baseUrl.hostname)) {
      checks.push({
        code: "opencode_gateway_loopback_http_allowed",
        level: "info",
        message: "Loopback HTTP OpenCode server URL is allowed.",
      });
    }
  }

  if (!cfg.password && !cfg.allowNoAuth) {
    checks.push({
      code: "opencode_gateway_password_missing",
      level: "error",
      message: "OpenCode Gateway requires a server password, unless you connect to a V1 server that runs without auth.",
      hint: "If `opencode serve` did not have OPENCODE_SERVER_PASSWORD set, it generated one and printed `server password <value>` at startup — copy that value into adapterConfig.password. Only a V1 server without auth can use 'Connect without a password' instead; V2 always requires a password.",
    });
  } else if (!cfg.password && cfg.allowNoAuth) {
    checks.push({
      code: "opencode_gateway_no_auth_selected",
      level: "info",
      message: "Configured to connect without basic auth (V1 only).",
      hint: "V2 always requires a password; this mode works only against a V1 server that runs without auth. Only do this on loopback or a trusted private network; an unauthenticated server lets anyone on the network drive this agent.",
    });
  } else if (cfg.username !== DEFAULT_SERVER_USERNAME) {
    checks.push({
      code: "opencode_gateway_custom_username",
      level: "info",
      message: `Using custom basic-auth username "${cfg.username}".`,
      hint: "OpenCode V2 hard-codes the username to opencode; a custom username only works on V1.",
    });
  }

  const authReady = Boolean(cfg.password) || cfg.allowNoAuth;
  if (checks.some((check) => check.level === "error") || !cfg.baseUrl || !authReady) {
    return result(ctx, checks);
  }

  if (cfg.allowNoAuth && cfg.baseUrl && !cfg.password && !isLoopbackHostname(cfg.baseUrl.hostname)) {
    checks.push({
      code: "opencode_gateway_no_auth_remote",
      level: "warn",
      message: `Connecting without basic auth to non-loopback host "${cfg.baseUrl.hostname}".`,
      hint: "An unauthenticated server exposes the agent, its workspace, and its providers to the whole network. V2 always requires a password, so this only works against a V1 server.",
    });
  }

  const connection: OpenCodeConnection = {
    baseUrl: cfg.baseUrl,
    authHeader: cfg.password ? buildBasicAuthHeader(cfg.username, cfg.password) : null,
    extraHeaders: cfg.extraHeaders,
    fetchImpl: fetch,
  };

  let info;
  try {
    info = await detectOpenCodeServerInfo(connection, cfg.versionOverride);
  } catch (err) {
    checks.push({
      code: "opencode_gateway_unreachable",
      level: "error",
      message: "Could not reach the OpenCode server.",
      detail: fetchFailureMessage(err),
      hint: "Check apiBaseUrl and that `opencode serve` is running where Paperclip can reach it.",
    });
    return result(ctx, checks);
  }

  // Probe the resolved endpoint explicitly so auth failures are distinguishable
  // from a wrong path (auth failure probes return a non-2xx status).
  const probePath = info.reachable && info.apiVersion === "v2" ? "/api/info" : "/global/health";
  let probeStatus: number | null = null;
  try {
    const response = await fetch(apiUrl(cfg.baseUrl, probePath), {
      method: "GET",
      headers: {
        ...connection.extraHeaders,
        Accept: "application/json",
        ...(connection.authHeader ? { Authorization: connection.authHeader } : {}),
      },
      signal: AbortSignal.timeout(3_000),
    });
    probeStatus = response.status;
  } catch (err) {
    checks.push({
      code: "opencode_gateway_probe_error",
      level: "error",
      message: "OpenCode server probe failed.",
      detail: fetchFailureMessage(err),
      hint: "Verify network reachability from the Paperclip server host.",
    });
    return result(ctx, checks);
  }

  if (probeStatus === 401 || probeStatus === 403) {
    checks.push({
      code: "opencode_gateway_auth_failed",
      level: "error",
      message: `OpenCode server rejected basic auth (HTTP ${probeStatus}).`,
      hint: "Check adapterConfig.password against OPENCODE_SERVER_PASSWORD (and username against OPENCODE_SERVER_USERNAME on V1).",
    });
    return result(ctx, checks);
  }
  if (probeStatus >= 400) {
    checks.push({
      code: "opencode_gateway_probe_http_error",
      level: "error",
      message: `OpenCode server probe returned HTTP ${probeStatus}.`,
      hint: "Confirm the server version and that the server exposes the V1 (/global/health) or V2 (/api/info) API.",
    });
    return result(ctx, checks);
  }

  if (!info.reachable) {
    checks.push({
      code: "opencode_gateway_probe_unrecognized",
      level: "warn",
      message: "OpenCode server answered but neither /global/health nor /api/info returned a version.",
      hint: "Confirm you are pointing apiBaseUrl at `opencode serve`, not the OpenCode CLI or dashboard.",
    });
    return result(ctx, checks);
  }

  checks.push({
    code: "opencode_gateway_reachable",
    level: "info",
    message: `OpenCode server is reachable (${info.apiVersion === "v2" ? "V2 /api/info" : "V1 /global/health"}).`,
  });

  if (info.version) {
    const qualified = isQualifiedOpenCodeVersion(info.version);
    // Mirror execute(): an explicit `adapterConfig.version` pin is the operator
    // accepting an unverified release, so it must not fail the environment test
    // either. Auto-detect stays strict and still needs the bypass env var.
    const pinned = cfg.versionOverride !== "auto";
    checks.push({
      code: qualified
        ? "opencode_gateway_version_qualified"
        : "opencode_gateway_version_unqualified",
      level: qualified ? "info" : pinned ? "warn" : "error",
      message: qualified
        ? `OpenCode ${info.version} is within a qualified protocol window.`
        : pinned
          ? `OpenCode ${info.version} is outside the qualified window (${qualifiedOpenCodeWindows()}); adapterConfig.version pins ${cfg.versionOverride}, so Paperclip uses that protocol family.`
          : unqualifiedOpenCodeVersionMessage(info.version),
    });
  } else {
    checks.push({
      code: "opencode_gateway_version_unknown",
      level: "warn",
      message: "OpenCode server did not report a semantic version.",
      hint: "Pin adapterConfig.version to v1 or v2 to force the protocol family and read the version from that endpoint.",
    });
  }

  checks.push({
    code: "opencode_gateway_gateway_owns_providers",
    level: "warn",
    message: "The OpenCode server owns provider credentials and model routing; Paperclip does not manage them.",
    hint: "Configure providers on the gateway host. One server can serve many companies, so isolate or dedicate servers per tenant.",
  });

  if (!cfg.directory) {
    checks.push({
      code: "opencode_gateway_workspace_not_configured",
      level: "warn",
      message: "No adapterConfig.directory set. OpenCode resolves sessions against its own working directory.",
      hint: "Set directory to a path the gateway host can see (co-location or a shared volume). Paperclip does not manage the gateway workspace.",
    });
  }

  return result(ctx, checks);
}

// Kept for callers that want the resolved protocol family without booting a client.
export type { OpenCodeApiVersion };
