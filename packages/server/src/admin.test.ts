import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { getInviteCode, openDb, setSetting, type Db } from "./db.js";
import { markHostedDatabase } from "./db-mode.js";
import { hostedTeam } from "./hosted.fixture.js";
import { createTeamSession, findSession } from "./sessions.js";
import { forTeam } from "./team-data.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";
import { openServerDb, runAdmin } from "./admin.js";

const M1 = "a".repeat(32);
const M2 = "b".repeat(32);

function setup(): { db: Db; token: string } {
  const db = openDb(":memory:");
  const team = forTeam(db, ensureSingleTeam(db));
  const { token } = team.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  team.registerMachine({ name: "Bob", email: "bob@x.com", machineId: M2, machineLabel: "box" });
  return { db, token };
}

const HOSTED_REFUSAL = "this database belongs to a hosted server; teamusage-admin does not manage it yet";

/** Marks `db` as a hosted server does; with `withTeam`, adds a hosted team with a member, a machine and a dashboard session. */
function makeHosted(db: Db, withTeam: boolean): void {
  markHostedDatabase(db);
  if (!withTeam) return;
  const { team } = hostedTeam(db, { githubId: 1, login: "ann" }, "members", "Acme");
  forTeam(db, team.id).registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  createTeamSession(db, team.id);
}

/** Every row an admin command could change. */
const stateOf = (db: Db) => ["teams", "members", "machines", "sessions", "settings"].map((t) => db.prepare(`select * from ${t} order by rowid`).all());

function run(db: Db, argv: string[], env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = runAdmin(db, argv, (l) => lines.push(l), env);
  return { code, text: lines.join("\n"), lines };
}

