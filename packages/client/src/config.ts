import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_NAME, ENV_PREFIX } from "@teamusage/shared";

export interface Config {
  serverUrl: string;
  name: string;
  email: string;
  token?: string;
  inviteCode?: string;
  /** The normalised server URL and lower-cased email the token was issued for. */
  tokenServerUrl?: string;
  tokenEmail?: string;
  lastSuccessfulSync?: string; // YYYY-MM-DD
  lastSyncAgents?: string[]; // sorted agent ids seen by the last successful sync
  fallbackMachineId?: string;
  allowInsecureHttp?: boolean;
  /**
   * Where `loadConfig` found the server URL and invite code: the config file or the environment (including the
   * plugin's settings). Set by `loadConfig` only and never written to the file.
   */
  sources?: { serverUrl: ConfigSource; inviteCode?: ConfigSource };
}

export type ConfigSource = "file" | "env";

/** Fields this tool writes back after a sync; everything else in the file is left as it is. */
export type ConfigUpdate = Pick<
  Config,
  "token" | "tokenServerUrl" | "tokenEmail" | "lastSuccessfulSync" | "lastSyncAgents" | "fallbackMachineId"
>;

/** Its messages are fixed text and never include file contents, tokens or invite codes. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const STRING_KEYS = [
  "serverUrl",
  "name",
  "email",
  "token",
  "inviteCode",
  "tokenServerUrl",
  "tokenEmail",
  "lastSuccessfulSync",
  "fallbackMachineId",
] as const;
const KEYS = [...STRING_KEYS, "lastSyncAgents", "allowInsecureHttp"] as const;
const ENV_KEYS = { serverUrl: "SERVER_URL", inviteCode: "INVITE_CODE", name: "NAME", email: "EMAIL" } as const;
const PLUGIN_PREFIX = "CLAUDE_PLUGIN_OPTION_";

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, APP_NAME);
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/** True for a valid plain-http URL whose host is not loopback, i.e. one that needs the explicit opt-in. */
export function isInsecureRemoteHttp(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" && !isLoopback(u.hostname);
  } catch {
    return false;
  }
}

/** TEAMUSAGE_ALLOW_INSECURE_HTTP or CLAUDE_PLUGIN_OPTION_ALLOW_INSECURE_HTTP set to "1" or "true". */
export function insecureHttpAllowedByEnv(env: NodeJS.ProcessEnv): boolean {
  return [env[`${ENV_PREFIX}ALLOW_INSECURE_HTTP`], env[`${PLUGIN_PREFIX}ALLOW_INSECURE_HTTP`]].some((v) =>
    ["1", "true"].includes((v ?? "").trim().toLowerCase()),
  );
}

/**
 * https always; plain http only for loopback hosts unless `allowInsecureHttp`.
 * No credentials, query or fragment; trailing slashes removed.
 */
export function normalizeServerUrl(raw: string, allowInsecureHttp = false): string {
  const bad = new ConfigError("server URL must look like https://host[:port][/path]");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw bad;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad;
  if (u.username || u.password || u.search || u.hash || !u.hostname) throw bad;
  if (u.protocol === "http:" && !isLoopback(u.hostname) && !allowInsecureHttp) {
    throw new ConfigError(
      "plain http is allowed only for localhost; use https, or opt in with `teamusage setup --allow-insecure-http` " +
        "(or TEAMUSAGE_ALLOW_INSECURE_HTTP=1)",
    );
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Only what is in the file (fields may be missing); null when there is no file. */
export function readConfigFile(): Partial<Config> | null {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError("could not read the config file");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ConfigError("the config file is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ConfigError("the config file is malformed");
  }
  const obj = data as Record<string, unknown>;
  const out: Partial<Config> = {};
  for (const k of STRING_KEYS) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new ConfigError(`the config file is malformed (${k})`);
    out[k] = v;
  }
  if (obj.allowInsecureHttp !== undefined) {
    if (typeof obj.allowInsecureHttp !== "boolean") throw new ConfigError("the config file is malformed (allowInsecureHttp)");
    out.allowInsecureHttp = obj.allowInsecureHttp;
  }
  if (obj.lastSyncAgents !== undefined) {
    const a = obj.lastSyncAgents;
    if (!Array.isArray(a) || !a.every((x) => typeof x === "string" && x.length > 0)) {
      throw new ConfigError("the config file is malformed (lastSyncAgents)");
    }
    out.lastSyncAgents = a as string[];
  }
  if (out.lastSuccessfulSync !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(out.lastSuccessfulSync)) {
    throw new ConfigError("the config file is malformed (lastSuccessfulSync)");
  }
  if (out.fallbackMachineId !== undefined && !/^[a-f0-9]{32}$/.test(out.fallbackMachineId)) {
    throw new ConfigError("the config file is malformed (fallbackMachineId)");
  }
  return out;
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<Config> {
  const out: Partial<Config> = {};
  for (const [key, suffix] of Object.entries(ENV_KEYS) as [keyof typeof ENV_KEYS, string][]) {
    const v = env[`${ENV_PREFIX}${suffix}`]?.trim() || env[`${PLUGIN_PREFIX}${suffix}`]?.trim();
    if (v) out[key] = v;
  }
  return out;
}

/** The file merged with env (env fills gaps only); null unless server URL, name and email are all known. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const file = readConfigFile() ?? {};
  const envValues = fromEnv(env);
  const merged: Partial<Config> = { ...file };
  for (const k of Object.keys(envValues) as (keyof typeof ENV_KEYS)[]) {
    if (merged[k] === undefined || merged[k] === "") merged[k] = envValues[k];
  }
  if (!merged.serverUrl || !merged.name || !merged.email) return null;
  const allowInsecureHttp = file.allowInsecureHttp === true || insecureHttpAllowedByEnv(env);
  const source = (k: "serverUrl" | "inviteCode"): ConfigSource => (file[k] ? "file" : "env");
  const cfg: Config = {
    ...merged,
    serverUrl: normalizeServerUrl(merged.serverUrl, allowInsecureHttp),
    name: merged.name,
    email: merged.email,
  };
  for (const k of KEYS) if (cfg[k] === undefined) delete cfg[k];
  cfg.sources = { serverUrl: source("serverUrl"), ...(cfg.inviteCode ? { inviteCode: source("inviteCode") } : {}) };
  return cfg;
}

/** Creates the config directory with mode 0700 (and tightens it if it already existed); returns its path. */
export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(path.dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Atomic write: a 0600 temp file in a 0700 directory, then rename over the config file. */
function writeFile(data: Partial<Config>): void {
  const dir = ensureConfigDir();
  const clean: Record<string, unknown> = {};
  for (const k of KEYS) if (data[k] !== undefined) clean[k] = data[k];
  const tmp = path.join(dir, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(clean, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, configPath());
  } catch {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw new ConfigError("could not write the config file");
  }
}

export function saveConfig(c: Config): void {
  writeFile(c);
}

/** Merges `patch` into what is in the file only, so values that came from env are not persisted. */
export function updateConfigFile(patch: ConfigUpdate): void {
  writeFile({ ...(readConfigFile() ?? {}), ...patch });
}
