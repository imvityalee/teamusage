import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import type { UsageRecord } from "@teamusage/shared";
import type { Db } from "../../server/src/db.js";
import { CollectError } from "./collect.js";
import { configPath, saveConfig, updateConfigFile, type Config } from "./config.js";
import { noticePath } from "./notice.js";
import { getStatus, setup, sync, syncSince, type Deps } from "./sync.js";
import { machineId } from "./machine.js";
import { countRows, startServer as start, type TestServer } from "./test-server.js";

const osId = vi.hoisted(() => ({ value: "test-os-id" as string | null }));
vi.mock("./machine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./machine.js")>();
  return { ...real, readOsId: () => osId.value };
});

const lockFails = vi.hoisted(() => ({ value: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: ((file: import("node:fs").PathLike, ...rest: unknown[]) => {
      if (lockFails.value && String(file).endsWith("sync.lock")) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return (real.openSync as (...a: unknown[]) => number)(file, ...rest);
    }) as typeof real.openSync,
  };
});

const realFetch = globalThis.fetch;
const INVITE = "invite-SECRET-7f3a";
const TOKEN = "tok-SECRET-91b2";
const RECORD_KEYS = ["agent", "cacheCreate", "cacheRead", "costUsd", "date", "input", "model", "output", "total", "unpriced"];

const startServer = () => start(INVITE);

const rec = (i: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
  agent: i % 2 ? "codex" : "claude",
  model: `model-${i}`,
  input: 1,
  output: 2,
  cacheCreate: 3,
  cacheRead: 4,
  total: 10,
  costUsd: 0.01,
  unpriced: false,
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => rec(i));

const envFor = (url: string, over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TEAMUSAGE_SERVER_URL: url,
  TEAMUSAGE_INVITE_CODE: INVITE,
  TEAMUSAGE_NAME: "Ann",
  TEAMUSAGE_EMAIL: "ann@example.com",
  ...over,
});

const count = (db: Db, table: string) => countRows(db, table);
/** The binding setup and every sync write next to a token. */
const bound = (url: string) => ({ tokenServerUrl: url, tokenEmail: "ann@example.com" });
const readFile = (): Config => JSON.parse(readFileSync(configPath(), "utf8"));
const syncLog = () => path.join(path.dirname(configPath()), "sync.log");

let home: string;
let srv: TestServer;
let fetchSpy: MockInstance<typeof fetch>;

const calls = (suffix: string) =>
  fetchSpy.mock.calls.filter(([u]) => String(u).endsWith(suffix)).map(([, init]) => JSON.parse(String(init?.body)));

function deps(over: Partial<Deps> = {}): Partial<Deps> & { log: ReturnType<typeof vi.fn> } {
  return {
    collect: vi.fn(async () => many(3)),
    env: envFor(srv.url),
    today: () => "2026-11-18",
    accounts: () => ({ claude: null, codex: null }),
    log: vi.fn(),
    ...over,
  } as Partial<Deps> & { log: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "teamusage-sync-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  osId.value = "test-os-id";
  srv = await startServer();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await srv.close();
  rmSync(home, { recursive: true, force: true });
});

test("syncSince: undefined → undefined; '2026-11-18' → '2026-11-16'", () => {
  expect(syncSince(undefined)).toBeUndefined();
  expect(syncSince("2026-11-18")).toBe("2026-11-16");
  expect(syncSince("2026-03-01")).toBe("2026-02-27");
  expect(syncSince("2027-01-01")).toBe("2026-12-30");
});

test("first sync registers from env, uploads everything, saves token and lastSuccessfulSync", async () => {
  const d = deps();
  const res = await sync({ deps: d });
  expect(d.collect).toHaveBeenCalledWith(undefined);
  expect(res).toEqual({ days: 3, agents: ["claude", "codex"], records: 3, stored: 3, kept: 0 });
  expect(count(srv.db, "members")).toBe(1);
  expect(count(srv.db, "usage")).toBe(3);
  const file = readFile();
  expect(file.token).toMatch(/^[a-f0-9]{64}$/);
  expect(file.lastSuccessfulSync).toBe("2026-11-18");
  expect(file.inviteCode).toBeUndefined();
  expect(JSON.stringify(file)).not.toContain(INVITE);
});

test("a later sync collects from two days before the last successful sync", async () => {
  await sync({ deps: deps() });
  const d = deps();
  await sync({ deps: d });
  expect(d.collect).toHaveBeenCalledWith("2026-11-16");
});

test("running sync twice leaves the same row count", async () => {
  await sync({ deps: deps() });
  const after1 = count(srv.db, "usage");
  const res = await sync({ deps: deps() });
  expect(count(srv.db, "usage")).toBe(after1);
  expect(res.stored + res.kept).toBe(3);
  expect(count(srv.db, "machines")).toBe(1);
});

