import { beforeEach, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import { codeHash } from "./codes.js";
import { openDb } from "./db.js";
import { KEY, postFromPage, PUBLIC } from "./hosted.fixture.js";
import { appOnSameDatabase, asUser, codeRow, everythingOf, manageWorld, RANGE, type ManageWorld, type Who } from "./manage.fixture.js";
import { createTeam } from "./teams.js";
import { rotateTeamCode, teamCode } from "./team-settings.js";

let w: ManageWorld;
let logged: string[];
beforeEach(async () => {
  logged = [];
  w = await manageWorld({ logError: (line) => logged.push(line) });
});

const codePath = (team = w.B) => `/api/teams/${team.publicId}/code`;
const rotatePath = (team = w.B) => `${codePath(team)}/rotate`;
const as = (who: Who, path: string) => asUser(w, who, path);
const post = (who: Who, path: string) => asUser(w, who, path, { method: "POST" });
const register = (code: string, email: string) => postFromPage(w.app, "/api/register", goodReg({ inviteCode: code, email }));
const upload = (token: string, records: unknown[]) => postFromPage(w.app, "/api/usage", { records }, { Authorization: `Bearer ${token}` });
const stats = (session: string) => w.app.request(`/api/stats?${RANGE}`, { headers: { Cookie: session } });
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

test("an admin sees the code the team was created with", async () => {
  expect(await (await as("cyd", codePath())).json()).toEqual({ code: w.B.code });
});
test("after a rotation the old code joins nobody, the new one does, and nobody already in is touched", async () => {
  const before = codeRow(w.db, w.A.id);
  const res = await post("bob", rotatePath());
  const { code } = (await res.json()) as { code: string };
  expect(code).toMatch(/^[a-f0-9]{24}$/);
  expect(code).not.toBe(w.B.code);
  expect((await register(w.B.code, "new@example.com")).status).toBe(403);
  expect((await register(code, "new@example.com")).status).toBe(200);
  expect((await upload(w.B.sam.one.token, [record()])).status).toBe(200); // a machine that joined before keeps sending
  expect((await stats(w.B.sam.session)).status).toBe(200); // and its member stays signed in
  expect(await (await as("bob", codePath())).json()).toEqual({ code });
  expect(codeRow(w.db, w.A.id)).toEqual(before); // A's hash and sealed text
  expect((await register(w.A.code, "other@example.com")).status).toBe(200);
});
test("a code sealed under a key the server no longer has cannot be shown, and rotating repairs it", async () => {
  const other = await appOnSameDatabase(w.db, Buffer.alloc(32, 9)); // the same database, another code key, bob signed in again
  const shown = await other.as("bob", codePath());
  expect(shown.status).toBe(409);
  expect(await shown.json()).toEqual({ error: "this code can no longer be shown; rotate it" });
  const { code } = (await (await other.post("bob", rotatePath())).json()) as { code: string };
  expect(await (await other.as("bob", codePath())).json()).toEqual({ code });
});
test("a viewer gets 403 on both routes and the code row is unchanged", async () => {
  const before = codeRow(w.db, w.B.id);
  for (const res of [await as("dee", codePath()), await post("dee", rotatePath())]) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "your role does not allow this" });
  }
  expect(codeRow(w.db, w.B.id)).toEqual(before);
});
test("a user with no role in the team gets the 404 of a team that does not exist, on both routes", async () => {
  const before = codeRow(w.db, w.B.id);
  for (const who of ["ann", "zoe", "eve"] as const) {
    for (const res of [await as(who, codePath()), await post(who, rotatePath())]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "team not found" });
    }
  }
  expect(codeRow(w.db, w.B.id)).toEqual(before);
});
test("no credential, a machine token and a member's session get 401 on both routes", async () => {
  const before = codeRow(w.db, w.B.id);
  const credentials: Record<string, string>[] = [{}, { Authorization: `Bearer ${w.B.sam.one.token}` }, { Cookie: w.B.sam.session }];
  for (const headers of credentials) {
    const got = await w.app.request(codePath(), { headers });
    const posted = await w.app.request(rotatePath(), { method: "POST", headers: { ...headers, Origin: PUBLIC } });
    expect([got.status, posted.status]).toEqual([401, 401]);
  }
  expect(codeRow(w.db, w.B.id)).toEqual(before);
});
test("a rotation without the server's Origin is 403 and rotates nothing", async () => {
  const before = codeRow(w.db, w.B.id);
  for (const origin of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
    const res = await w.app.request(rotatePath(), { method: "POST", headers: { Cookie: w.cookies.bob, ...origin } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-site request refused" });
  }
  expect(codeRow(w.db, w.B.id)).toEqual(before);
});
test("the answers carry no-store, and no code reaches the error log after a show, a rotation and a 409", async () => {
  const shown = await as("bob", codePath());
  const rotated = await post("bob", rotatePath());
  const other = await appOnSameDatabase(w.db, Buffer.alloc(32, 9));
  const refused = await other.as("bob", codePath());
  expect([shown.status, rotated.status, refused.status]).toEqual([200, 200, 409]);
  for (const res of [shown, rotated, refused]) expect(res.headers.get("cache-control")).toBe("no-store");
  expect(logged.join("\n")).not.toMatch(/[a-f0-9]{24}/);
});
test("two rotations open together each answer with a code of their own; one of them is the team's", async () => {
  const before = codeRow(w.db, w.A.id);
  const [one, two] = await Promise.all([post("bob", rotatePath()), post("cyd", rotatePath())]);
  expect([one.status, two.status]).toEqual([200, 200]);
  const codes = [await codeOf(one), await codeOf(two)];
  expect(codes[0]).not.toBe(codes[1]);
  const current = await codeOf(await as("bob", codePath()));
  expect(codes).toContain(current);
  const [kept] = codes.filter((c) => c !== current);
  expect((await register(current, "new@example.com")).status).toBe(200);
  expect((await register(kept!, "late@example.com")).status).toBe(403);
  expect(codeRow(w.db, w.A.id)).toEqual(before);
});

test("rotateTeamCode leaves A's row and both teams' sessions as they were", () => {
  const [a, sessions] = [everythingOf(w.db, w.A.id), (id: number) => everythingOf(w.db, id).sessions];
  const bSessions = sessions(w.B.id);
  const code = rotateTeamCode(w.db, w.B.id, KEY);
  expect(code).toMatch(/^[a-f0-9]{24}$/);
  expect(teamCode(w.db, w.B.id, KEY)).toBe(code);
  expect(codeRow(w.db, w.B.id)).toMatchObject({ code_hash: codeHash(code) });
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
  expect(sessions(w.B.id)).toEqual(bSessions);
});
test("teamCode is null for a team without a sealed code", () => {
  const selfHosted = openDb(":memory:");
  expect(teamCode(selfHosted, createTeam(selfHosted, "Solo"), KEY)).toBeNull();
});
