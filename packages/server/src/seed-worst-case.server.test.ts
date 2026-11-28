import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDisplayName, isEmail, MAX_COST_USD, MAX_MODEL_CHARS, MAX_TOKENS, validateBatch } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import { conn } from "./main.fixture.js";
import { getWith, hostedServer, NOON, ownerWithTeam, TODAY } from "./main.web.fixture.js";
import { isMachineId } from "./team-data.js";
import { HOSTED_CAPS } from "./team-limits.js";

// The worst-case seed (scripts/seed-worst-case.mjs) against the server's own limits: its copies of them, the values it
// sends, and a whole run against a hosted server with the real limits.

const SCRIPT = fileURLToPath(new URL("../../../scripts/seed-worst-case.mjs", import.meta.url));
/** The pages' worst-case values (ruling R1: one file, which `worst-case.fixture.ts` exports typed). */
const worstCase = JSON.parse(readFileSync(new URL("../web/src/site/worst-case.json", import.meta.url), "utf8")) as { teamName: string };
type Seed = {
  LIMITS: Record<string, number>;
  NOT_SYNCING: number;
  worstCase: unknown;
  peopleOf: (members: number) => { name: string; email: string }[];
  machinesOf: (i: number) => { id: string; label: string }[];
  recordsOf: (i: number, today: string) => unknown[];
  main: (argv: string[], deps: Record<string, unknown>) => Promise<number>;
};
const seed = (await import(pathToFileURL(SCRIPT).href)) as Seed;

describe("the seed's limits and values", () => {
  test("each limit it reaches is the server's own", () => {
    expect(seed.LIMITS).toEqual({
      membersPerTeam: HOSTED_CAPS.membersPerTeam,
      machinesPerMember: HOSTED_CAPS.machinesPerMember,
      tokens: MAX_TOKENS,
      costUsd: MAX_COST_USD,
      modelChars: MAX_MODEL_CHARS,
    });
  });

  test("it reads the pages' worst-case values from their one file", () => {
    expect(seed.worstCase).toEqual(worstCase);
  });

  test("every name, email, machine and record it can send is one the server accepts", () => {
    for (const p of seed.peopleOf(seed.LIMITS.membersPerTeam!)) expect(isDisplayName(p.name) && isEmail(p.email), p.email).toBe(true);
    for (const i of [0, 1, 4, 5, 1999]) {
      for (const m of seed.machinesOf(i)) expect(isMachineId(m.id) && isDisplayName(m.label), m.label).toBe(true);
      expect(validateBatch({ records: seed.recordsOf(i, TODAY) }, new Date(NOON))).toMatchObject({ ok: true });
    }
  });
});

describe("a run against a hosted server with the real limits", () => {
  test("600 members are accepted in one run with no wait, and exactly 14 of them never synced", async () => {
    let clock = NOON;
    const s = hostedServer({ now: () => clock });
    await ownerWithTeam(s, "code-bob", "First", "members");
    const owner = await ownerWithTeam(s, "code-ann", worstCase.teamName, "members");
    const lines: string[] = [];
    const waits: number[] = [];
    const deps = {
      fetch: (url: string, init: RequestInit) => s.app.request(new URL(url).pathname, init, conn),
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
      today: () => TODAY,
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };

    const status = await seed.main(["--server", "http://localhost:8787", "--code", owner.code, "--members", "600"], deps);

    expect(lines).toEqual(["registered 600 members; 14 of them never synced; sent 17582 usage records"]);
    expect(status).toBe(0);
    expect(waits).toEqual([]);
    const listed = await getWith(s, `/api/teams/${owner.team}/members`, owner.cookie);
    const { members } = (await listed.json()) as { members: { machines: { lastSyncAt: string | null }[] }[] };
    expect(members).toHaveLength(600);
    expect(members.filter((m) => m.machines.every((x) => x.lastSyncAt === null))).toHaveLength(seed.NOT_SYNCING);
    expect(lines.join("\n")).not.toContain(owner.code);
  }, 60_000);
});