test("1200 records are sent in three requests", async () => {
  const res = await sync({ deps: deps({ collect: async () => many(1200) }) });
  expect(calls("/api/usage").map((b) => b.records.length)).toEqual([500, 500, 200]);
  expect(res).toMatchObject({ records: 1200, stored: 1200, kept: 0 });
  expect(count(srv.db, "usage")).toBe(1200);
});

test("the upload body is exactly {records} with only UsageRecord fields", async () => {
  const leaky = { ...rec(0), project: "/Users/ann/secret-repo", prompt: "hello" } as UsageRecord;
  await sync({ deps: deps({ collect: async () => [leaky] }) });
  const [body] = calls("/api/usage");
  expect(Object.keys(body)).toEqual(["records"]);
  expect(Object.keys(body.records[0]).sort()).toEqual(RECORD_KEYS);
  expect(JSON.stringify(body)).not.toContain("secret-repo");
});

describe("label history", () => {
  const claude = { kind: "team", org: "O!Bank", plan: "team_premium" } as const;
  const codex = { kind: "personal", plan: "plus" } as const;
  const old = () => [
    rec(0, { date: "2025-03-01", agent: "claude" }),
    rec(1, { date: "2025-03-01", agent: "codex" }),
    rec(2, { date: "2025-03-01", agent: "gemini" }),
  ];
  const lines = (d: { log: ReturnType<typeof vi.fn> }) => d.log.mock.calls.map(([l]) => String(l));

  test("collects all history and labels every old Claude and Codex day", async () => {
    updateConfigFile({ lastSuccessfulSync: "2026-11-18" });
    const collect = vi.fn(async (_since?: string) => old());
    const d = deps({ collect, accounts: () => ({ claude, codex }) });
    await sync({ labelHistory: true, deps: d });
    expect(collect).toHaveBeenCalledWith(undefined);
    const body = calls("/api/usage")[1];
    expect(body.records[0].account).toEqual(claude);
    expect(body.records[1].account).toEqual(codex);
    expect("account" in body.records[2]).toBe(false);
    expect(lines(d)).toContain("Labels all Claude history as Team · O!Bank · Premium.");
    expect(lines(d)).toContain("Labels all Codex history as Personal · ChatGPT · Plus.");
  });

  test("uploads twice: a normal pass first (only today and yesterday labelled), then every day labelled", async () => {
    updateConfigFile({ lastSuccessfulSync: "2026-11-18" });
    const rows = () => [
      rec(0, { date: "2025-03-01", agent: "claude" }),
      rec(1, { date: "2025-03-01", agent: "codex" }),
      rec(2, { date: "2026-11-18", agent: "claude" }),
    ];
    const d = deps({ collect: async () => rows(), accounts: () => ({ claude, codex }) });
    await sync({ labelHistory: true, deps: d });
    const bodies = calls("/api/usage");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].records.map((r: { account?: unknown }) => r.account)).toEqual([undefined, undefined, claude]);
    expect(bodies[1].records.map((r: { account?: unknown }) => r.account)).toEqual([claude, codex, claude]);
  });

  test("a missing login is reported and only agents present are mentioned", async () => {
    const d = deps({ collect: async () => [rec(0, { date: "2025-03-01", agent: "claude" })], accounts: () => ({ claude: null, codex }) });
    await sync({ labelHistory: true, dryRun: true, deps: d });
    expect(lines(d)).toContain("Claude history: no login found, left as it is.");
    expect(lines(d).join("\n")).not.toContain("Codex");
  });

  test("without the flag old days stay unlabelled", async () => {
    const d = deps({ collect: async () => old(), accounts: () => ({ claude, codex }) });
    await sync({ deps: d });
    expect(JSON.stringify(calls("/api/usage")[0])).not.toContain("account");
  });
});

