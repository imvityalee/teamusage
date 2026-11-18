import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConfigError, configPath, insecureHttpAllowedByEnv, isInsecureRemoteHttp, loadConfig, normalizeServerUrl, saveConfig, updateConfigFile, type Config } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "teamusage-config-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const full: Config = {
  serverUrl: "https://usage.example.com",
  name: "Ann",
  email: "ann@example.com",
  token: "tok-secret",
  tokenServerUrl: "https://usage.example.com",
  tokenEmail: "ann@example.com",
  lastSuccessfulSync: "2026-11-18",
  lastSyncAgents: ["claude", "codex"],
  fallbackMachineId: "f".repeat(32),
  allowInsecureHttp: true,
};
const mode = (p: string) => statSync(p).mode & 0o777;

test("configPath is under XDG_CONFIG_HOME/teamusage", () => {
  expect(configPath()).toBe(path.join(home, "teamusage", "config.json"));
});

test("save then load round-trips; file mode is 0600", () => {
  saveConfig(full);
  expect(loadConfig({})).toEqual({ ...full, sources: { serverUrl: "file" } });
  expect(mode(configPath())).toBe(0o600);
  expect(mode(path.dirname(configPath()))).toBe(0o700);
});

test("modes are set at creation, even with a permissive umask", () => {
  const old = process.umask(0);
  try {
    saveConfig(full);
  } finally {
    process.umask(old);
  }
  expect(mode(configPath())).toBe(0o600);
  expect(mode(path.dirname(configPath()))).toBe(0o700);
});

test("an existing config directory is tightened to 0700", () => {
  mkdirSync(path.join(home, "teamusage"), { mode: 0o755 });
  saveConfig(full);
  expect(mode(path.dirname(configPath()))).toBe(0o700);
});

test("save leaves no temp files behind and overwrites atomically", () => {
  saveConfig(full);
  saveConfig({ ...full, name: "Ann B" });
  expect(readdirSync(path.dirname(configPath()))).toEqual(["config.json"]);
  expect(loadConfig({})?.name).toBe("Ann B");
});

test("updateConfigFile merges into the file without pulling in env values", () => {
  updateConfigFile({ token: "t1" });
  expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ token: "t1" });
  expect(mode(configPath())).toBe(0o600);
  saveConfig(full);
  updateConfigFile({ lastSuccessfulSync: "2026-11-19" });
  expect(loadConfig({})).toEqual({ ...full, lastSuccessfulSync: "2026-11-19", sources: { serverUrl: "file" } });
});

test("env fills missing values but never overrides the file", () => {
  saveConfig({ serverUrl: "https://file.example.com", name: "File", email: "file@example.com" });
  const cfg = loadConfig({
    TEAMUSAGE_SERVER_URL: "https://env.example.com",
    TEAMUSAGE_NAME: "Env",
    TEAMUSAGE_EMAIL: "env@example.com",
    TEAMUSAGE_INVITE_CODE: "inv-env",
  });
  expect(cfg).toEqual({
    serverUrl: "https://file.example.com",
    name: "File",
    email: "file@example.com",
    inviteCode: "inv-env",
    sources: { serverUrl: "file", inviteCode: "env" },
  });
});

test("the sources of the server URL and invite code are recorded, and never written to the file", () => {
  const env = { TEAMUSAGE_SERVER_URL: "https://env.example.com", TEAMUSAGE_INVITE_CODE: "inv-env", TEAMUSAGE_NAME: "E", TEAMUSAGE_EMAIL: "e@example.com" };
  expect(loadConfig(env)?.sources).toEqual({ serverUrl: "env", inviteCode: "env" });
  saveConfig({ serverUrl: "https://file.example.com", name: "F", email: "f@example.com", inviteCode: "inv-file" });
  expect(loadConfig(env)?.sources).toEqual({ serverUrl: "file", inviteCode: "file" });
  expect(loadConfig({})?.sources).toEqual({ serverUrl: "file", inviteCode: "file" });
  saveConfig({ name: "F", email: "f@example.com", inviteCode: "inv-file" } as Config);
  expect(loadConfig(env)?.sources).toEqual({ serverUrl: "env", inviteCode: "file" });
  saveConfig({ serverUrl: "https://file.example.com", name: "F", email: "f@example.com" });
  expect(loadConfig({})?.sources).toEqual({ serverUrl: "file" });
  saveConfig({ ...loadConfig(env)!, token: "t" });
  expect(JSON.parse(readFileSync(configPath(), "utf8")).sources).toBeUndefined();
});

test("CLAUDE_PLUGIN_OPTION_* is read when TEAMUSAGE_* is absent", () => {
  const env = {
    CLAUDE_PLUGIN_OPTION_SERVER_URL: "https://plugin.example.com/",
    CLAUDE_PLUGIN_OPTION_INVITE_CODE: "inv-plugin",
    CLAUDE_PLUGIN_OPTION_NAME: "Plugin",
    CLAUDE_PLUGIN_OPTION_EMAIL: "plugin@example.com",
  };
  expect(loadConfig(env)).toEqual({
    serverUrl: "https://plugin.example.com",
    inviteCode: "inv-plugin",
    name: "Plugin",
    email: "plugin@example.com",
    sources: { serverUrl: "env", inviteCode: "env" },
  });
  expect(loadConfig({ ...env, TEAMUSAGE_NAME: "Direct" })?.name).toBe("Direct");
});

