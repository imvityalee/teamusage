import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { addDays, isDisplayName, isEmail, localIsoDate, MAX_DISPLAY_NAME_CHARS, MAX_EMAIL_CHARS, type UsageRecord } from "@teamusage/shared";
import { describeLogin, labelRecords, readLogins, type Logins } from "./account.js";
import { ApiError, health, register, upload, type RegisterBody } from "./api.js";
import { collect } from "./collect.js";
import {
  assertTokenBound,
  ConfigError,
  configFile,
  configPath,
  ensureConfigDir,
  insecureHttpAllowedByEnv,
  loadConfig,
  normalEmail,
  normalizeServerUrl,
  readConfigFile,
  saveConfig,
  updateConfigFile,
  writePrivateFile,
  type Config,
} from "./config.js";
import { errorMessage, SyncError } from "./errors.js";
import { clearCodexNotice, isSetupProblem, writeCodexNotice } from "./notice.js";
import { machineId, machineLabel, readOsId } from "./machine.js";

export interface Deps {
  collect: typeof collect;
  env: NodeJS.ProcessEnv;
  today: () => string; // local YYYY-MM-DD
  /** The current Claude and Codex logins, read once per sync; never throws (see readLogins). */
  accounts: () => Logins;
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

const CHUNK = 500;
const LOG_LINES = 200;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LAST_ATTEMPT_FILE = "last-attempt";
const SYNC_LOG_FILE = "sync.log";

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
  return configFile(LAST_ATTEMPT_FILE);
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
    writePrivateFile(LAST_ATTEMPT_FILE, `${new Date().toISOString()}\n`);
  } catch {
    // the throttle is best effort; it must never make a sync fail
  }
}

export const syncDefaults = (): Deps => ({
  collect,
  env: process.env,
  today: () => localIsoDate(),
  accounts: () => readLogins(),
  log: (line) => process.stdout.write(`${line}\n`),
});

/** undefined = all history; otherwise two calendar days before the last successful sync. */
export function syncSince(lastSuccessfulSync: string | undefined): string | undefined {
  return lastSuccessfulSync === undefined ? undefined : addDays(lastSuccessfulSync, -2);
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
    let lines: string[] = [];
    try {
      lines = readFileSync(configFile(SYNC_LOG_FILE), "utf8").split("\n").filter((l) => l !== "");
    } catch {
      // no log yet
    }
    lines.push(`${new Date().toISOString()} ${message}`);
    writePrivateFile(SYNC_LOG_FILE, `${lines.slice(-LOG_LINES).join("\n")}\n`);
  } catch {
    // logging must never make a quiet sync fail
  }
}

/** What a sync collected; SyncResult adds what the server did with it. */
type Collected = Pick<SyncResult, "days" | "agents" | "records">;
type Counts = Pick<SyncResult, "stored" | "kept">;

const empty = (): SyncResult => ({ days: 0, agents: [], records: 0, stored: 0, kept: 0 });

/**
 * Single-flight: a `wx`-created lock file in the config directory. Returns a release function, or null when
 * another sync holds a lock younger than 10 minutes. An older lock is treated as left by a crash and replaced.
 */