describe("account label", () => {
  const acct = { kind: "team", org: "Devcats" } as const;
  const recs = () => [
    rec(0, { date: "2026-11-18", agent: "claude" }),
    rec(1, { date: "2026-11-18", agent: "codex" }),
    rec(2, { date: "2026-11-10", agent: "claude" }),
  ];

  test("a throwing account reader still uploads, with no account fields", async () => {
    const boom = () => {
      throw new Error("login file");
    };
    await sync({ deps: deps({ collect: async () => recs(), accounts: boom }) });
    const body = calls("/api/usage")[0];
    expect(body.records).toHaveLength(3);
    for (const r of body.records) expect("account" in r).toBe(false);
  });

  test("the upload carries account on recent Claude records only", async () => {
    const d = deps({ collect: async () => recs(), accounts: () => ({ claude: acct, codex: null }) });
    await sync({ deps: d });
    const body = calls("/api/usage")[0];
    expect(body.records[0].account).toEqual(acct);
    expect("account" in body.records[1]).toBe(false);
    expect("account" in body.records[2]).toBe(false);
  });

  test("a ccusage-supplied account is dropped", async () => {
    const leaky = { ...rec(0, { date: "2026-11-18", agent: "claude" }), account: { kind: "api" } } as UsageRecord;
    await sync({ deps: deps({ collect: async () => [leaky], accounts: () => ({ claude: null, codex: null }) }) });
    expect("account" in calls("/api/usage")[0].records[0]).toBe(false);
  });

  test("the login is read once per sync", async () => {
    const accounts = vi.fn(() => ({ claude: acct, codex: null }));
    await sync({ deps: deps({ collect: async () => recs(), accounts }) });
    expect(accounts).toHaveBeenCalledTimes(1);
  });

  test("dry run shows the label", async () => {
    const d = deps({ collect: async () => recs(), accounts: () => ({ claude: acct, codex: null }) });
    await sync({ dryRun: true, deps: d });
    const all = d.log.mock.calls.map(([l]) => String(l)).join("\n");
    expect(all).toContain('"account"');
    expect(all).toContain("Devcats");
  });

  test("no login means no account keys", async () => {
    const d = deps({ collect: async () => recs(), accounts: () => ({ claude: null, codex: null }) });
    await sync({ deps: d });
    expect(JSON.stringify(calls("/api/usage")[0])).not.toContain("account");
  });
});

test("dry run sends nothing and returns the records", async () => {
  const leaky = { ...rec(0), project: "/Users/ann/secret-repo" } as UsageRecord;
  const d = deps({ collect: async () => [leaky, rec(1)] });
  const res = await sync({ dryRun: true, deps: d });
  expect(res).toEqual({ days: 2, agents: ["claude", "codex"], records: 2, stored: 0, kept: 0 });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(count(srv.db, "members")).toBe(0);
  expect(count(srv.db, "usage")).toBe(0);
  expect(existsSync(configPath()) ? readFile().token : undefined).toBeUndefined();

  const printed = d.log.mock.calls.map(([l]) => String(l));
  const all = printed.join("\n");
  expect(all).not.toContain("secret-repo");
  expect(all).not.toContain(INVITE);
  const json = printed.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const payload = json.find((j) => "records" in j);
  expect(Object.keys(payload)).toEqual(["records"]);
  expect(payload.records).toEqual([rec(0), rec(1)]);
  for (const r of payload.records) expect(Object.keys(r).sort()).toEqual(RECORD_KEYS);
  const identity = json.find((j) => "machineId" in j);
  expect(Object.keys(identity).sort()).toEqual(["email", "machineId", "machineLabel", "name"]);
  expect(identity.machineId).toMatch(/^[a-f0-9]{32}$/);
});

test("server down: rejects, lastSuccessfulSync unchanged", async () => {
  const url = srv.url;
  await srv.close();
  saveConfig({ serverUrl: url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(url), lastSuccessfulSync: "2026-11-01" });
  await expect(sync({ deps: deps({ env: {} }) })).rejects.toThrow(/could not reach the server/);
  expect(readFile().lastSuccessfulSync).toBe("2026-11-01");
});

test("a failing chunk leaves lastSuccessfulSync unchanged even when earlier chunks were stored", async () => {
  saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", inviteCode: INVITE, lastSuccessfulSync: "2026-11-01" });
  const records = [...many(500), { ...rec(9999), total: 1 }]; // the second chunk is invalid → 400
  await expect(sync({ deps: deps({ collect: async () => records }) })).rejects.toThrow(/400/);
  expect(count(srv.db, "usage")).toBe(500);
  expect(readFile().lastSuccessfulSync).toBe("2026-11-01");
});