test("no file and no env → null", () => {
  expect(loadConfig({})).toBeNull();
});

test("an incomplete env without a file → null", () => {
  expect(loadConfig({ TEAMUSAGE_SERVER_URL: "https://x.example.com" })).toBeNull();
});

test("a malformed config file is an error, not silently replaced", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), "{not json");
  expect(() => loadConfig({})).toThrow(ConfigError);
  expect(() => updateConfigFile({ token: "t" })).toThrow(ConfigError);
  expect(readFileSync(configPath(), "utf8")).toBe("{not json");
});

test("normalizeServerUrl accepts http(s) and strips a trailing slash", () => {
  expect(normalizeServerUrl("https://usage.example.com/")).toBe("https://usage.example.com");
  expect(normalizeServerUrl(" http://127.0.0.1:8787 ")).toBe("http://127.0.0.1:8787");
  expect(normalizeServerUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  expect(normalizeServerUrl("http://127.4.5.6")).toBe("http://127.4.5.6");
  expect(normalizeServerUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
  expect(normalizeServerUrl("https://example.com/usage/")).toBe("https://example.com/usage");
});

test.each([
  ["ftp", "ftp://example.com"],
  ["file", "file:///etc/passwd"],
  ["javascript", "javascript:alert(1)"],
  ["no scheme", "example.com"],
  ["empty", ""],
  ["credentials", "https://user:pw@example.com"],
  ["query", "https://example.com/?a=1"],
])("normalizeServerUrl rejects %s", (_n, url) => {
  expect(() => normalizeServerUrl(url)).toThrow(ConfigError);
});

test("an invalid server URL is rejected at load, from the file or from env", () => {
  expect(() =>
    loadConfig({ TEAMUSAGE_SERVER_URL: "file:///etc/passwd", TEAMUSAGE_NAME: "A", TEAMUSAGE_EMAIL: "a@b.c" }),
  ).toThrow(ConfigError);
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ serverUrl: "ftp://x", name: "A", email: "a@b.c" }));
  expect(() => loadConfig({})).toThrow(ConfigError);
});

test("config errors do not echo file contents", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ serverUrl: "ftp://x", name: "A", email: "a@b.c", token: "tok-secret" }));
  try {
    loadConfig({});
    expect.unreachable();
  } catch (e) {
    expect(String(e)).not.toContain("tok-secret");
  }
});

test.each([
  ["a remote host", "http://usage.example.com"],
  ["a LAN address", "http://192.168.1.10:8787"],
  ["a host that only starts with 127", "http://127.example.com"],
  ["a localhost subdomain lookalike", "http://localhost.example.com"],
])("plain http to %s is rejected without the opt-in, naming the flag", (_n, url) => {
  expect(() => normalizeServerUrl(url)).toThrow(/--allow-insecure-http/);
  expect(normalizeServerUrl(url, true)).toBe(url);
  expect(isInsecureRemoteHttp(url)).toBe(true);
});

test("isInsecureRemoteHttp is false for https, loopback and garbage", () => {
  for (const u of ["https://usage.example.com", "http://localhost", "http://127.0.0.1:1", "http://[::1]", "nope"]) {
    expect(isInsecureRemoteHttp(u)).toBe(false);
  }
});

test.each([
  ["TEAMUSAGE_ALLOW_INSECURE_HTTP", "1", true],
  ["TEAMUSAGE_ALLOW_INSECURE_HTTP", "true", true],
  ["CLAUDE_PLUGIN_OPTION_ALLOW_INSECURE_HTTP", "1", true],
  ["CLAUDE_PLUGIN_OPTION_ALLOW_INSECURE_HTTP", "TRUE", true],
  ["TEAMUSAGE_ALLOW_INSECURE_HTTP", "0", false],
  ["TEAMUSAGE_ALLOW_INSECURE_HTTP", "yes", false],
  ["TEAMUSAGE_ALLOW_INSECURE_HTTP", "", false],
])("env opt-in %s=%s → %s", (key, value, allowed) => {
  expect(insecureHttpAllowedByEnv({ [key]: value })).toBe(allowed);
  const env = { TEAMUSAGE_SERVER_URL: "http://usage.example.com", TEAMUSAGE_NAME: "A", TEAMUSAGE_EMAIL: "a@b.c", [key]: value };
  if (allowed) expect(loadConfig(env)?.serverUrl).toBe("http://usage.example.com");
  else expect(() => loadConfig(env)).toThrow(/--allow-insecure-http/);
});

test("allowInsecureHttp in the file permits remote http at load", () => {
  saveConfig({ serverUrl: "http://usage.example.com", name: "A", email: "a@b.c", allowInsecureHttp: true });
  expect(loadConfig({})?.serverUrl).toBe("http://usage.example.com");
  saveConfig({ serverUrl: "http://usage.example.com", name: "A", email: "a@b.c" });
  expect(() => loadConfig({})).toThrow(/--allow-insecure-http/);
});

test.each([
  ["allowInsecureHttp as a string", { allowInsecureHttp: "true" }],
  ["lastSyncAgents not an array", { lastSyncAgents: "claude" }],
  ["lastSyncAgents with a number", { lastSyncAgents: ["claude", 1] }],
])("a malformed %s is a ConfigError", (_n, extra) => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ serverUrl: "https://x.example.com", name: "A", email: "a@b.c", ...extra }));
  expect(() => loadConfig({})).toThrow(ConfigError);
});