describe("runAdmin", () => {
  test("members lists emails and machine ids, never tokens", () => {
    const { db, token } = setup();
    const { code, text } = run(db, ["members"]);
    expect(code).toBe(0);
    for (const s of ["ann@x.com", "bob@x.com", M1, M2, "mbp"]) expect(text).toContain(s);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/[a-f0-9]{64}/);
  });

  test("works with the three-argument form", () => {
    const { db } = setup();
    expect(runAdmin(db, ["members"], () => {})).toBe(0);
  });

  test("remove-member returns 0 then 1", () => {
    const { db } = setup();
    expect(run(db, ["remove-member", "ann@x.com"]).code).toBe(0);
    expect(run(db, ["remove-member", "ann@x.com"]).code).toBe(1);
    expect(run(db, ["members"]).text).not.toContain("ann@x.com");
  });

  test("remove-machine returns 0 then 1", () => {
    const { db } = setup();
    expect(run(db, ["remove-machine", M1]).code).toBe(0);
    expect(run(db, ["remove-machine", M1]).code).toBe(1);
  });

  test("arguments are validated and usage printed with code 2", () => {
    const { db } = setup();
    for (const argv of [
      ["remove-member"],
      ["remove-member", "not-an-email"],
      ["remove-member", "a@x.com", "extra"],
      ["remove-machine"],
      ["remove-machine", "XYZ"],
      ["remove-machine", M1.toUpperCase()],
      ["remove-machine", `${M1}\n`],
      ["members", "extra"],
      ["rotate-invite", "extra"],
    ]) {
      const r = run(db, argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.text).toContain("usage");
    }
    expect(run(db, ["members"]).text).toContain("ann@x.com");
  });

  test("unknown or missing command prints usage and returns 2", () => {
    const { db } = setup();
    for (const argv of [["frobnicate"], []]) {
      const r = run(db, argv);
      expect(r.code).toBe(2);
      expect(r.text).toContain("usage");
    }
  });

  test("rotate-invite prints a new code once and ends sessions", async () => {
    const { db } = setup();
    const old = getInviteCode(db);
    const session = createTeamSession(db, ensureSingleTeam(db));
    expect(findSession(db, session)).not.toBeNull();
    const r = run(db, ["rotate-invite"]);
    expect(r.code).toBe(0);
    const fresh = getInviteCode(db);
    expect(fresh).not.toBe(old);
    expect(r.text).toContain(fresh);
    expect(r.text.split(fresh)).toHaveLength(2);
    expect(r.text).not.toContain(old);
    expect(findSession(db, session)).toBeNull();
    // The running app reads the code per request, so rotation takes effect without a restart.
    const app = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => getInviteCode(db)) });
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: old }),
    });
    expect(res.status).toBe(403);
  });

  test("show-invite prints the stored code, never session data", () => {
    const { db } = setup();
    expect(run(db, ["show-invite"]).text).toContain("not generated an invite code yet");
    expect(run(db, ["show-invite"]).code).toBe(1);
    const code = getInviteCode(db);
    const session = createTeamSession(db, ensureSingleTeam(db));
    const r = run(db, ["show-invite"]);
    expect(r.code).toBe(0);
    expect(r.text).toBe(code);
    expect(r.text).not.toContain(session);
    expect(run(db, ["show-invite", "extra"]).code).toBe(2);
  });

  test("show-invite prints no value when the code is pinned (env or marker)", () => {
    const { db } = setup();
    const code = getInviteCode(db);
    const viaEnv = run(db, ["show-invite"], { TEAMUSAGE_INVITE_CODE: "pinned-secret-code-01" });
    expect(viaEnv.code).toBe(1);
    expect(viaEnv.text).toContain("pinned by the TEAMUSAGE_INVITE_CODE environment variable");
    expect(viaEnv.text).not.toContain("pinned-secret-code-01");
    expect(viaEnv.text).not.toContain(code);
    setSetting(db, "invite_pinned", "1");
    const viaMarker = run(db, ["show-invite"]);
    expect(viaMarker.code).toBe(1);
    expect(viaMarker.text).toContain("pinned by the TEAMUSAGE_INVITE_CODE environment variable");
    expect(viaMarker.text).not.toContain(code);
  });

  test("usage text lists show-invite", () => {
    const { db } = setup();
    expect(run(db, []).text).toContain("show-invite");
  });

  test("rotate-invite refuses when the server recorded a pinned code", () => {
    const { db } = setup();
    setSetting(db, "invite_pinned", "1");
    const before = getInviteCode(db);
    const r = run(db, ["rotate-invite"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("TEAMUSAGE_INVITE_CODE");
    expect(getInviteCode(db)).toBe(before);
    setSetting(db, "invite_pinned", "0");
    expect(run(db, ["rotate-invite"]).code).toBe(0);
  });

  test("rotate-invite refuses when the env pins the code", () => {
    const { db } = setup();
    const session = createTeamSession(db, ensureSingleTeam(db));
    const before = getInviteCode(db);
    const r = run(db, ["rotate-invite"], { TEAMUSAGE_INVITE_CODE: "pinned-secret-code" });
    expect(r.code).toBe(1);
    expect(r.text).toContain("TEAMUSAGE_INVITE_CODE");
    expect(r.text).toContain("restart");
    expect(r.text).not.toContain("pinned-secret-code");
    expect(getInviteCode(db)).toBe(before);
    expect(findSession(db, session)).not.toBeNull();
  });

  test.each([["with a team", true], ["with no team yet", false]])(
    "every command on a hosted server's database %s is refused and changes nothing",
    (_, withTeam) => {
      const db = openDb(":memory:");
      makeHosted(db, withTeam);
      const before = stateOf(db);
      for (const argv of [["members"], ["remove-member", "ann@x.com"], ["remove-machine", M1], ["show-invite"], ["rotate-invite"]]) {
        const r = run(db, argv);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.lines, argv.join(" ")).toEqual([HOSTED_REFUSAL]);
      }
      expect(stateOf(db)).toEqual(before);
    },
  );

  test("show-invite and bad usage on a database without a team create none", () => {
    const db = openDb(":memory:");
    expect(run(db, ["show-invite"]).code).toBe(1);
    expect(run(db, ["members", "extra"]).code).toBe(2);
    expect(db.prepare("select count(*) as n from teams").get()).toEqual({ n: 0 });
  });
});