describe("quiet", () => {
  let out: MockInstance<typeof process.stdout.write>;
  let err: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, "write");
    err = vi.spyOn(process.stderr, "write");
  });
  const silent = (d: { log: ReturnType<typeof vi.fn> }) => {
    expect(d.log).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  };

  test("quiet + server down: resolves, writes sync.log, prints nothing", async () => {
    const url = srv.url;
    await srv.close();
    saveConfig({ serverUrl: url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(url), lastSuccessfulSync: "2026-11-01" });
    const d = deps({ env: {} });
    await expect(sync({ quiet: true, deps: d })).resolves.toMatchObject({ stored: 0 });
    silent(d);
    const log = readFileSync(syncLog(), "utf8");
    expect(log).toMatch(/could not reach the server/);
    expect(log).not.toContain(TOKEN);
    expect(statSync(syncLog()).mode & 0o777).toBe(0o600);
    expect(readFile().lastSuccessfulSync).toBe("2026-11-01");
  });

  test("quiet success prints nothing and writes no log", async () => {
    const d = deps();
    await expect(sync({ quiet: true, deps: d })).resolves.toMatchObject({ stored: 3 });
    silent(d);
    expect(existsSync(syncLog())).toBe(false);
  });

  test("quiet without any config resolves and logs the reason", async () => {
    const d = deps({ env: {} });
    await sync({ quiet: true, deps: d });
    silent(d);
    expect(readFileSync(syncLog(), "utf8")).toMatch(/teamusage setup/);
  });

  test("sync.log keeps only the last 200 lines", async () => {
    mkdirSync(path.dirname(syncLog()), { recursive: true });
    writeFileSync(syncLog(), Array.from({ length: 250 }, (_, i) => `old ${i}`).join("\n") + "\n");
    await sync({ quiet: true, deps: deps({ env: {} }) });
    const lines = readFileSync(syncLog(), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("old 51");
    expect(lines[199]).toMatch(/teamusage setup/);
  });

  test("collect throws CollectError: non-quiet rejects with its message; quiet resolves", async () => {
    const collect = async () => {
      throw new CollectError("ccusage exited with an error");
    };
    await expect(sync({ deps: deps({ collect }) })).rejects.toThrow("ccusage exited with an error");
    const d = deps({ collect });
    await expect(sync({ quiet: true, deps: d })).resolves.toBeDefined();
    silent(d);
    expect(readFileSync(syncLog(), "utf8")).toContain("ccusage exited with an error");
  });

  test("a wrong invite code never appears in errors or the log", async () => {
    const env = envFor(srv.url, { TEAMUSAGE_INVITE_CODE: "WRONG-invite-c0de" });
    const e = await sync({ deps: deps({ env }) }).catch((x: unknown) => x);
    expect(String(e)).toMatch(/403/);
    expect(String(e)).not.toContain("WRONG-invite-c0de");
    await sync({ quiet: true, deps: deps({ env }) });
    expect(readFileSync(syncLog(), "utf8")).not.toContain("WRONG-invite-c0de");
  });
});

describe("re-registering after a 401 needs the server URL and invite code from one source", () => {
  const PLUGIN_ENV = (url: string) => ({
    CLAUDE_PLUGIN_OPTION_SERVER_URL: url,
    CLAUDE_PLUGIN_OPTION_INVITE_CODE: INVITE,
    CLAUDE_PLUGIN_OPTION_NAME: "Ann",
    CLAUDE_PLUGIN_OPTION_EMAIL: "ann@example.com",
  });

  test("both from the config file: re-registers once and succeeds", async () => {
    saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url), inviteCode: INVITE });
    const res = await sync({ deps: deps({ env: {} }) });
    expect(res.stored).toBe(3);
    expect(calls("/api/register")).toHaveLength(1);
    expect(readFile().token).not.toBe(TOKEN);
    expect(readFile().lastSuccessfulSync).toBe("2026-11-18");
  });

  test("both from the environment (the plugin): re-registers once and succeeds", async () => {
    saveConfig({ name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url) } as Config);
    const res = await sync({ deps: deps({ env: PLUGIN_ENV(srv.url) }) });
    expect(res.stored).toBe(3);
    expect(calls("/api/register")).toHaveLength(1);
    expect(readFile().inviteCode).toBeUndefined();
  });

  test.each([
    ["the server URL from the file, the invite code from the environment", "file-url"],
    ["the server URL from the environment, the invite code from the file", "env-url"],
  ])("%s: refuses, and the invite code is sent nowhere", async (_n, kind) => {
    if (kind === "file-url") {
      saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url) });
    } else {
      saveConfig({ name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url), inviteCode: INVITE } as Config);
    }
    const env = kind === "file-url" ? { TEAMUSAGE_INVITE_CODE: INVITE } : { TEAMUSAGE_SERVER_URL: srv.url };
    const e = await sync({ deps: deps({ env }) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(String(e)).toContain("run `teamusage setup`");
    expect(String(e)).not.toContain(INVITE);
    expect(calls("/api/register")).toHaveLength(0);
    expect(fetchSpy.mock.calls.every(([, init]) => !String(init?.body ?? "").includes(INVITE))).toBe(true);
    expect(readFile().token).toBe(TOKEN);
    expect(readFile().lastSuccessfulSync).toBeUndefined();
  });

  test("with no token, a first registration from mixed sources is refused too", async () => {
    saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com" });
    const e = await sync({ deps: deps({ env: { TEAMUSAGE_INVITE_CODE: INVITE } }) }).catch((x: unknown) => x);
    expect(String(e)).toContain("run `teamusage setup`");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

test("re-registering after a 401 collects all history again before uploading", async () => {
  saveConfig({
    serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url),
    inviteCode: INVITE, lastSuccessfulSync: "2026-11-10",
  });
  const collect = vi.fn(async (since?: string) => (since === undefined ? many(5) : many(2)));
  const res = await sync({ deps: deps({ env: {}, collect }) });
  expect(collect.mock.calls).toEqual([["2026-11-08"], [undefined]]);
  expect(calls("/api/register")).toHaveLength(1);
  expect(calls("/api/usage").at(-1).records).toHaveLength(5);
  expect(res).toEqual({ days: 5, agents: ["claude", "codex"], records: 5, stored: 5, kept: 0 });
  expect(count(srv.db, "usage")).toBe(5);
  expect(readFile().lastSuccessfulSync).toBe("2026-11-18");
});

test("a resend that fails after re-registering keeps the new token and clears lastSuccessfulSync, so the next sync sends everything", async () => {
  saveConfig({
    serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url),
    inviteCode: INVITE, lastSuccessfulSync: "2026-11-10", lastSyncAgents: ["claude"],
  });
  let registered = false;
  fetchSpy.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/api/register")) {
      registered = true;
      return realFetch(url, init);
    }
    if (String(url).endsWith("/api/usage") && registered) return new Response("{}", { status: 503 });
    return realFetch(url, init);
  });
  const collect = vi.fn(async (since?: string) => (since === undefined ? many(5) : many(2)));
  await expect(sync({ deps: deps({ env: {}, collect }) })).rejects.toThrow();
  const after = readFile();
  expect(after.token).toBeTruthy();
  expect(after.token).not.toBe(TOKEN);
  expect(after.lastSuccessfulSync).toBeUndefined();
  expect(after.lastSyncAgents).toBeUndefined();

  fetchSpy.mockImplementation((url, init) => realFetch(url, init));
  collect.mockClear();
  const res = await sync({ deps: deps({ env: {}, collect }) });
  expect(collect.mock.calls).toEqual([[undefined]]);
  expect(res).toMatchObject({ records: 5, stored: 5 });
  expect(count(srv.db, "usage")).toBe(5);
  expect(readFile().lastSuccessfulSync).toBe("2026-11-18");
});

