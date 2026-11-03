import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "@paperclipai/adapter-utils/openrouter-attribution";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";
import {
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME,
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_SOURCE,
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_DIR,
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_PACKAGE_JSON,
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_SOURCE,
} from "./windows-utf8.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("stages a relocatable sandbox shell hook without changing the parent environment", async () => {
    const configHome = await makeConfigHome({ plugin: ["operator-plugin"], permission: { bash: "ask" } });
    const input = { env: { XDG_CONFIG_HOME: configHome }, config: { dangerouslySkipPermissions: false }, sandboxToolOomPreference: true };
    const prepared = await prepareOpenCodeRuntimeConfig(input);
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const copiedHome = await makeConfigHome();
    const relocated = path.join(copiedHome, "remote config 'with spaces'");
    await fs.cp(prepared.env.XDG_CONFIG_HOME, relocated, { recursive: true });
    await prepared.cleanup();
    const pluginDir = path.join(relocated, "opencode", "plugins");
    const plugins = await fs.readdir(pluginDir);
    expect(plugins).toHaveLength(1);
    const pluginUrl = pathToFileURL(path.join(pluginDir, plugins[0]!)).href;
    const hookEnv = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      Object.defineProperty(process, "platform", { value: "linux" });
      delete process.env.BASH_ENV;
      const hooks = await Object.values(await import(${JSON.stringify(pluginUrl)}))[0]();
      const output = { env: {} };
      await hooks["shell.env"]({}, output);
      console.log(JSON.stringify({ child: output.env, parent: process.env.BASH_ENV ?? null }));
    `], { encoding: "utf8" }));
    expect(hookEnv.parent).toBeNull();
    expect(hookEnv.child.BASH_ENV).toContain(relocated);
    const command = spawnSync("bash", ["-c", 'printf "%s" "$1"; exit 7', "bash", "literal ' $() value"], {
      env: { ...process.env, ...hookEnv.child }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(command.stdout).toBe("literal ' $() value");
    expect(command.status).toBe(7);
    if (process.platform === "linux") {
      const parentScore = await fs.readFile("/proc/self/oom_score_adj", "utf8");
      expect(execFileSync("bash", ["-c", "cat /proc/self/oom_score_adj"], {
        env: { ...process.env, ...hookEnv.child }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim()).toBe("1000");
      expect(await fs.readFile("/proc/self/oom_score_adj", "utf8")).toBe(parentScore);
    }
    const config = JSON.parse(await fs.readFile(path.join(relocated, "opencode", "opencode.json"), "utf8"));
    expect(config).toMatchObject({ plugin: ["operator-plugin"], permission: { bash: "ask" } });
    expect(prepared.env).not.toHaveProperty("BASH_ENV");
  });

  it("preserves operator shell setup and leaves other platforms and local runs alone", async () => {
    const configHome = await makeConfigHome();
    const input = { env: { XDG_CONFIG_HOME: configHome }, config: {}, sandboxToolOomPreference: true };
    const prepared = await prepareOpenCodeRuntimeConfig(input);
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const pluginDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    const pluginUrl = pathToFileURL(path.join(pluginDir, (await fs.readdir(pluginDir))[0]!)).href;
    for (const scenario of [
      { platform: "linux", parent: "/operator/setup.sh", child: {} },
      { platform: "linux", parent: "", child: {} },
      { platform: "linux", parent: null, child: { BASH_ENV: "/other-plugin/setup.sh" } },
      { platform: "darwin", parent: null, child: {} },
    ]) {
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        const scenario = ${JSON.stringify(scenario)};
        Object.defineProperty(process, "platform", { value: scenario.platform });
        if (scenario.parent === null) delete process.env.BASH_ENV;
        else process.env.BASH_ENV = scenario.parent;
        const hooks = await Object.values(await import(${JSON.stringify(pluginUrl)}))[0]();
        const output = { env: scenario.child };
        await hooks["shell.env"]({}, output);
        console.log(JSON.stringify(output.env));
      `], { encoding: "utf8" }));
      expect(result).toEqual(scenario.child);
    }
    const local = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {} });
    cleanupPaths.add(local.env.XDG_CONFIG_HOME);
    expect(await fs.readdir(path.join(local.env.XDG_CONFIG_HOME, "opencode"))).toEqual(["opencode.json"]);
  });

  it("keeps the existing runtime usable when the optional plugin cannot be installed", async () => {
    const configHome = await makeConfigHome({ theme: "system" });
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("fixture write denied"));
    try {
      const input = { env: { XDG_CONFIG_HOME: configHome }, config: {}, sandboxToolOomPreference: true };
      const prepared = await prepareOpenCodeRuntimeConfig(input);
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const dir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode");
      expect(await fs.readdir(path.join(dir, "plugins"))).toEqual([]);
      expect(await fs.readdir(dir)).toEqual(["opencode.json", "plugins"]);
      expect(prepared.notes.some(note => note.startsWith("Could not prepare"))).toBe(true);
      expect(JSON.parse(await fs.readFile(path.join(dir, "opencode.json"), "utf8"))).toMatchObject({ theme: "system" });
    } finally {
      rename.mockRestore();
    }
  });

  it("materializes linked plugin directories without writing into the operator configuration", async () => {
    const configHome = await makeConfigHome();
    const operatorRoot = await makeConfigHome();
    const operatorPlugins = path.join(operatorRoot, "plugins");
    await fs.mkdir(operatorPlugins);
    const operatorPlugin = "export const Operator = async () => ({});\n";
    await fs.writeFile(path.join(operatorPlugins, "operator.js"), operatorPlugin);
    await fs.symlink(operatorPlugins, path.join(configHome, "opencode", "plugins"), "dir");
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome }, config: {}, sandboxToolOomPreference: true,
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    expect(await fs.readdir(operatorPlugins)).toEqual(["operator.js"]);
    const plugins = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    expect((await fs.lstat(plugins)).isDirectory()).toBe(true);
    expect(await fs.readdir(plugins)).toHaveLength(2);
    expect(await fs.readFile(path.join(plugins, "operator.js"), "utf8")).toBe(operatorPlugin);
    await prepared.cleanup();
    expect(await fs.readdir(operatorPlugins)).toEqual(["operator.js"]);
    expect((await fs.lstat(path.join(configHome, "opencode", "plugins"))).isSymbolicLink()).toBe(true);
  });

  it("attributes custom OpenRouter aliases and inline overrides without changing other endpoints", async () => {
    const other = { options: { baseURL: "https://other.example/v1", headers: { "X-Title": "Other" } } };
    const configHome = await makeConfigHome({ provider: { other, openrouter: other } });
    const prepared = await prepareOpenCodeRuntimeConfig({ env: {
      XDG_CONFIG_HOME: configHome,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { alias: {
        options: { baseURL: "https://openrouter.ai/api/v1", apiKey: "fixture-key", headers: { "http-referer": "https://harness.example", "X-Route": "selected" } },
        models: { model: { headers: { "x-title": "Harness" } } },
      } } }),
    }, config: {} });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const { alias } = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT).provider;
    expect(alias.options).toMatchObject({ apiKey: "fixture-key", headers: { ...OPENROUTER_ATTRIBUTION_HEADERS, "X-Route": "selected" } });
    expect(alias.options.headers).not.toHaveProperty("http-referer");
    expect(alias.models.model.headers).toEqual(OPENROUTER_ATTRIBUTION_HEADERS);
    const config = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"));
    expect(config.provider.other).toEqual(other);
    expect(config.provider.openrouter).toEqual(other);
    await prepared.cleanup();
  });

  it("allows all tools and connected tools by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
        bash: "ask",
        "mcp__example__write": "deny",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      theme: "system",
      permission: "allow",
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("writes native V2 permissions and drops the V1 permission key for 2.x", async () => {
    const configHome = await makeConfigHome({
      permission: { read: "ask" },
      permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      openCodeV2: true,
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    // V1 rejects the `permissions` key and V2 gives it precedence over
    // `permission`, so exactly one shape must be written.
    expect(runtimeConfig).not.toHaveProperty("permission");
    expect(runtimeConfig.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ]);
    expect(prepared.notes.some((n) => n.includes("V2 permissions"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("merges custom providers from PAPERCLIP_OPENCODE_PROVIDERS into the config", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bifrost EU",
        options: {
          baseURL: "http://gateway.example.svc.cluster.local:8080/v1",
          apiKey: "{env:ANTHROPIC_API_KEY}",
        },
        models: { "example/model-a": { name: "Model A" } },
      },
    };

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      permission: "allow",
      provider: providers,
    });
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);
    await prepared.cleanup();
  });

  it("reads PAPERCLIP_OPENCODE_PROVIDERS from process.env when absent from the run env", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } };
    process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({ provider: providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders in custom providers using the run/process env (bakes the literal vk)", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://bifrost/v1", apiKey: "{env:ANTHROPIC_API_KEY}" },
        models: { "example/model-a": {} },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers), ANTHROPIC_API_KEY: "sk-bf-REALVK" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    // The {env:...} placeholder must be replaced with the literal value, so OpenCode
    // does not depend on its sandboxed process env carrying the key.
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { options: { apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" }, models: { "x/y": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("pins small_model from PAPERCLIP_OPENCODE_SMALL_MODEL", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_SMALL_MODEL: "example/model-a" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { small_model?: string };
    expect(runtimeConfig.small_model).toBe("example/model-a");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OPENCODE_PROVIDERS without writing a provider block and surfaces a note", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "not json" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toMatchObject({ openrouter: { options: { headers: { "HTTP-Referer": "https://paperclip.ing" } } } });
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OPENCODE_PROVIDERS is valid JSON but not an object", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "[1,2,3]" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toMatchObject({ openrouter: { options: { headers: { "HTTP-Referer": "https://paperclip.ing" } } } });
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries with non-object values and keeps the usable ones", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
          bifrost: "http://gateway.example/v1",
          usable: { options: { baseURL: "http://gateway.example/v1" } },
        }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, unknown> };
    expect(runtimeConfig.provider?.usable).toBeDefined();
    expect(runtimeConfig.provider?.bifrost).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries when no usable entries remain", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1" }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toMatchObject({ openrouter: { options: { headers: { "HTTP-Referer": "https://paperclip.ing" } } } });
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("registers a configured model missing from the catalog on its provider", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual({
      "openai/gpt-oss-120b:nitro": { headers: OPENROUTER_ATTRIBUTION_HEADERS },
    });
    expect(prepared.notes).toContain(
      "Registered configured model openrouter/openai/gpt-oss-120b:nitro in the runtime OpenCode config.",
    );
    await prepared.cleanup();
  });

  it("does not clobber an explicit model definition when registering the configured model", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      openrouter: {
        models: {
          "openai/gpt-oss-120b:nitro": { name: "GPT-OSS 120B (nitro)" },
          "example/other": {},
        },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual(Object.fromEntries(
      Object.entries(providers.openrouter.models).map(([id, model]) => [id, { ...model, headers: OPENROUTER_ATTRIBUTION_HEADERS }]),
    ));
    expect(
      prepared.notes.some((note) => note.startsWith("Registered configured model")),
    ).toBe(false);
    await prepared.cleanup();
  });

  it("skips model registration when the configured model is not provider/model shaped", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "not-a-provider-model" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toMatchObject({ openrouter: { options: { headers: { "HTTP-Referer": "https://paperclip.ing" } } } });
    await prepared.cleanup();
  });

  it("preserves permission settings while attributing OpenRouter when skip-permissions is off", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      platform: "linux",
    });

    const config = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"));
    expect(config.permission).toBeUndefined();
    expect(config.provider.openrouter.options.headers["HTTP-Referer"]).toBe("https://paperclip.ing");
    await prepared.cleanup();
  });

  it("does not inject the Windows UTF-8 shell plugin for a remote target", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "win32",
      targetIsRemote: true,
    });
    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("injects the Windows UTF-8 shell plugin for the V1 config on Windows", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "win32",
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const configDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode");
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
    ) as { plugin?: unknown[] };
    const pluginRef = `./${PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME}`;
    expect(runtimeConfig.plugin).toEqual([pluginRef]);
    await expect(
      fs.readFile(path.join(configDir, PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME), "utf8"),
    ).resolves.toBe(PAPERCLIP_WINDOWS_UTF8_PLUGIN_SOURCE);
    expect(prepared.notes.some((note) => note.includes("Windows UTF-8 shell plugin"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("does not inject the Windows UTF-8 shell plugin off Windows", async () => {
    const linuxHome = await makeConfigHome({ permission: { read: "allow" } });
    const linuxPrepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: linuxHome },
      config: {},
      platform: "linux",
    });
    cleanupPaths.add(linuxPrepared.env.XDG_CONFIG_HOME);
    const linuxConfig = JSON.parse(
      await fs.readFile(path.join(linuxPrepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { plugin?: unknown; plugins?: unknown };
    expect(linuxConfig.plugin).toBeUndefined();
    expect(linuxConfig.plugins).toBeUndefined();
    await linuxPrepared.cleanup();
    cleanupPaths.delete(linuxPrepared.env.XDG_CONFIG_HOME);
  });

  it("injects the OpenCode 2 Windows UTF-8 shell plugin as a loadable plugin directory", async () => {
    const v2Home = await makeConfigHome({ permission: { read: "allow" } });
    const v2Prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: v2Home },
      config: {},
      platform: "win32",
      openCodeV2: true,
    });
    cleanupPaths.add(v2Prepared.env.XDG_CONFIG_HOME);
    const configDir = path.join(v2Prepared.env.XDG_CONFIG_HOME, "opencode");
    const v2Config = JSON.parse(
      await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
    ) as { plugin?: unknown; plugins?: unknown[] };
    // V1 keys must not leak into the V2 config shape.
    expect(v2Config.plugin).toBeUndefined();
    const pluginRef = `./plugins/${PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_DIR}`;
    expect(v2Config.plugins).toEqual([pluginRef]);
    const pluginDir = path.join(configDir, "plugins", PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_DIR);
    await expect(fs.readFile(path.join(pluginDir, "package.json"), "utf8")).resolves.toBe(
      PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_PACKAGE_JSON,
    );
    await expect(fs.readFile(path.join(pluginDir, "index.ts"), "utf8")).resolves.toBe(
      PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_SOURCE,
    );
    expect(PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_SOURCE).toContain('ctx.shell.hook("create.before"');
    expect(PAPERCLIP_WINDOWS_UTF8_PLUGIN_V2_SOURCE).toContain("Invoke-RestMethod:ContentType");
    expect(v2Prepared.notes.some((note) => note.includes("OpenCode 2 Windows UTF-8 shell plugin"))).toBe(true);
    await v2Prepared.cleanup();
    cleanupPaths.delete(v2Prepared.env.XDG_CONFIG_HOME);
  });

  it("preserves an existing plugin array and appends the Windows UTF-8 plugin once", async () => {
    const configHome = await makeConfigHome({
      permission: { read: "allow" },
      plugin: ["file:///existing/plugin.js"],
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "win32",
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const configDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode");
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
    ) as { plugin?: unknown[] };
    const pluginRef = `./${PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME}`;
    expect(runtimeConfig.plugin).toEqual(["file:///existing/plugin.js", pluginRef]);
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("ships a loadable plugin that forces UTF-8 and is idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-utf8-plugin-"));
    cleanupPaths.add(dir);
    const pluginFile = path.join(dir, "paperclip-windows-utf8.mjs");
    await fs.writeFile(pluginFile, PAPERCLIP_WINDOWS_UTF8_PLUGIN_SOURCE, "utf8");

    const mod = (await import(pathToFileURL(pluginFile).href)) as {
      PaperclipWindowsUtf8: () => Promise<{
        "tool.execute.before": (
          input: { tool: string },
          output: { args: { command: string } },
        ) => Promise<void>;
      }>;
    };
    const hooks = await mod.PaperclipWindowsUtf8();

    // The plugin reads `process.platform`. Force the Windows branch so this test
    // exercises the rewrite on every host, including Linux CI.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      // A plain shell command gets the console and $OutputEncoding fix and keeps
      // its original text inside the outer scriptblock.
      const plain = { args: { command: "Write-Output 'Привет'" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, plain);
      expect(plain.args.command).toContain("PAPERCLIP_WINDOWS_UTF8");
      expect(plain.args.command).toContain("[Console]::OutputEncoding");
      expect(plain.args.command).toContain("$OutputEncoding");
      expect(plain.args.command).not.toContain("Invoke-RestMethod:ContentType");
      expect(plain.args.command).toContain("& {Write-Output 'Привет'\n};");

      // A JSON request also gets the UTF-8 request content type default.
      const json = {
        args: { command: "Invoke-RestMethod -Uri $u -Headers @{'Content-Type'='application/json'} -Body $b" },
      };
      await hooks["tool.execute.before"]({ tool: "shell" }, json);
      expect(json.args.command).toContain("Invoke-RestMethod:ContentType");
      expect(json.args.command).toContain("Invoke-WebRequest:ContentType");

      // Regression: the agent replays a partial UTF-8 preamble it saw in its own
      // history (the marker and some encodings) but drops the request content
      // type. The hook must still add the UTF-8 content-type default; otherwise
      // PowerShell 5.1 encodes the non-ASCII string body as ASCII ("?").
      const partialPreamble =
        "$env:PAPERCLIP_WINDOWS_UTF8='1';" +
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" +
        "$OutputEncoding=[System.Text.UTF8Encoding]::new($false);";
      const replayedJson = {
        args: {
          command:
            partialPreamble +
            "$h=@{'Content-Type'='application/json'}; $body=@{title='Привет'}|ConvertTo-Json; " +
            "Invoke-RestMethod -Uri $u -Headers $h -Method Put -Body $body",
        },
      };
      await hooks["tool.execute.before"]({ tool: "bash" }, replayedJson);
      expect(replayedJson.args.command).toContain("Invoke-RestMethod:ContentType");
      expect(replayedJson.args.command).toContain("[Console]::InputEncoding");

      // A ConvertTo-Json body without the literal application/json still gets the
      // UTF-8 content-type default.
      const convertedJson = {
        args: {
          command:
            "$body=@{title='Привет'}|ConvertTo-Json; Invoke-RestMethod -Uri $u -Method Post -Body $body",
        },
      };
      await hooks["tool.execute.before"]({ tool: "shell" }, convertedJson);
      expect(convertedJson.args.command).toContain("Invoke-RestMethod:ContentType");

      // An explicit -ContentType application/json wins over the default parameter,
      // so the literal itself must carry the charset or the body degrades to "?".
      const explicitContentType = {
        args: {
          command:
            "$body=@{title='Привет'}|ConvertTo-Json; Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json' -Body $body",
        },
      };
      await hooks["tool.execute.before"]({ tool: "shell" }, explicitContentType);
      expect(explicitContentType.args.command).toContain("application/json; charset=utf-8");
      expect(explicitContentType.args.command).not.toContain("-ContentType 'application/json'");

      // A command that already carries the complete settings is not re-injected.
      const fullSettingsCommand = replayedJson.args.command;
      await hooks["tool.execute.before"]({ tool: "bash" }, replayedJson);
      expect(replayedJson.args.command).toBe(fullSettingsCommand);

      // A non-JSON request keeps its own content type: no JSON default is added.
      const form = { args: { command: "Invoke-RestMethod -Uri https://example.test/form -Body 'name=alice'" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, form);
      expect(form.args.command).not.toContain("Invoke-RestMethod:ContentType");

      // A comment-prefixed command still gets the fix: the comment may precede
      // the executable statement inside the scriptblock.
      const commentCmd = { args: { command: "# note\nWrite-Output 'Привет'" } };
      await hooks["tool.execute.before"]({ tool: "shell" }, commentCmd);
      expect(commentCmd.args.command).toContain("PAPERCLIP_WINDOWS_UTF8");
      expect(commentCmd.args.command).toContain("& {# note\nWrite-Output 'Привет'\n};");

      // A command whose first non-comment token is a `using` statement is left
      // unchanged: `using` must stay first and cannot live inside a scriptblock.
      const usingCommands = [
        "using namespace System.Text; [Encoding]::UTF8.GetBytes('Привет')",
        "<# note #>using namespace System.Text; Write-Output 'Привет'",
      ];
      for (const usingCommand of usingCommands) {
        const usingArgs = { args: { command: usingCommand } };
        await hooks["tool.execute.before"]({ tool: "shell" }, usingArgs);
        expect(usingArgs.args.command).toBe(usingCommand);
      }

      // Wrappable top-level constructs (`param`, `begin`/`process`/`end` blocks)
      // stay valid because the original text runs inside the outer scriptblock.
      const wrappedCommands = [
        "param([string]$text = 'Привет'); Write-Output $text",
        "param([string]$text = ')'); Write-Output $text",
        "begin { Write-Output 'Привет' }",
        "process { Write-Output 'Привет' }",
        "end { Write-Output 'Привет' }",
      ];
      for (const wrappedCommand of wrappedCommands) {
        const wrappedArgs = { args: { command: wrappedCommand } };
        await hooks["tool.execute.before"]({ tool: "shell" }, wrappedArgs);
        expect(wrappedArgs.args.command).toContain("PAPERCLIP_WINDOWS_UTF8");
        expect(wrappedArgs.args.command).toContain(`& {${wrappedCommand}\n};`);
      }

      // Second pass must not double-prefix.
      const once = plain.args.command;
      await hooks["tool.execute.before"]({ tool: "bash" }, plain);
      expect(plain.args.command).toBe(once);

      // Non-shell tools are never rewritten.
      const readOutput = { args: { command: "cat file" } };
      await hooks["tool.execute.before"]({ tool: "read" }, readOutput);
      expect(readOutput.args.command).toBe("cat file");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }

    // Off Windows the hook is a no-op.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const linuxOutput = { args: { command: "Write-Output 'Привет'" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, linuxOutput);
      expect(linuxOutput.args.command).toBe("Write-Output 'Привет'");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }

    await fs.rm(dir, { recursive: true, force: true });
    cleanupPaths.delete(dir);
  });
});
