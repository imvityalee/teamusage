import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { AccountLabel, UsageRecord } from "@teamusage/shared";
import { labelRecords, readClaudeAccount } from "./account.js";
import { ApiError, health, register, upload } from "./api.js";
import { collect, CollectError } from "./collect.js";
import {
  ConfigError,
  configDir,
  configPath,
  ensureConfigDir,
  insecureHttpAllowedByEnv,
  loadConfig,
  normalizeServerUrl,
  readConfigFile,
  saveConfig,
  updateConfigFile,
  type Config,
} from "./config.js";
import { machineId, machineLabel, readOsId } from "./machine.js";

export interface Deps {
  collect: typeof collect;
  env: NodeJS.ProcessEnv;
  today: () => string; // local YYYY-MM-DD
  /** The current Claude login, read once per sync. */
  account: () => AccountLabel | null;
  log: (line: string) => void;
}

export interface SyncResult {
  days: number;
  agents: string[];
  records: number;
  stored: number;
  kept: number;
  /** True when another sync held the lock, so nothing was collected or sent. */
  skipped?: boolean;
}

/** Its messages are fixed text and never include tokens or invite codes. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

const CHUNK = 500;
const LOG_LINES = 200;
const SETUP_HINT = "run `teamusage setup`";
const LOCK_STALE_MS = 10 * 60 * 1000;

/** Milliseconds for `<n>m` (1-1440) or `<n>h` (1-24); anything else is undefined. */
export function parseThrottle(s: string): number | undefined {
  const m = /^([1-9]\d{0,3})([mh])$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === "m") return n <= 1440 ? n * 60_000 : undefined;
  return n <= 24 ? n * 3_600_000 : undefined;
}

/** One ISO timestamp: when a real sync attempt last started (kept even when it failed). */
export function lastAttemptPath(): string {
  return path.join(configDir(), "last-attempt");
}

