import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { goodReg, INVITE } from "./app.fixture.js";
import { openDb, sha256, type Db } from "./db.js";
import { cookieOf, dashboardLinkToken, hostedApp, hostedTeam, machineClient, machineIdOf, memberSignIn, postFromPage, signIn } from "./hosted.fixture.js";
import { everythingOf, manageWorld, userRows, type ManageWorld } from "./manage.fixture.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

const OPEN = "/api/dashboard-link/open";

describe("on a hosted team whose members see it", () => {
  let db: Db;
  let app: Hono;
  let teamId: number;
  /** The machine tokens of the team's two members. */
  let firstMachine: string, secondMachine: string;
  beforeEach(async () => {
    ({ db, app } = hostedApp());
    const { team, code } = hostedTeam(db, { githubId: 5101, login: "own" }, "members", "Acme");
    teamId = team.id;
    const machine = machineClient(() => app, () => code);
    firstMachine = await machine.join({ email: "first@example.com", machineId: machineIdOf(1) });
    secondMachine = await machine.join({ name: "Second", email: "second@example.com", machineId: machineIdOf(2) });
  });

  const sessionCount = () => (db.prepare("select count(*) as n from sessions").get() as { n: number }).n;
  const me = (cookie: string) => app.request("/api/me", { headers: { Cookie: cookie } });
  /** Opens the link token `link` from a browser holding `cookie`. */
  const openLink = (link: string, cookie: string) => postFromPage(app, OPEN, { token: link }, cookie ? { Cookie: cookie } : {});
  /** Opens a new link of the machine `token` from a browser holding `cookie`; returns the answer. */
  const openFrom = async (token: string, cookie: string) => openLink(await dashboardLinkToken(app, token), cookie);

  test("opening a member's link with a GitHub session's cookie ends that GitHub session", async () => {
    const github = await signIn(app, "code-eve");
    const opened = await openFrom(firstMachine, github);
    expect(opened.status).toBe(204);
    expect((await me(github)).status).toBe(401);
    expect((await me(cookieOf(opened, "tu_session"))).status).toBe(200);
    expect(sessionCount()).toBe(1);
  });
  test("opening a member's link with another member's session's cookie ends that one", async () => {
    const seconds = cookieOf(await openFrom(secondMachine, ""), "tu_session");
    const opened = await openFrom(firstMachine, seconds);
    expect(opened.status).toBe(204);
    expect((await me(seconds)).status).toBe(401);
    expect(sessionCount()).toBe(1);
  });
  test("a link that is refused ends nothing", async () => {
    const github = await signIn(app, "code-eve");
    const link = await dashboardLinkToken(app, firstMachine);
    expect((await openLink(link, "")).status).toBe(204);
    expect((await openLink(link, github)).status).toBe(403);
    expect((await me(github)).status).toBe(200);
    expect(sessionCount()).toBe(2);
  });
  test("a link refused because the team is now for its admins only ends nothing", async () => {
    const github = await signIn(app, "code-eve");
    const link = await dashboardLinkToken(app, firstMachine);
    // The product's switch to admins also drops the team's links; this reaches the second lock, in the opening, as
    // routes-member-sign-in.test.ts does.
    db.prepare("update teams set dashboard_access = 'admins' where id = ?").run(teamId);
    const before = sessionCount();
    const refused = await openLink(link, github);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "this team's dashboard is limited to its admins" });
    expect((await me(github)).status).toBe(200);
    expect(sessionCount()).toBe(before);
  });
  test("a cookie that names no session changes nothing", async () => {
    const github = await signIn(app, "code-eve");
    expect((await openFrom(firstMachine, "tu_session=unknown")).status).toBe(204);
    expect((await me(github)).status).toBe(200);
    expect(sessionCount()).toBe(2);
  });
  test("two links opened together from one browser end its session and leave only their own two", async () => {
    const github = await signIn(app, "code-eve");
    const [one, two] = await Promise.all([openFrom(firstMachine, github), openFrom(secondMachine, github)]);
    expect([one.status, two.status]).toEqual([204, 204]);
    expect((await me(github)).status).toBe(401);
    expect(sessionCount()).toBe(2);
  });
});

/** The id under which the session of the `tu_session=<id>` cookie `cookie` is stored. */
const storedIdOf = (cookie: string) => sha256(cookie.slice("tu_session=".length));
const allSessions = (w: ManageWorld) => w.db.prepare("select * from sessions order by rowid").all() as { id: string }[];
type TwoTeamBrowser = (w: ManageWorld) => string;

test.each<[string, TwoTeamBrowser]>([
  ["a member of A", (w) => w.A.memberSession],
  ["A's GitHub owner", (w) => w.cookies.ann],
])("a browser signed in as %s that opens a link of B ends that one session and touches nothing else of A", async (_who, browserOf) => {
  const w = await manageWorld();
  // Sessions the browser does not hold: A's first member and ann each have a second one, A's second member has one.
  await memberSignIn(w.app, w.A.members[0]!.one.token);
  await memberSignIn(w.app, w.A.members[1]!.one.token);
  await signIn(w.app, "code-ann");
  const browser = browserOf(w);
  const [sessionsBefore, rowsOfA, users] = [allSessions(w), everythingOf(w.db, w.A.id), userRows(w.db)];
  expect(sessionsBefore.map((r) => r.id)).toContain(storedIdOf(browser));

  const link = await dashboardLinkToken(w.app, w.B.tia.one.token);
  const opened = await postFromPage(w.app, OPEN, { token: link }, { Cookie: browser });
  expect(opened.status).toBe(204);
  const now = cookieOf(opened, "tu_session");
  expect((await w.app.request("/api/me", { headers: { Cookie: browser } })).status).toBe(401);
  const me = await w.app.request("/api/me", { headers: { Cookie: now } });
  expect(await me.json()).toEqual({ kind: "member", team: { id: w.B.publicId, name: w.B.name }, memberId: w.B.tia.memberId });
  const without = (id: string) => (rows: { id: string }[]) => rows.filter((r) => r.id !== id);
  expect(without(storedIdOf(now))(allSessions(w))).toEqual(without(storedIdOf(browser))(sessionsBefore));
  const otherSessionsOfA = without(storedIdOf(browser))(rowsOfA.sessions as { id: string }[]);
  expect(everythingOf(w.db, w.A.id)).toEqual({ ...rowsOfA, sessions: otherSessionsOfA });
  expect(userRows(w.db)).toEqual(users);
});

test("a self-hosted server: opening a link with a code session's cookie ends that code session and no other", async () => {
  const selfDb = openDb(":memory:");
  const selfApp = createApp(selfDb, { teamForCode: singleTeamCodes(ensureSingleTeam(selfDb), () => INVITE) });
  const post = (path: string, body: unknown, cookie = "") =>
    selfApp.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    });
  const codeSession = async () => cookieOf(await post("/api/login", { inviteCode: INVITE }), "tu_session");
  const stats = (cookie: string) => selfApp.request("/api/stats?from=2026-11-01&to=2026-11-10", { headers: { Cookie: cookie } });
  const [mine, other] = [await codeSession(), await codeSession()];
  const { token } = (await (await post("/api/register", goodReg())).json()) as { token: string };
  const opened = await post(OPEN, { token: await dashboardLinkToken(selfApp, token) }, mine);
  expect(opened.status).toBe(204);
  const statuses = [await stats(mine), await stats(other), await stats(cookieOf(opened, "tu_session"))].map((r) => r.status);
  expect(statuses).toEqual([401, 200, 200]);
  expect((selfDb.prepare("select count(*) as n from sessions").get() as { n: number }).n).toBe(2);
});