function acquireLock(): (() => void) | null {
  ensureConfigDir();
  const file = configFile("sync.lock");
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
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new SyncError("lock");
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

/** True when the invite code and the server URL both came from the config file, or both from the environment. */
const sameSource = (cfg: Config): boolean =>
  cfg.inviteCode !== undefined && cfg.sources?.inviteCode !== undefined && cfg.sources.inviteCode === cfg.sources.serverUrl;

export async function sync(
  opts: { dryRun?: boolean; quiet?: boolean; labelHistory?: boolean; deps?: Partial<Deps> } = {},
): Promise<SyncResult> {
  const deps: Deps = { ...syncDefaults(), ...opts.deps };
  const quiet = opts.quiet === true;
  try {
    return await run(deps, { dryRun: opts.dryRun === true, quiet, history: opts.labelHistory === true });
  } catch (e) {
    if (deps.env.TEAMUSAGE_HOOK === "codex" && isSetupProblem(e)) writeCodexNotice(errorMessage(e));
    if (!quiet) throw e;
    appendSyncLog(`sync failed: ${errorMessage(e)}`);
    return empty();
  }
}

/** `history`: --label-history. */
type SyncOptions = { dryRun: boolean; quiet: boolean; history: boolean };

async function run(deps: Deps, opts: SyncOptions): Promise<SyncResult> {
  const cfg = loadConfig(deps.env);
  if (!cfg) throw new SyncError("notSetUp");
  if (opts.dryRun) return collectAndUpload(deps, cfg, opts);
  assertTokenBound(cfg);
  const release = acquireLock();
  if (release === null) {
    if (!opts.quiet) deps.log("Another sync is already running; skipped.");
    return { ...empty(), skipped: true };
  }
  try {
    writeLastAttempt();
    return await collectAndUpload(deps, cfg, opts);
  } finally {
    release();
  }
}

/** The record lists to upload, in order, and what they hold. */
interface UploadPlan {
  passes: UsageRecord[][];
  summary: Collected;
}

const summarize = (records: UsageRecord[]): Collected => ({
  days: new Set(records.map((r) => r.date)).size,
  agents: [...new Set(records.map((r) => r.agent))].sort(),
  records: records.length,
});

/**
 * Collects and labels what to upload. A plain sync is one pass from `since`. With --label-history a normal pass goes
 * first (labels only today and yesterday, as a plain sync does), so the totals on the server are already equal when the
 * history pass (all history, every day labelled) arrives: it can then only fill labels and plans that are missing,
 * never replace one. A dry run shows only the history pass.
 */
async function planUpload(
  deps: Deps,
  labels: { logins: Logins; today: string },
  since: string | undefined,
  opts: Pick<SyncOptions, "history" | "dryRun">,
): Promise<UploadPlan> {
  const pass = async (from: string | undefined, labelAll: boolean) =>
    labelRecords((await deps.collect(from)).map(onlyRecordFields), labels.logins, labels.today, { history: labelAll });
  if (!opts.history) {
    const plain = await pass(since, false);
    return { passes: [plain], summary: summarize(plain) };
  }
  const all = await pass(undefined, true);
  const passes = opts.dryRun ? [all] : [await pass(since, false), all];
  return { passes, summary: summarize(all) };
}

/** Sends every pass in order, in chunks of CHUNK records, and adds up the server's counts. */
async function uploadPasses(serverUrl: string, token: string, passes: UsageRecord[][]): Promise<Counts> {
  const counts = { stored: 0, kept: 0 };
  for (const pass of passes) {
    for (let i = 0; i < pass.length; i += CHUNK) {
      const res = await upload(serverUrl, token, pass.slice(i, i + CHUNK));
      counts.stored += res.stored;
      counts.kept += res.kept;
    }
  }
  return counts;
}

type Identity = Omit<RegisterBody, "inviteCode">;

/**
 * This machine's registration fields, worked out on first use only: a newly generated machine-id seed is saved then,
 * and a second call must not generate another.
 */
function lazyIdentity(cfg: Config): () => Identity {
  let identity: Identity | undefined;
  return () => {
    if (identity === undefined) {
      const m = currentMachineId(cfg.email, cfg.fallbackMachineId);
      if (m.generated) updateConfigFile({ fallbackMachineId: m.seed });
      identity = { name: cfg.name, email: cfg.email, machineId: m.id, machineLabel: machineLabel() };
    }
    return identity;
  };
}

/**
 * Registers and saves the new token, bound to this server and email. `forgetHistory` also clears the saved sync state:
 * after a 401 the server may have lost this machine's history, and if the resend fails the next sync sends it all.
 */
async function registerAndSave(cfg: Config, inviteCode: string, identity: Identity, forgetHistory: boolean): Promise<string> {
  const { token } = await register(cfg.serverUrl, { inviteCode, ...identity });
  updateConfigFile({
    token,
    tokenServerUrl: cfg.serverUrl,
    tokenEmail: normalEmail(cfg.email),
    ...(forgetHistory ? { lastSuccessfulSync: undefined, lastSyncAgents: undefined } : {}),
  });
  return token;
}

const isUnauthorized = (e: unknown): boolean => e instanceof ApiError && e.status === 401;

function logHistoryLabels(log: Deps["log"], agents: string[], logins: Logins): void {
  for (const [agent, title] of [["claude", "Claude"], ["codex", "Codex"]] as const) {
    if (!agents.includes(agent)) continue;
    const login = logins[agent];
    log(login === null ? `${title} history: no login found, left as it is.` : `Labels all ${title} history as ${describeLogin(agent, login)}.`);
  }
}

/**
 * After the server rejected the token (401): registers again with the invite code, then sends the plan from
 * `fullPlan` (all history when the last sync was partial: the server may have lost this machine's history, for example
 * when an operator removed it). A second 401 is final.
 */
async function reregisterAndResend(
  cfg: Config,
  inviteCode: string,
  identity: Identity,
  fullPlan: () => Promise<UploadPlan>,
): Promise<{ plan: UploadPlan; counts: Counts }> {
  let token: string;
  try {
    token = await registerAndSave(cfg, inviteCode, identity, true);
  } catch (e) {
    // The saved invite is refused (the server answers 403): a setup problem, not a network one.
    if (e instanceof ApiError && e.status === 403) throw new SyncError("inviteRefused");
    throw e;
  }
  const plan = await fullPlan();
  try {
    return { plan, counts: await uploadPasses(cfg.serverUrl, token, plan.passes) };
  } catch (e) {
    throw isUnauthorized(e) ? new SyncError("tokenRejected") : e;
  }
}

async function collectAndUpload(deps: Deps, cfg: Config, opts: SyncOptions): Promise<SyncResult> {
  const today = deps.today();
  const since = syncSince(cfg.lastSuccessfulSync);
  const labels = { logins: deps.accounts(), today };
  const plan = await planUpload(deps, labels, since, opts);
  if (opts.history && !opts.quiet) logHistoryLabels(deps.log, plan.summary.agents, labels.logins);
  const identity = lazyIdentity(cfg);
  if (opts.dryRun) {
    if (!opts.quiet) printDryRun(deps.log, plan.passes[0] ?? [], identity());
    return { ...plan.summary, stored: 0, kept: 0 };
  }

  // Registering without `setup` sends the invite code, so only to a server configured in the same place as it:
  // an invite code from the plugin's settings never goes to a server from the config file, or the reverse.
  const inviteCode = sameSource(cfg) ? cfg.inviteCode : undefined;
  let token = cfg.token;
  if (!token) {
    if (!inviteCode) throw new SyncError("noToken");
    token = await registerAndSave(cfg, inviteCode, identity(), false);
  }

  let sent: { plan: UploadPlan; counts: Counts };
  try {
    sent = { plan, counts: await uploadPasses(cfg.serverUrl, token, plan.passes) };
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    if (!inviteCode) throw new SyncError("tokenRejected");
    const fullPlan = since === undefined ? async () => plan : () => planUpload(deps, labels, undefined, opts);
    sent = await reregisterAndResend(cfg, inviteCode, identity(), fullPlan);
  }
  const result: SyncResult = { ...sent.plan.summary, ...sent.counts };

  updateConfigFile({
    lastSuccessfulSync: today,
    lastSyncAgents: result.agents,
    tokenServerUrl: cfg.serverUrl,
    tokenEmail: normalEmail(cfg.email),
  });
  clearCodexNotice();
  if (!opts.quiet) {
    const agents = result.agents.length ? result.agents.join(", ") : "none";
    deps.log(
      `Sent ${result.records} records over ${result.days} days (agents: ${agents}): ` +
        `${result.stored} stored, ${result.kept} kept because the server already had higher totals.`,
    );
  }
  return result;
}

function printDryRun(log: Deps["log"], records: UsageRecord[], identity: Identity): void {
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
  if (!isDisplayName(name)) {
    throw new ConfigError(`name must be 1 to ${MAX_DISPLAY_NAME_CHARS} characters, without control characters`);
  }
  const email = input.email.trim();
  if (!isEmail(email)) throw new ConfigError(`email must contain @ and be at most ${MAX_EMAIL_CHARS} characters`);
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
  clearCodexNotice();
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