test("a 401 in a later chunk re-registers and resends everything from the first chunk", async () => {
  saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", inviteCode: INVITE });
  let usageCalls = 0;
  fetchSpy.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/api/usage") && ++usageCalls === 2) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    return realFetch(url, init);
  });
  const res = await sync({ deps: deps({ env: {}, collect: async () => many(700) }) });
  expect(calls("/api/register")).toHaveLength(2); // the first registration, then once after the 401
  expect(calls("/api/usage").map((b) => b.records.length)).toEqual([500, 200, 500, 200]);
  expect(res).toMatchObject({ records: 700, stored: 700, kept: 0 });
  expect(count(srv.db, "usage")).toBe(700); // same machine id, so the resent rows replace the first ones
});

test("401 again after re-registering: registers only once, then rejects mentioning `teamusage setup`", async () => {
  saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url), inviteCode: INVITE });
  fetchSpy.mockImplementation(async (url, init) =>
    String(url).endsWith("/api/usage")
      ? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      : realFetch(url, init),
  );
  await expect(sync({ deps: deps() })).rejects.toThrow("teamusage setup");
  expect(calls("/api/register")).toHaveLength(1);
  expect(readFile().lastSuccessfulSync).toBeUndefined();
});

test("401 without invite code: rejects mentioning `teamusage setup`", async () => {
  saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url) });
  const e = await sync({ deps: deps({ env: {} }) }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  expect(String(e)).toContain("teamusage setup");
  expect(String(e)).not.toContain(TOKEN);
  expect(calls("/api/register")).toHaveLength(0);
  expect(readFile().lastSuccessfulSync).toBeUndefined();
});

test("success output never contains the token or invite code", async () => {
  const d = deps();
  await sync({ deps: d });
  const printed = d.log.mock.calls.join("\n");
  expect(printed).toMatch(/3 records/);
  expect(printed).not.toContain(readFile().token!);
  expect(printed).not.toContain(INVITE);
});

describe("without an OS id", () => {
  beforeEach(() => {
    osId.value = null;
  });
  const machineIds = () => (srv.db.prepare("select id from machines order by id").all() as { id: string }[]).map((r) => r.id);

  test("a random seed is generated once, persisted, and the machine id is derived from it and the email", async () => {
    await sync({ deps: deps() });
    const seed = readFile().fallbackMachineId;
    expect(seed).toMatch(/^[a-f0-9]{32}$/);
    expect(machineIds()).toEqual([machineId("ann@example.com", seed!)]);
    expect(machineIds()).not.toContain(seed);
    await sync({ deps: deps() });
    expect(readFile().fallbackMachineId).toBe(seed);
    expect(count(srv.db, "machines")).toBe(1);
  });

  test("same seed and email: the same machine id every time", async () => {
    const input = { serverUrl: srv.url, inviteCode: INVITE, name: "Ann", email: "ann@example.com" };
    await setup(input);
    const seed = readFile().fallbackMachineId!;
    await setup({ ...input, email: " ANN@example.com " });
    expect(readFile().fallbackMachineId).toBe(seed);
    expect(machineIds()).toEqual([machineId("ann@example.com", seed)]);
  });

  test("same seed, two emails: two machine ids, so correcting the email does not hit a 409", async () => {
    const input = { serverUrl: srv.url, inviteCode: INVITE, name: "Ann", email: "ann@example.com" };
    await setup(input);
    const seed = readFile().fallbackMachineId!;
    await expect(setup({ ...input, email: "ann.corrected@example.com" })).resolves.toBeDefined();
    expect(readFile().fallbackMachineId).toBe(seed);
    expect(machineIds()).toEqual(
      [machineId("ann@example.com", seed), machineId("ann.corrected@example.com", seed)].sort(),
    );
  });
});

