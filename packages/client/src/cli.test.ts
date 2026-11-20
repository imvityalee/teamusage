import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import type { UsageRecord } from "@teamusage/shared";
import { main } from "./cli.js";
import { configPath, saveConfig } from "./config.js";
import { lastAttemptPath, parseThrottle, type Deps } from "./sync.js";
import { countRows, startServer, type TestServer } from "./test-server.js";

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: unknown[]) => {
      spawned.calls.push(args);
      return { on: () => undefined, unref: () => undefined };
    },
  };
});

const realFetch = globalThis.fetch;
const INVITE = "invite-SECRET-cli1";
const rec: UsageRecord = {
  date: "2026-11-17", agent: "claude", model: "m", input: 1, output: 2, cacheCreate: 3, cacheRead: 4,
  total: 10, costUsd: 0.01, unpriced: false,
};

let home: string;
let srv: TestServer;
let fetchSpy: MockInstance<typeof fetch>;
let out: MockInstance<typeof process.stdout.write>;
let err: MockInstance<typeof process.stderr.write>;
const printed = (m: MockInstance<typeof process.stdout.write>) => m.mock.calls.map(([c]) => String(c)).join("");

const deps = (env: NodeJS.ProcessEnv = {}): Partial<Deps> & { log: ReturnType<typeof vi.fn> } => ({
  collect: vi.fn(async () => [rec]),
  env: {
    TEAMUSAGE_SERVER_URL: srv.url,
    TEAMUSAGE_INVITE_CODE: INVITE,
    TEAMUSAGE_NAME: "Ann",
    TEAMUSAGE_EMAIL: "ann@example.com",
    ...env,
  },
  today: () => "2026-11-18", accounts: () => ({ claude: null, codex: null }),
  log: vi.fn(),
});

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "teamusage-cli-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  srv = await startServer(INVITE);
  spawned.calls = [];
  fetchSpy = vi.spyOn(globalThis, "fetch");
  out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await srv.close();
  rmSync(home, { recursive: true, force: true });
});

test("sync --dry-run --detach: the dry run wins; nothing is spawned or sent", async () => {
  const d = deps();
  expect(await main(["sync", "--dry-run", "--detach"], d)).toBe(0);
  expect(spawned.calls).toHaveLength(0);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(countRows(srv.db, "usage")).toBe(0);
  expect(d.log.mock.calls.flat().join("\n")).toContain('"records"');
});