describe("openServerDb", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmpFile = (): string => {
    const d = mkdtempSync(join(tmpdir(), "tu-admin-"));
    dirs.push(d);
    return join(d, "teamusage.sqlite");
  };

  test("a database written by a newer release prints the server's sentence and is not upgraded", () => {
    const file = tmpFile();
    const newer = openDb(file);
    newer.pragma("user_version = 99");
    newer.close();
    const lines: string[] = [];
    expect(openServerDb(file, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual(["teamusage: this database was written by a newer teamusage; upgrade the server"]);
    const ro = new Database(file, { readonly: true });
    expect(ro.pragma("user_version", { simple: true })).toBe(99);
    ro.close();
  });

  test("a database whose upgrade fails prints the server's line, without the cause's message, and is left as it was", () => {
    const file = tmpFile();
    const db = openDb(file);
    // Step 4 adds teams.code_hash, which this file already has, so the step fails.
    db.pragma("user_version = 3");
    db.close();
    const lines: string[] = [];
    expect(openServerDb(file, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual(["teamusage: upgrade step 4 of the database failed and was rolled back (SQLITE_ERROR)"]);
    const ro = new Database(file, { readonly: true });
    expect(ro.pragma("user_version", { simple: true })).toBe(3);
    ro.close();
  });

  test("a missing file prints where it looked and is not created", () => {
    const file = tmpFile();
    const lines: string[] = [];
    expect(openServerDb(file, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([`teamusage-admin: no teamusage database at ${file}; is TEAMUSAGE_DATA_DIR the server's data directory?`]);
    expect(existsSync(file)).toBe(false);
  });
});

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(`${dist}admin.js`) && existsSync(`${dist}main.js`);

describe.skipIf(!built)(built ? "built binaries" : "built binaries (skipped: run `pnpm --filter @teamusage/server build` first, dist/ is absent)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "tu-bin-"));
    dirs.push(d);
    return d;
  };
  const runBin = (bin: string, dataDir: string, args: string[]) =>
    spawnSync(bin, args, { env: { PATH: process.env.PATH, TEAMUSAGE_DATA_DIR: dataDir }, encoding: "utf8" });

  test("both bins start with a shebang and are executable", () => {
    for (const f of ["main.js", "admin.js"]) {
      expect(readFileSync(`${dist}${f}`, "utf8").startsWith("#!/usr/bin/env node\n"), f).toBe(true);
      expect(statSync(`${dist}${f}`).mode & 0o111, f).not.toBe(0);
    }
  });

  test("admin runs through a bin symlink against a registered, empty database", () => {
    const d = tmp();
    openDb(join(d, "teamusage.sqlite")).close();
    const link = join(d, "teamusage-admin");
    symlinkSync(`${dist}admin.js`, link);
    const r = runBin(link, d, ["members"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no members");
  });

  test.each([["with a team", true], ["with no team yet", false]])("admin refuses a hosted server's database %s", (_, withTeam) => {
    const d = tmp();
    const file = join(d, "teamusage.sqlite");
    const stateOfFile = () => {
      const db = openDb(file);
      const rows = stateOf(db);
      db.close();
      return rows;
    };
    const db = openDb(file);
    makeHosted(db, withTeam);
    db.close();
    const before = stateOfFile();
    const r = runBin(`${dist}admin.js`, d, ["rotate-invite"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`${HOSTED_REFUSAL}\n`);
    expect(stateOfFile()).toEqual(before);
  });

  test("admin refuses a missing, zero-byte or foreign file and leaves it untouched", () => {
    const d = tmp();
    const admin = `${dist}admin.js`;
    const missing = runBin(admin, join(d, "none"), ["members"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no teamusage database at");
    expect(existsSync(join(d, "none"))).toBe(false);

    const file = join(d, "teamusage.sqlite");
    for (const content of [Buffer.alloc(0), Buffer.from("not a database at all")]) {
      writeFileSync(file, content);
      const r = runBin(admin, d, ["members"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no teamusage database at");
      expect(readFileSync(file).equals(content)).toBe(true);
    }
    // A real SQLite file without the members table is foreign too.
    const other = new Database(file.replace(".sqlite", "2.sqlite"));
    other.exec("create table t (x)");
    other.close();
    const foreign = readFileSync(join(d, "teamusage2.sqlite"));
    writeFileSync(file, foreign);
    expect(runBin(admin, d, ["members"]).status).toBe(1);
    expect(readFileSync(file).equals(foreign)).toBe(true);
  });
});