describe("setup", () => {
  const input = () => ({ serverUrl: `${srv.url}/`, inviteCode: INVITE, name: "Ann", email: "ann@example.com" });

  test("registers and saves the config without the invite code", async () => {
    await setup(input());
    const file = readFile();
    expect(file).toMatchObject({ serverUrl: srv.url, name: "Ann", email: "ann@example.com" });
    expect(file.token).toMatch(/^[a-f0-9]{64}$/);
    expect(file.inviteCode).toBeUndefined();
    expect(count(srv.db, "machines")).toBe(1);
  });

  test("saves the invite code only when asked", async () => {
    await setup({ ...input(), saveInvite: true });
    expect(readFile().inviteCode).toBe(INVITE);
  });

  test("clears lastSuccessfulSync so the first sync sends all history", async () => {
    saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", lastSuccessfulSync: "2026-11-01" });
    await setup(input());
    expect(readFile().lastSuccessfulSync).toBeUndefined();
  });

  test("rejects a non-http server URL before contacting anything", async () => {
    await expect(setup({ ...input(), serverUrl: "file:///etc/passwd" })).rejects.toThrow(/http/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(configPath())).toBe(false);
  });

  test("rejects an invalid email or name before contacting anything", async () => {
    await expect(setup({ ...input(), email: "nope" })).rejects.toThrow(/email/);
    await expect(setup({ ...input(), name: " " })).rejects.toThrow(/name/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a wrong invite code fails without saving and without echoing the code", async () => {
    const e = await setup({ ...input(), inviteCode: "WRONG-invite-c0de" }).catch((x: unknown) => x);
    expect(String(e)).toMatch(/403/);
    expect(String(e)).not.toContain("WRONG-invite-c0de");
    expect(existsSync(configPath())).toBe(false);
  });
});

describe("status", () => {
  test("reports whether a token exists, never the token", async () => {
    saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url), inviteCode: INVITE, lastSuccessfulSync: "2026-11-17" });
    const s = await getStatus({});
    expect(s).toMatchObject({ configured: true, hasToken: true, lastSuccessfulSync: "2026-11-17", serverReachable: true, inviteCode: "saved" });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain(INVITE);
  });

  test("unconfigured", async () => {
    expect(await getStatus({})).toMatchObject({ configured: false, hasToken: false });
  });
});