test("sync --label-history with --detach or --throttle is a usage error (exit 2) and does nothing", async () => {
  const d = deps();
  const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const extra of [["--detach"], ["--throttle", "4h"], ["--quiet", "--detach"]]) {
    expect(await main(["sync", "--label-history", ...extra], d)).toBe(2);
  }
  expect(e.mock.calls.map(([c]) => String(c)).join("")).toContain("--label-history cannot be used with --detach or --throttle");
  expect(spawned.calls).toHaveLength(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("the usage text lists --label-history", async () => {
  const o = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await main(["--help"], deps());
  expect(o.mock.calls.concat(e.mock.calls).map(([c]) => String(c)).join("")).toContain("--label-history");
});

test("sync --detach spawns a detached quiet sync and sends nothing itself", async () => {
  const d = deps();
  expect(await main(["sync", "--detach"], d)).toBe(0);
  expect(spawned.calls).toHaveLength(1);
  const [file, args, opts] = spawned.calls[0] as [string, string[], { detached: boolean; stdio: string }];
  expect(file).toBe(process.execPath);
  expect(args.slice(-2)).toEqual(["sync", "--quiet"]);
  expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(d.collect).not.toHaveBeenCalled();
  expect(printed(out) + printed(err)).toBe("");
});

test("sync --quiet with bad arguments prints nothing and exits 0", async () => {
  expect(await main(["sync", "--quiet", "--bogus"], deps())).toBe(0);
  expect(printed(out) + printed(err)).toBe("");
});

test("status shows the agents of the last sync", async () => {
  const d = deps();
  await main(["status"], d);
  expect(printed(out)).toMatch(/Agents \(last sync\): +none yet/);
  out.mockClear();
  await main(["sync"], d);
  await main(["status"], d);
  expect(printed(out)).toMatch(/Agents \(last sync\): +claude\n/);
  expect(printed(out)).not.toContain(JSON.parse(readFileSync(configPath(), "utf8")).token);
});

test("setup --allow-insecure-http to a remote host warns once, then registers", async () => {
  const remote = srv.url.replace("127.0.0.1", "usage.test");
  fetchSpy.mockImplementation(async (url, init) => realFetch(String(url).replace("usage.test", "127.0.0.1"), init));
  const args = ["setup", "--server", remote, "--invite", INVITE, "--name", "Ann", "--email", "ann@example.com"];
  const d = deps();
  expect(await main([...args, "--allow-insecure-http"], d)).toBe(0);
  const warnings = printed(err).split("\n").filter((l) => /unencrypted/.test(l));
  expect(warnings).toHaveLength(1);
  expect(printed(err) + printed(out)).not.toContain(INVITE);
  expect(JSON.parse(readFileSync(configPath(), "utf8")).allowInsecureHttp).toBe(true);
});

test("setup trims the name and email before checking them", async () => {
  const args = ["setup", "--server", srv.url, "--invite", INVITE, "--name", "Ann\t", "--email", " ann@example.com "];
  expect(await main(args, deps())).toBe(0);
  expect(printed(out)).toContain("Registered Ann <ann@example.com>");
});

test("setup to a remote http host without the opt-in fails before any request", async () => {
  const args = ["setup", "--server", "http://usage.test:8787", "--invite", INVITE, "--name", "Ann", "--email", "a@b.c"];
  expect(await main(args, deps())).toBe(1);
  expect(printed(err)).toContain("--allow-insecure-http");
  expect(printed(err)).not.toContain("unencrypted");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("setup against a loopback http server prints no warning", async () => {
  const args = ["setup", "--server", srv.url, "--invite", INVITE, "--name", "Ann", "--email", "a@b.c"];
  expect(await main(args, deps())).toBe(0);
  expect(printed(err)).not.toContain("unencrypted");
});

test("stats prints the member's models and a team total, with separators and two decimals", async () => {
  const d = deps();
  expect(await main(["setup", "--server", srv.url, "--invite", INVITE, "--name", "Ann", "--email", "ann@example.com"], d)).toBe(0);
  srv.db.prepare("update usage set total = 1234567, cost_usd = 12.3").run();
  out.mockClear();
  expect(await main(["stats", "--range", "3m"], d)).toBe(0);
  const text = printed(out);
  expect(text).toContain("Agent");
  expect(text).toMatch(/claude\s+m\s+1,234,567\s+12\.30/);
  expect(text).toContain("Team total: 1,234,567 tokens, 12.30 USD");
  expect(text).toContain("Cost is an estimate from public API prices");
  expect(text).not.toContain("SECRET");
});

test("stats rejects a bad range and an unconfigured machine without sending anything", async () => {
  const d = deps({ TEAMUSAGE_SERVER_URL: "", TEAMUSAGE_NAME: "", TEAMUSAGE_EMAIL: "" });
  expect(await main(["stats", "--range", "2m"], d)).toBe(2);
  expect(await main(["stats"], d)).toBe(1);
  expect(printed(err)).toContain("teamusage setup");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("stats refuses a response whose dates carry an escape sequence, printing only the fixed error", async () => {
  const d = deps();
  expect(await main(["setup", "--server", srv.url, "--invite", INVITE, "--name", "Ann", "--email", "ann@example.com"], d)).toBe(0);
  out.mockClear();
  fetchSpy.mockImplementation(async () =>
    new Response(JSON.stringify({ from: "\u001b[2J2026-01-01", to: "2026-11-18", totals: { tokens: 1, costUsd: 1 }, models: [] }), { status: 200 }),
  );
  expect(await main(["stats"], d)).toBe(1);
  expect(printed(out)).toBe("");
  expect(printed(err)).toContain("the server sent an unexpected response");
  expect(printed(err)).not.toContain("\u001b");
  fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ models: 5 }), { status: 200 }));
  expect(await main(["stats"], d)).toBe(1);
});

const SETUP = () => ["setup", "--server", srv.url, "--invite", INVITE, "--name", "Ann", "--email", "ann@example.com"];
const okRun = async () => ({ code: 0, stdout: "", stderr: "" });
const sched = () => {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  return {
    files,
    calls,
    schedule: {
      run: async (f: string, a: string[]) => (calls.push([f, ...a]), { code: a[0] === "print" ? 113 : 0, stdout: "", stderr: "" }),
      readFile: (f: string) => files.get(f),
      writeFile: (f: string, d: string) => void files.set(f, d),
      rm: (f: string) => void files.delete(f),
      homedir: () => "/Users/ann",
      uid: () => 501,
      exists: () => true,
      env: {},
      nodePath: "/n/node",
      cliPath: () => "/g/teamusage/dist/cli.js",
    },
  };
};

test("setup without --schedule or --codex installs nothing and runs nothing", async () => {
  const s = sched();
  const codexRun = vi.fn(okRun);
  expect(await main(SETUP(), { ...deps(), platform: "darwin", schedule: s.schedule, interactive: false, codex: { find: () => "/bin/codex", run: codexRun } })).toBe(0);
  expect(s.calls).toEqual([]);
  expect(s.files.size).toBe(0);
  expect(codexRun).not.toHaveBeenCalled();
});

test("setup --schedule installs the job after registering, with no user value in it", async () => {
  const s = sched();
  expect(await main([...SETUP(), "--schedule"], { ...deps(), platform: "darwin", schedule: s.schedule })).toBe(0);
  const file = "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist";
  expect(s.calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", file]);
  expect(s.files.get(file)).not.toMatch(/ann|invite|127\.0\.0\.1/i);
  expect(printed(out)).toContain("Installed the scheduled sync");
});

test("schedule install and remove are separate commands; bad usage is exit 2", async () => {
  const s = sched();
  const d = { ...deps(), platform: "darwin" as const, schedule: s.schedule };
  expect(await main(["schedule", "install"], d)).toBe(0);
  expect(s.files.size).toBe(1);
  expect(await main(["schedule", "remove"], d)).toBe(0);
  expect(s.files.size).toBe(0);
  expect(await main(["schedule"], d)).toBe(2);
  expect(await main(["schedule", "nope"], d)).toBe(2);
});

test("schedule install on Windows fails with the clear message and writes nothing", async () => {
  const s = sched();
  expect(await main(["schedule", "install"], { ...deps(), platform: "win32", schedule: s.schedule })).toBe(1);
  expect(printed(err)).toContain("Windows is not supported yet");
  expect(s.calls).toEqual([]);
});

test("status says whether the schedule is installed", async () => {
  const s = sched();
  const d = { ...deps(), platform: "darwin" as const, schedule: s.schedule };
  await main(SETUP(), d);
  out.mockClear();
  await main(["status"], d);
  expect(printed(out)).toMatch(/Scheduled sync: +not installed/);
  await main(["schedule", "install"], d);
  out.mockClear();
  await main(["status"], d);
  expect(printed(out)).toMatch(/Scheduled sync: +installed/);
});

const CODEX_HINT = [
  "Codex found. To send Codex usage automatically, install the teamusage Codex plugin:",
  "  codex plugin marketplace add imvityalee/teamusage",
  "  codex plugin add teamusage@teamusage",
  "then trust its hooks in Codex with /hooks.",
  "If you registered teamusage with Codex before, run `codex mcp remove teamusage` first: the plugin brings its own MCP server.",
].join("\n");

test("setup with codex on PATH and no flag prints the plugin hint, asks nothing and registers nothing", async () => {
  const run = vi.fn(okRun);
  const codex = { find: () => "/bin/codex", run, version: () => "0.1.0" };
  for (const interactive of [false, true]) {
    out.mockClear();
    expect(await main(SETUP(), { ...deps(), interactive, codex })).toBe(0);
    expect(printed(out)).toContain(`${CODEX_HINT}\n`);
    expect(printed(out).indexOf("Codex found.")).toBeLessThan(printed(out).indexOf("Running the first sync..."));
  }
  expect(run).not.toHaveBeenCalled();
  expect(printed(out)).not.toContain("Register the MCP tools with Codex?");
});

test("setup --no-codex prints no hint and registers nothing", async () => {
  const run = vi.fn(okRun);
  expect(await main([...SETUP(), "--no-codex"], { ...deps(), interactive: true, codex: { find: () => "/bin/codex", run, version: () => "0.1.0" } })).toBe(0);
  expect(run).not.toHaveBeenCalled();
  expect(printed(out) + printed(err)).not.toMatch(/codex/i);
});

test("setup --codex registers with a pinned version and prints no hint; with codex absent setup says nothing about it", async () => {
  const run = vi.fn(okRun);
  expect(await main([...SETUP(), "--codex"], { ...deps(), interactive: false, codex: { find: () => "/bin/codex", run, version: () => "0.1.0" } })).toBe(0);
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith("/bin/codex", ["mcp", "add", "teamusage", "--", "npx", "-y", "teamusage@0.1.0", "mcp"]);
  expect(printed(out)).not.toContain("Codex found.");
  out.mockClear();
  err.mockClear();
  expect(await main(SETUP(), { ...deps(), interactive: true, codex: { find: () => undefined } })).toBe(0);
  expect(printed(out) + printed(err)).not.toMatch(/codex/i);
  expect(await main([...SETUP(), "--codex", "--no-codex"], deps())).toBe(2);
});

test("setup prints the first-sync line after the schedule and Codex steps, right before syncing", async () => {
  const s = sched();
  const codex = { find: () => "/bin/codex", run: okRun, version: () => "0.1.0" };
  expect(await main([...SETUP(), "--schedule", "--codex"], { ...deps(), platform: "darwin", schedule: s.schedule, codex })).toBe(0);
  const text = printed(out);
  expect(text.indexOf("Installed the scheduled sync")).toBeLessThan(text.indexOf("Registered the MCP tools with Codex"));
  expect(text.indexOf("Registered the MCP tools with Codex")).toBeLessThan(text.indexOf("Running the first sync..."));
});

test("setup --schedule with a custom config location reports the refusal and writes nothing", async () => {
  const s = sched();
  const schedule = { ...s.schedule, env: { XDG_CONFIG_HOME: "/elsewhere" } };
  expect(await main([...SETUP(), "--schedule"], { ...deps(), platform: "darwin", schedule })).toBe(1);
  expect(printed(err)).toContain("custom config location");
  expect(s.files.size).toBe(0);
});

test("status says a schedule with a missing path is broken", async () => {
  const s = sched();
  const d = { ...deps(), platform: "darwin" as const, schedule: s.schedule };
  await main(["schedule", "install"], d);
  out.mockClear();
  await main(["status"], { ...d, schedule: { ...s.schedule, exists: () => false } });
  expect(printed(out)).toMatch(/Scheduled sync: +installed but broken .* schedule install/);
});

test("parseThrottle accepts 1-1440 minutes and 1-24 hours only", () => {
  expect(parseThrottle("4h")).toBe(14_400_000);
  expect(parseThrottle("30m")).toBe(1_800_000);
  for (const bad of ["0h", "25h", "4", "h", "1441m", "0m", "1.5h", "-1h", "4H", ""]) expect(parseThrottle(bad)).toBeUndefined();
});

describe("sync --throttle", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const H = 3_600_000;
  const writeAttempt = (iso: string) => {
    mkdirSync(path.dirname(lastAttemptPath()), { recursive: true });
    writeFileSync(lastAttemptPath(), iso);
  };

  test("skips within the window: nothing collected or spawned, exit 0", async () => {
    writeAttempt(ago(3 * H));
    const d = deps();
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], d)).toBe(0);
    expect(spawned.calls).toHaveLength(0);
    expect(d.collect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("runs after the window", async () => {
    writeAttempt(ago(5 * H));
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(1);
  });

  test("runs when there is no attempt file", async () => {
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(1);
  });

  test("a failed attempt still throttles the next run", async () => {
    const failing = { ...deps(), collect: (async () => { throw new Error("boom"); }) as Deps["collect"] };
    expect(await main(["sync", "--quiet"], failing)).toBe(0);
    expect(existsSync(lastAttemptPath())).toBe(true);
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(0);
  });

  test("a not-set-up machine starts the window too", async () => {
    const empty = deps({ TEAMUSAGE_SERVER_URL: "", TEAMUSAGE_INVITE_CODE: "", TEAMUSAGE_NAME: "", TEAMUSAGE_EMAIL: "" });
    expect(await main(["sync", "--quiet", "--throttle", "4h"], empty)).toBe(0);
    expect(existsSync(lastAttemptPath())).toBe(true);
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], empty)).toBe(0);
    expect(spawned.calls).toHaveLength(0);
  });

  test("a token bound elsewhere starts the window too", async () => {
    saveConfig({
      serverUrl: srv.url, name: "Ann", email: "ann@example.com", token: "t",
      tokenServerUrl: "https://other.example.com", tokenEmail: "ann@example.com",
    });
    expect(await main(["sync", "--quiet", "--throttle", "4h"], deps())).toBe(0);
    expect(existsSync(lastAttemptPath())).toBe(true);
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(0);
  });

  test("the parent records the attempt before detaching, so a second hook skips", async () => {
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(1);
    expect(existsSync(lastAttemptPath())).toBe(true);
    expect(await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(1);
  });

  test("a throttle skip and a dry run write no attempt time", async () => {
    writeAttempt(ago(60_000));
    const before = readFileSync(lastAttemptPath(), "utf8");
    await main(["sync", "--quiet", "--detach", "--throttle", "4h"], deps());
    expect(readFileSync(lastAttemptPath(), "utf8")).toBe(before);
    rmSync(lastAttemptPath());
    await main(["sync", "--dry-run", "--detach", "--throttle", "4h"], deps());
    expect(existsSync(lastAttemptPath())).toBe(false);
  });

  test("a lock-skipped sync does not write the attempt time", async () => {
    mkdirSync(path.dirname(lastAttemptPath()), { recursive: true });
    writeFileSync(path.join(path.dirname(lastAttemptPath()), "sync.lock"), "other");
    expect(await main(["sync", "--quiet"], deps())).toBe(0);
    expect(existsSync(lastAttemptPath())).toBe(false);
  });

  test("a manual sync ignores the throttle", async () => {
    writeAttempt(ago(60_000));
    const d = deps();
    expect(await main(["sync"], d)).toBe(0);
    expect(d.collect).toHaveBeenCalled();
  });

  test("a throttled sync run directly also skips", async () => {
    writeAttempt(ago(60_000));
    const d = deps();
    expect(await main(["sync", "--throttle", "4h"], d)).toBe(0);
    expect(d.collect).not.toHaveBeenCalled();
  });

  test("a manual skip prints one line; quiet and detached skips stay silent", async () => {
    writeAttempt(ago(60_000));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["sync", "--throttle", "4h"], deps())).toBe(0);
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toBe("Skipped: the last sync attempt was less than 4h ago.\n");
      write.mockClear();
      expect(await main(["sync", "--quiet", "--throttle", "4h"], deps())).toBe(0);
      expect(await main(["sync", "--detach", "--throttle", "4h"], deps())).toBe(0);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  test("a dry run writes no attempt time", async () => {
    expect(await main(["sync", "--dry-run"], deps())).toBe(0);
    expect(existsSync(lastAttemptPath())).toBe(false);
  });

  test("the attempt file is private and holds one ISO timestamp", async () => {
    expect(await main(["sync"], deps())).toBe(0);
    expect(statSync(lastAttemptPath()).mode & 0o777).toBe(0o600);
    const text = readFileSync(lastAttemptPath(), "utf8").trim();
    expect(new Date(text).toISOString()).toBe(text);
  });

  test("an invalid value is a usage error; with --quiet it exits 0", async () => {
    expect(await main(["sync", "--throttle", "5"], deps())).toBe(2);
    expect(printed(err)).toContain("--throttle must be 1m to 1440m or 1h to 24h; see `teamusage --help`");
    expect(await main(["sync", "--quiet", "--throttle", "99h"], deps())).toBe(0);
    expect(spawned.calls).toHaveLength(0);
  });
});
