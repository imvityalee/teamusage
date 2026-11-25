import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { goodReg, record } from "./app.fixture.js";
import { openDb, type Db } from "./db.js";
import { forTeam } from "./team-data.js";
import { createTeam } from "./teams.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("two teams", () => {
  const CODE_A = "code-for-team-a-0001";
  const CODE_B = "code-for-team-b-0002";
  let A: number, B: number, two: ReturnType<typeof createApp>;
  const call = (path: string, init: RequestInit = {}) => two.request(path, init);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  });
  const join = async (code: string, email: string) =>
    ((await (await call("/api/register", json(goodReg({ inviteCode: code, email })))).json()) as { token: string }).token;
  const cookie = async (code: string) => (await call("/api/login", json({ inviteCode: code }))).headers.get("set-cookie")!.split(";")[0]!;
  const stats = (headers: Record<string, string>, extra = "") => call(`/api/stats?from=2026-11-01&to=2026-11-10${extra}`, { headers });

  beforeEach(() => {
    A = createTeam(db, "A");
    B = createTeam(db, "B");
    const codes = new Map([[CODE_A, A], [CODE_B, B]]);
    two = createApp(db, { teamForCode: (c) => (typeof c === "string" ? (codes.get(c) ?? null) : null) });
  });

  test("the same machine id and email join both teams, and an upload lands only in its own", async () => {
    const ta = await join(CODE_A, "ann@example.com");
    const tb = await join(CODE_B, "ann@example.com");
    expect(ta).not.toBe(tb);
    await call("/api/usage", json({ records: [record()] }, { Authorization: `Bearer ${ta}` }));
    const sa = (await (await stats({ Authorization: `Bearer ${ta}` })).json()) as { totals: { tokens: number; memberCount: number } };
    const sb = (await (await stats({ Authorization: `Bearer ${tb}` })).json()) as { totals: { tokens: number; memberCount: number } };
    expect(sa.totals.tokens).toBeGreaterThan(0);
    expect(sb.totals).toMatchObject({ tokens: 0, memberCount: 1 });
  });
  test("a session opened with one team's code reads only that team", async () => {
    await join(CODE_A, "ann@example.com");
    await join(CODE_B, "bob@example.com");
    const body = (await (await stats({ Cookie: await cookie(CODE_B) })).json()) as { members: { email: string }[] };
    expect(body.members.map((m) => m.email)).toEqual(["bob@example.com"]);
  });
  test("a member id from another team is 404, like an unknown id", async () => {
    await join(CODE_A, "ann@example.com");
    const annId = forTeam(db, A).listMembers()[0]!.id;
    const c = await cookie(CODE_B);
    expect((await stats({ Cookie: c }, `&member=${annId}`)).status).toBe(404);
    expect((await stats({ Cookie: c }, "&member=999999")).status).toBe(404);
  });
});