/** The stored attempt time, or undefined when there is none. */
export function readLastAttempt(): string | undefined {
  try {
    return readFileSync(lastAttemptPath(), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** True when the last attempt is less than `throttleMs` before `now`. A missing or unreadable time never skips. */
export function shouldSkip(throttleMs: number, now: Date, readAttempt: () => string | undefined): boolean {
  const raw = readAttempt();
  if (!raw) return false;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  return age >= 0 && age < throttleMs;
}

/** Records that a sync attempt starts now; best effort. */
export function writeLastAttempt(): void {
  try {
    const file = path.join(ensureConfigDir(), "last-attempt");
    writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // the throttle is best effort; it must never make a sync fail
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The machine's local calendar day. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const defaults = (): Deps => ({
  collect,
  env: process.env,
  today: () => localToday(),
  account: () => readClaudeAccount(),
  log: (line) => process.stdout.write(`${line}\n`),
});

/** undefined = all history; otherwise two calendar days before the last successful sync. */
export function syncSince(lastSuccessfulSync: string | undefined): string | undefined {
  if (lastSuccessfulSync === undefined) return undefined;
  const [y, m, d] = lastSuccessfulSync.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 2)).toISOString().slice(0, 10);
}

/** Safe to show or log: known errors carry fixed or truncated text; anything else is reduced to its code. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof CollectError || e instanceof ConfigError || e instanceof SyncError) {
    return e.message;
  }
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? `unexpected error (${code})` : "unexpected error";
}

/** Copies exactly the UsageRecord fields, so nothing else collect() returned can reach the server. */
function onlyRecordFields(r: UsageRecord): UsageRecord {
  const { date, agent, model, input, output, cacheCreate, cacheRead, total, costUsd, unpriced } = r;
  return { date, agent, model, input, output, cacheCreate, cacheRead, total, costUsd, unpriced };
}

/**
 * The machine id, derived from the email and a seed: the OS identifier, else the stored random seed, else a new
 * random seed (`generated` → the caller persists `seed`). Either way one seed gives one id per email.
 */
function currentMachineId(
  email: string,
  storedSeed: string | undefined,
): { id: string; fromOs: boolean; generated: boolean; seed?: string } {
  const osId = readOsId();
  if (osId) return { id: machineId(email, osId), fromOs: true, generated: false };
  if (storedSeed) return { id: machineId(email, storedSeed), fromOs: false, generated: false, seed: storedSeed };
  const seed = randomBytes(16).toString("hex");
  return { id: machineId(email, seed), fromOs: false, generated: true, seed };
}

function appendSyncLog(message: string): void {
  try {
    const file = path.join(ensureConfigDir(), "sync.log");
    let lines: string[] = [];
    try {
      lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    } catch {
      // no log yet
    }
    lines.push(`${new Date().toISOString()} ${message}`);
    writeFileSync(file, `${lines.slice(-LOG_LINES).join("\n")}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // logging must never make a quiet sync fail
  }
}

const empty = (): SyncResult => ({ days: 0, agents: [], records: 0, stored: 0, kept: 0 });

/**
 * Single-flight: a `wx`-created lock file in the config directory. Returns a release function, or null when
 * another sync holds a lock younger than 10 minutes. An older lock is treated as left by a crash and replaced.
 */
function acquireLock(): (() => void) | null {
  const file = path.join(ensureConfigDir(), "sync.lock");
  const mine = `${process.pid} ${randomBytes(8).toString("hex")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new SyncError("could not create the sync lock");
    }
    let age: number;
    try {
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // released in the meantime: try again
    }
    if (age < LOCK_STALE_MS) return null;
    rmSync(file, { force: true });
  }
  return null;
}

const normalEmail = (email: string) => email.trim().toLowerCase();

/** True when the invite code and the server URL both came from the config file, or both from the environment. */
const sameSource = (cfg: Config): boolean =>
  cfg.inviteCode !== undefined && cfg.sources?.inviteCode !== undefined && cfg.sources.inviteCode === cfg.sources.serverUrl;

/**
 * A stored token may only go to the server and email it was issued for. Every token this tool writes is saved
 * with both; a token missing either was damaged or edited by hand, so it is refused rather than sent anywhere.
 */
export function assertTokenBound(cfg: Config): void {
  if (!cfg.token) return;
  if (cfg.tokenServerUrl === undefined || cfg.tokenEmail === undefined) {
    throw new SyncError(`this machine's token is not bound to a server and email, so nothing was sent; ${SETUP_HINT}`);
  }
  const serverChanged = cfg.tokenServerUrl !== cfg.serverUrl;
  const emailChanged = cfg.tokenEmail !== normalEmail(cfg.email);
  if (serverChanged || emailChanged) {
    throw new SyncError(
      `the server URL or email changed since this machine registered, so nothing was sent; ${SETUP_HINT} to confirm`,
    );
  }
}

export async function sync(
  opts: { dryRun?: boolean; quiet?: boolean; deps?: Partial<Deps> } = {},
): Promise<SyncResult> {
  const deps: Deps = { ...defaults(), ...opts.deps };
  const quiet = opts.quiet === true;
  try {
    return await run(deps, opts.dryRun === true, quiet);
  } catch (e) {
    if (!quiet) throw e;
    appendSyncLog(`sync failed: ${errorMessage(e)}`);
    return empty();
  }
}

async function run(deps: Deps, dryRun: boolean, quiet: boolean): Promise<SyncResult> {
  const cfg = loadConfig(deps.env);
  if (!cfg) throw new SyncError(`teamusage is not set up; ${SETUP_HINT}`);
  if (dryRun) return collectAndUpload(deps, cfg, true, quiet);
  assertTokenBound(cfg);
  const release = acquireLock();
  if (release === null) {
    if (!quiet) deps.log("Another sync is already running; skipped.");
    return { ...empty(), skipped: true };
  }
  try {
    writeLastAttempt();
    return await collectAndUpload(deps, cfg, false, quiet);
  } finally {
    release();
  }
}

async function collectAndUpload(deps: Deps, cfg: Config, dryRun: boolean, quiet: boolean): Promise<SyncResult> {
  const today = deps.today();
  const since = syncSince(cfg.lastSuccessfulSync);
  const account = deps.account();
  const gather = async (from: string | undefined) => {
    const records = labelRecords((await deps.collect(from)).map(onlyRecordFields), account, today);
    const summary: SyncResult = {
      ...empty(),
      days: new Set(records.map((r) => r.date)).size,
      agents: [...new Set(records.map((r) => r.agent))].sort(),
      records: records.length,
    };
    return { records, summary };
  };
  let { records, summary: result } = await gather(since);

  let machine: string | undefined;
  const identity = () => {
    if (machine === undefined) {
      const m = currentMachineId(cfg.email, cfg.fallbackMachineId);
      if (m.generated) updateConfigFile({ fallbackMachineId: m.seed });
      machine = m.id;
    }
    return { name: cfg.name, email: cfg.email, machineId: machine, machineLabel: machineLabel() };
  };

  if (dryRun) {
    if (!quiet) printDryRun(deps.log, records, identity());
    return result;
  }

  const binding = { tokenServerUrl: cfg.serverUrl, tokenEmail: normalEmail(cfg.email) };
  const registerNow = async (inviteCode: string, forgetHistory = false): Promise<string> => {
    const { token } = await register(cfg.serverUrl, { inviteCode, ...identity() });
    // After a 401 the server may have lost this machine's history. The resend can still fail, so the saved
    // sync state is cleared together with the new token: the next sync then sends everything again.
    updateConfigFile({
      token,
      ...binding,
      ...(forgetHistory ? { lastSuccessfulSync: undefined, lastSyncAgents: undefined } : {}),
    });
    return token;
  };

  // Registering without `setup` sends the invite code, so only to a server configured in the same place as it:
  // an invite code from the plugin's settings never goes to a server from the config file, or the reverse.
  const inviteCode = sameSource(cfg) ? cfg.inviteCode : undefined;

  let token = cfg.token;
  if (!token) {
    if (!inviteCode) throw new SyncError(`this machine has no token; ${SETUP_HINT}`);
    token = await registerNow(inviteCode);
  }

  let reRegistered = false;
  for (;;) {
    try {
      for (let i = 0; i < records.length; i += CHUNK) {
        const res = await upload(cfg.serverUrl, token, records.slice(i, i + CHUNK));
        result.stored += res.stored;
        result.kept += res.kept;
      }
      break;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      if (!inviteCode || reRegistered) {
        throw new SyncError(`the server rejected this machine's token; ${SETUP_HINT}`);
      }
      reRegistered = true;
      token = await registerNow(inviteCode, true);
      // The server may have lost this machine's history (an operator removed it), so send all of it again,
      // from the first chunk.
      if (since !== undefined) ({ records, summary: result } = await gather(undefined));
      else result = { ...result, stored: 0, kept: 0 };
    }
  }

  updateConfigFile({ lastSuccessfulSync: today, lastSyncAgents: result.agents, ...binding });
  if (!quiet) {
    const agents = result.agents.length ? result.agents.join(", ") : "none";
    deps.log(
      `Sent ${result.records} records over ${result.days} days (agents: ${agents}): ` +
        `${result.stored} stored, ${result.kept} kept because the server already had higher totals.`,
    );
  }
  return result;
}

function printDryRun(
  log: (line: string) => void,
  records: UsageRecord[],
  identity: { name: string; email: string; machineId: string; machineLabel: string },
): void {
  const requests = Math.ceil(records.length / CHUNK);
  log(
    `Dry run: nothing was sent. The upload body would be the following` +
      (requests > 1 ? `, split into ${requests} requests of at most ${CHUNK} records:` : ":"),
  );
  log(JSON.stringify({ records }, null, 2));
  log("When this machine registers, it sends these fields plus the invite code (not shown):");
  log(JSON.stringify(identity, null, 2));
}

export interface SetupInput {
  serverUrl: string;
  inviteCode: string;
  name: string;
  email: string;
  saveInvite?: boolean;
  /** `--allow-insecure-http`: permits plain http to a non-loopback host and is saved in the config. */
  allowInsecureHttp?: boolean;
}

/**
 * Validates, registers this machine and writes a fresh config, binding the new token to this server and email.
 * The invite code is kept only with `saveInvite`. This is the only path that replaces a token bound elsewhere.
 */
export async function setup(
  input: SetupInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pick<Config, "serverUrl" | "name" | "email">> {
  const optIn = input.allowInsecureHttp === true;
  const serverUrl = normalizeServerUrl(input.serverUrl, optIn || insecureHttpAllowedByEnv(env));
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) throw new ConfigError("name must be 1 to 100 characters");
  const email = input.email.trim();
  if (!email.includes("@") || email.length > 254) {
    throw new ConfigError("email must contain @ and be at most 254 characters");
  }
  const inviteCode = input.inviteCode.trim();
  if (!inviteCode) throw new ConfigError("an invite code is required");

  const m = currentMachineId(email, readConfigFile()?.fallbackMachineId);
  const fallbackMachineId = m.fromOs ? undefined : m.seed;
  const { token } = await register(serverUrl, { inviteCode, name, email, machineId: m.id, machineLabel: machineLabel() });
  saveConfig({
    serverUrl,
    name,
    email,
    token,
    tokenServerUrl: serverUrl,
    tokenEmail: normalEmail(email),
    fallbackMachineId,
    ...(input.saveInvite ? { inviteCode } : {}),
    ...(optIn ? { allowInsecureHttp: true } : {}),
  });
  return { serverUrl, name, email };
}

export interface Status {
  configPath: string;
  configured: boolean;
  serverUrl?: string;
  serverReachable?: boolean;
  name?: string;
  email?: string;
  machineLabel: string;
  hasToken: boolean;
  inviteCode: "saved" | "environment" | "none";
  lastSuccessfulSync?: string;
  lastSyncAgents?: string[];
}

/** Says whether a token exists; never returns the token or the invite code. */
export async function getStatus(env: NodeJS.ProcessEnv = process.env): Promise<Status> {
  const file = readConfigFile();
  const cfg = loadConfig(env);
  const status: Status = {
    configPath: configPath(),
    configured: cfg !== null,
    machineLabel: machineLabel(),
    hasToken: Boolean(file?.token),
    inviteCode: file?.inviteCode ? "saved" : cfg?.inviteCode ? "environment" : "none",
    ...(file?.lastSuccessfulSync ? { lastSuccessfulSync: file.lastSuccessfulSync } : {}),
    ...(file?.lastSyncAgents ? { lastSyncAgents: file.lastSyncAgents } : {}),
  };
  if (!cfg) return status;
  return {
    ...status,
    serverUrl: cfg.serverUrl,
    serverReachable: await health(cfg.serverUrl),
    name: cfg.name,
    email: cfg.email,
  };
}