describe("token binding", () => {
  let b: TestServer;
  beforeEach(async () => {
    b = await startServer();
  });
  afterEach(() => b.close());
  const toB = () => fetchSpy.mock.calls.filter(([u]) => String(u).startsWith(b.url));

  test("a token issued by server A is never sent to server B; B gets no request at all", async () => {
    await sync({ deps: deps() });
    const before = readFile();
    expect(before.tokenServerUrl).toBe(srv.url);
    const e = await sync({ deps: deps({ env: envFor(b.url) }) }).catch((x: unknown) => x);
    expect(String(e)).toContain("teamusage setup");
    expect(String(e)).not.toContain(before.token!);
    expect(String(e)).not.toContain(INVITE);
    expect(toB()).toHaveLength(0);
    expect(count(b.db, "members")).toBe(0);
    expect(readFile()).toEqual(before);
  });

  test("the binding is saved with the token even when the upload after registering fails", async () => {
    fetchSpy.mockImplementation(async (url, init) =>
      String(url).endsWith("/api/usage") ? new Response("{}", { status: 503 }) : realFetch(url, init),
    );
    await expect(sync({ deps: deps() })).rejects.toThrow(/503/);
    expect(readFile()).toMatchObject({ tokenServerUrl: srv.url, tokenEmail: "ann@example.com" });
    expect(readFile().token).toBeDefined();
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(realFetch);
    await expect(sync({ deps: deps({ env: envFor(b.url) }) })).rejects.toThrow("teamusage setup");
    expect(toB()).toHaveLength(0);
  });

  test("a changed email stops the sync before any request", async () => {
    await sync({ deps: deps() });
    const before = readFile();
    fetchSpy.mockClear();
    const env = envFor(srv.url, { TEAMUSAGE_EMAIL: "someone-else@example.com" });
    await expect(sync({ deps: deps({ env }) })).rejects.toThrow("teamusage setup");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFile().lastSuccessfulSync).toBe(before.lastSuccessfulSync);
    expect(count(srv.db, "members")).toBe(1);
  });

  test("an email differing only in case or spaces is the same member", async () => {
    await sync({ deps: deps() });
    await expect(sync({ deps: deps({ env: envFor(srv.url, { TEAMUSAGE_EMAIL: " ANN@Example.com " }) }) })).resolves.toBeDefined();
  });

  test("quiet mismatch: nothing sent, nothing printed, reason logged", async () => {
    await sync({ deps: deps() });
    const d = deps({ env: envFor(b.url) });
    await expect(sync({ quiet: true, deps: d })).resolves.toMatchObject({ stored: 0 });
    expect(d.log).not.toHaveBeenCalled();
    expect(toB()).toHaveLength(0);
    expect(readFileSync(syncLog(), "utf8")).toMatch(/server URL or email changed.*teamusage setup/);
  });

  test("setup against B rebinds, and sync then works with B", async () => {
    await sync({ deps: deps() });
    await setup({ serverUrl: b.url, inviteCode: INVITE, name: "Ann", email: "ann@example.com" });
    expect(readFile()).toMatchObject({ tokenServerUrl: b.url, tokenEmail: "ann@example.com" });
    const res = await sync({ deps: deps({ env: envFor(b.url) }) });
    expect(res.stored).toBe(3);
    expect(count(b.db, "usage")).toBe(3);
  });

  test.each([
    ["no binding at all", {}],
    ["only the server URL", { tokenServerUrl: "SRV" }],
    ["only the email", { tokenEmail: "ann@example.com" }],
  ])("a token with %s is refused: nothing is sent, the setup hint is shown", async (_n, partial) => {
    const binding = Object.fromEntries(Object.entries(partial).map(([k, v]) => [k, v === "SRV" ? srv.url : v]));
    saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, inviteCode: INVITE, ...binding });
    const before = readFile();
    const e = await sync({ deps: deps({ env: {} }) }).catch((x: unknown) => x);
    expect(String(e)).toContain("run `teamusage setup`");
    expect(String(e)).not.toContain(TOKEN);
    expect(String(e)).not.toContain(INVITE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(count(srv.db, "members")).toBe(0);
    expect(readFile()).toEqual(before);
  });

  test("an unbound token is refused even when the environment names another server", async () => {
    saveConfig({ name: "Ann", email: "ann@example.com", token: TOKEN } as Config);
    const e = await sync({ deps: deps({ env: envFor(b.url) }) }).catch((x: unknown) => x);
    expect(String(e)).toContain("run `teamusage setup`");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(count(b.db, "members")).toBe(0);
  });
});

test("a 503 from the server leaves lastSuccessfulSync unchanged", async () => {
  saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", inviteCode: INVITE, lastSuccessfulSync: "2026-11-01" });
  fetchSpy.mockImplementation(async (url, init) =>
    String(url).endsWith("/api/usage")
      ? new Response(JSON.stringify({ error: "maintenance" }), { status: 503 })
      : realFetch(url, init),
  );
  await expect(sync({ deps: deps() })).rejects.toThrow(/503/);
  expect(readFile().lastSuccessfulSync).toBe("2026-11-01");
});

test("the agents of the last successful sync are saved and shown by status", async () => {
  expect((await getStatus(envFor(srv.url))).lastSyncAgents).toBeUndefined();
  await sync({ deps: deps() });
  expect(readFile().lastSyncAgents).toEqual(["claude", "codex"]);
  expect((await getStatus(envFor(srv.url))).lastSyncAgents).toEqual(["claude", "codex"]);
});

