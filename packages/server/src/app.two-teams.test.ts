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
  test("a token of one team with a cookie of the other reads the token's team; a bad token is 401", async () => {
    const ta = await join(CODE_A, "ann@example.com");
    await join(CODE_B, "bob@example.com");
    const c = await cookie(CODE_B);
    const res = await stats({ Authorization: `Bearer ${ta}`, Cookie: c });
    expect(((await res.json()) as { members: { email: string }[] }).members.map((m) => m.email)).toEqual(["ann@example.com"]);
    expect((await stats({ Authorization: "Bearer bad", Cookie: c })).status).toBe(401);
  });
  test("an upload with one team's token leaves the other team's numbers unchanged", async () => {
    const ta = await join(CODE_A, "ann@example.com");
    const tb = await join(CODE_B, "ann@example.com");
    await call("/api/usage", json({ records: [record()] }, { Authorization: `Bearer ${ta}` }));
    const tokensOf = async (token: string) =>
      ((await (await stats({ Authorization: `Bearer ${token}` })).json()) as { totals: { tokens: number } }).totals.tokens;
    expect((await call("/api/usage", json({ records: [record({ input: 21, total: 30 })] }, { Authorization: `Bearer ${tb}` }))).status).toBe(200);
    expect([await tokensOf(ta), await tokensOf(tb)]).toEqual([10, 30]);
  });
  test("a member's own id with their team's credential is 200 with that team's numbers", async () => {
    await join(CODE_A, "ann@example.com");
    const tb = await join(CODE_B, "bob@example.com");
    await call("/api/usage", json({ records: [record({ input: 21, total: 30 })] }, { Authorization: `Bearer ${tb}` }));
    const bobId = forTeam(db, B).listMembers()[0]!.id;
    const res = await stats({ Authorization: `Bearer ${tb}` }, `&member=${bobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { tokens: number }; members: { email: string }[] };
    expect(body.totals.tokens).toBe(30);
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