describe("single flight", () => {
  const lock = () => path.join(path.dirname(configPath()), "sync.lock");
  const slowCollect = () => vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 150));
    return many(3);
  });

  test("two concurrent syncs upload exactly once", async () => {
    const d1 = deps({ collect: slowCollect() });
    const d2 = deps({ collect: slowCollect() });
    const results = await Promise.all([sync({ deps: d1 }), sync({ deps: d2 })]);
    expect(results.filter((r) => r.skipped === true)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === undefined)).toHaveLength(1);
    expect(calls("/api/usage")).toHaveLength(1);
    expect([...d1.log.mock.calls, ...d2.log.mock.calls].flat()).toContain("Another sync is already running; skipped.");
    expect(existsSync(lock())).toBe(false);
  });

  test("a young lock skips quietly: nothing sent, nothing logged", async () => {
    mkdirSync(path.dirname(lock()), { recursive: true });
    writeFileSync(lock(), "other");
    const d = deps();
    await expect(sync({ quiet: true, deps: d })).resolves.toMatchObject({ records: 0 });
    expect(d.collect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
    expect(existsSync(syncLog())).toBe(false);
    expect(readFileSync(lock(), "utf8")).toBe("other");
  });

  test("a lock older than 10 minutes is replaced", async () => {
    mkdirSync(path.dirname(lock()), { recursive: true });
    writeFileSync(lock(), "crashed");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock(), old, old);
    await expect(sync({ deps: deps() })).resolves.toMatchObject({ stored: 3 });
    expect(existsSync(lock())).toBe(false);
  });

  test("the lock is released when the sync fails", async () => {
    const collect = async () => {
      throw new CollectError("ccusage exited with an error");
    };
    await expect(sync({ deps: deps({ collect }) })).rejects.toThrow();
    expect(existsSync(lock())).toBe(false);
  });

  test("a dry run takes no lock", async () => {
    mkdirSync(path.dirname(lock()), { recursive: true });
    writeFileSync(lock(), "other");
    const d = deps();
    await sync({ dryRun: true, deps: d });
    expect(d.collect).toHaveBeenCalled();
  });
});

describe("plain http to a remote host", () => {
  // usage.test is not loopback; the request is routed to the local test server.
  const remote = () => srv.url.replace("127.0.0.1", "usage.test");
  const route = () =>
    fetchSpy.mockImplementation(async (url, init) => realFetch(String(url).replace("usage.test", "127.0.0.1"), init));
  const input = () => ({ serverUrl: remote(), inviteCode: INVITE, name: "Ann", email: "ann@example.com" });

  test("setup rejects it without the opt-in, naming the flag, before any request", async () => {
    await expect(setup(input(), {})).rejects.toThrow("--allow-insecure-http");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("setup --allow-insecure-http registers and persists the opt-in", async () => {
    route();
    await setup({ ...input(), allowInsecureHttp: true }, {});
    expect(readFile()).toMatchObject({ serverUrl: remote(), allowInsecureHttp: true });
    await expect(sync({ deps: deps({ env: {} }) })).resolves.toMatchObject({ stored: 3 });
  });

  test("the env opt-in allows setup without persisting it", async () => {
    route();
    await setup(input(), { TEAMUSAGE_ALLOW_INSECURE_HTTP: "1" });
    expect(readFile().allowInsecureHttp).toBeUndefined();
    await expect(sync({ deps: deps({ env: {} }) })).rejects.toThrow("--allow-insecure-http");
  });

  test("sync with a remote http URL from env and no opt-in sends nothing", async () => {
    const d = deps({ env: envFor(remote()) });
    await expect(sync({ deps: d })).rejects.toThrow("--allow-insecure-http");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("codex notice", () => {
  const hook = (over: Record<string, string> = {}) => deps({ env: { TEAMUSAGE_HOOK: "codex", ...over } });
  const MSG = "teamusage could not send your usage: teamusage is not set up; run `teamusage setup`";

  test("writes a notice for a missing setup under TEAMUSAGE_HOOK=codex", async () => {
    await sync({ quiet: true, deps: hook() });
    expect(JSON.parse(readFileSync(noticePath(), "utf8"))).toEqual({ systemMessage: MSG });
    expect(statSync(noticePath()).mode & 0o777).toBe(0o600);
  });

  test("non-quiet runs write the notice and still reject", async () => {
    await expect(sync({ deps: hook() })).rejects.toThrow(/not set up/);
    expect(existsSync(noticePath())).toBe(true);
  });

  test("only Codex hook syncs write a notice", async () => {
    await sync({ quiet: true, deps: deps({ env: {} }) });
    expect(existsSync(noticePath())).toBe(false);
  });

  test("network errors write no notice", async () => {
    const url = srv.url;
    await srv.close();
    saveConfig({ serverUrl: url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(url) });
    await sync({ quiet: true, deps: hook() });
    expect(existsSync(noticePath())).toBe(false);
  });

  test("lock errors write no notice", async () => {
    saveConfig({ serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: TOKEN, ...bound(srv.url) });
    lockFails.value = true;
    try {
      await expect(sync({ deps: hook() })).rejects.toThrow(/sync lock/);
    } finally {
      lockFails.value = false;
    }
    expect(existsSync(noticePath())).toBe(false);
  });

  test("any success deletes the notice", async () => {
    await sync({ quiet: true, deps: hook() });
    expect(existsSync(noticePath())).toBe(true);
    await sync({ deps: deps({ env: envFor(srv.url) }) });
    expect(existsSync(noticePath())).toBe(false);
  });

  test("a failing notice write is ignored", async () => {
    const blocked = path.join(home, "blocked");
    writeFileSync(blocked, "");
    vi.stubEnv("XDG_CONFIG_HOME", blocked);
    await expect(sync({ quiet: true, deps: hook() })).resolves.toMatchObject({ stored: 0 });
  });
});
