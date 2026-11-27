import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { goodReg, INVITE, MID } from "./app.fixture.js";
import { dropMachineLink } from "./dashboard-links.js";
import { openDb, type Db } from "./db.js";
import { cookieOf, dashboardLinkToken, heldRequest, machineIdOf, memberSignIn, postFromPage, PUBLIC, settle } from "./hosted.fixture.js";
import { everythingOf, manageWorld, RANGE, type ManageWorld } from "./manage.fixture.js";
import { endMachineSessions } from "./sessions.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

const OPEN = "/api/dashboard-link/open";

/** The database and app of the running test; each `describe` sets them before every test. */
let db: Db;
let app: Hono;

/** Asks for the statistics of every upload with `headers`. */
const stats = (headers: Record<string, string>) => app.request(`/api/stats?${RANGE}`, { headers });
/** Opens the link token `token` from a browser with no cookie. */
const openLink = (token: string) => postFromPage(app, OPEN, { token });
/** The body of a registration of machine `machineId` with the team's `code` and the member's `email`. */
const registration = (code: string, email: string, machineId: string) => goodReg({ inviteCode: code, email, machineId });
/** Registers machine `machineId` with the team's `code` and the member's `email`, as `teamusage setup` does. */
const register = (code: string, email: string, machineId: string) => postFromPage(app, "/api/register", registration(code, email, machineId));
/** Every session row of member `memberId` of team `teamId`, in the order they were opened. */
const sessionRowsOf = (db: Db, teamId: number, memberId: number) =>
  db.prepare("select * from sessions where team_id = ? and member_id = ? order by rowid").all(teamId, memberId);
/** The member sessions opened from machine `machineId` of team `teamId`. */
const machineSessionRows = (teamId: number, machineId: string) =>
  db.prepare("select * from sessions where kind = 'member' and team_id = ? and machine_id = ?").all(teamId, machineId);
/** Every session row of the server, in the order they were opened. */
const allSessionRows = () => db.prepare("select * from sessions order by rowid").all();

describe("on a hosted server", () => {
  let w: ManageWorld;
  beforeEach(async () => {
    w = await manageWorld();
    ({ db, app } = w);
  });

  test("registering again ends that machine's browser sign-ins and its pending link, and nobody else's", async () => {
    const { A, B } = w;
    const session = await memberSignIn(app, B.sam.one.token);            // a browser signed in from sam's first machine
    const pending = await dashboardLinkToken(app, B.sam.one.token);      // a link asked for and not yet opened
    const other = await memberSignIn(app, B.sam.two.token);              // sam's second machine
    const colleague = await memberSignIn(app, B.tia.one.token);
    const otherLink = await dashboardLinkToken(app, B.sam.two.token);    // links of sam's second machine and of tia's
    const colleaguesLink = await dashboardLinkToken(app, B.tia.one.token);
    const before ={ A: everythingOf(db, A.id), tia: sessionRowsOf(db, B.id, B.tia.memberId) };

    const again = await register(B.code, B.sam.email, B.sam.one.id);     // the same machine id and email
    const { token } = (await again.json()) as { token: string };

    expect((await stats({ Authorization: `Bearer ${B.sam.one.token}` })).status).toBe(401);
    expect((await stats({ Cookie: session })).status).toBe(401);
    expect((await stats({ Cookie: B.sam.session })).status).toBe(401);
    expect((await openLink(pending)).status).toBe(403);
    expect((await stats({ Cookie: other })).status).toBe(200);
    expect((await stats({ Cookie: colleague })).status).toBe(200);
    expect((await stats({ Cookie: await memberSignIn(app, token) })).status).toBe(200);   // the new token opens a new sign-in
    expect({ A: everythingOf(db, A.id), tia: sessionRowsOf(db, B.id, B.tia.memberId) }).toEqual(before);
    expect((await openLink(otherLink)).status).toBe(204);
    expect((await openLink(colleaguesLink)).status).toBe(204);
  });

  test("a registration that is refused ends nothing", async () => {
    const { B } = w;
    const pending = await dashboardLinkToken(app, B.sam.one.token);
    const refused = await register(B.code, B.tia.email, B.sam.one.id);   // sam's machine id with another member's email
    expect(refused.status).toBe(409);
    expect((await stats({ Cookie: B.sam.session })).status).toBe(200);
    expect((await openLink(pending)).status).toBe(204);
  });

  test("a machine that registers for the first time ends nothing of the member's other machines", async () => {
    const { B } = w;
    const pending = await dashboardLinkToken(app, B.sam.two.token);
    const first = await register(B.code, B.sam.email, machineIdOf(0xb4));
    expect(first.status).toBe(200);
    expect((await stats({ Cookie: B.sam.session })).status).toBe(200);
    expect((await openLink(pending)).status).toBe(204);
  });

  test("registering again in B leaves the session and the link of A's machine with the same id working", async () => {
    const { A, B } = w;
    const laptop = A.members[0]!.one;                                    // the same laptop, joined to both teams
    expect(laptop.id).toBe(B.sam.one.id);
    const session = await memberSignIn(app, laptop.token);
    const pending = await dashboardLinkToken(app, laptop.token);
    expect((await register(B.code, B.sam.email, B.sam.one.id)).status).toBe(200);
    expect((await stats({ Cookie: session })).status).toBe(200);
    expect((await stats({ Cookie: A.memberSession })).status).toBe(200);
    expect((await openLink(pending)).status).toBe(204);
  });

  test("endMachineSessions and dropMachineLink for B leave every row of A and every other session as it was", async () => {
    const { A, B } = w;
    const laptop = A.members[0]!.one;
    await dashboardLinkToken(app, laptop.token);
    await dashboardLinkToken(app, B.sam.one.token);
    await dashboardLinkToken(app, B.sam.two.token);
    const linkOf = (machineId: string) => everythingOf(db, B.id).dashboard_links!.filter((l) => (l as { machine_id: string }).machine_id === machineId);
    const samsSecondLink = linkOf(B.sam.two.id);
    expect(samsSecondLink).toHaveLength(1);
    const isSamsFirst = (row: unknown) => {
      const r = row as { kind: string; team_id: number; machine_id: string };
      return r.kind === "member" && r.team_id === B.id && r.machine_id === B.sam.one.id;
    };
    const before = { A: everythingOf(db, A.id), others: allSessionRows().filter((r) => !isSamsFirst(r)) };
    expect(allSessionRows().filter(isSamsFirst)).not.toEqual([]);

    endMachineSessions(db, B.id, B.sam.one.id);
    dropMachineLink(db, B.id, B.sam.one.id);

    expect(machineSessionRows(B.id, B.sam.one.id)).toEqual([]);
    expect(everythingOf(db, B.id).dashboard_links).toEqual(samsSecondLink);
    expect({ A: everythingOf(db, A.id), others: allSessionRows() }).toEqual(before);
  });

  /** Checks that the old token, the old session and the old link are refused and that no session of the machine is left. */
  async function expectOldSignInsEnded(oldSession: string, pending: string, opened: Response): Promise<void> {
    const { B } = w;
    expect((await stats({ Authorization: `Bearer ${B.sam.one.token}` })).status).toBe(401);
    expect((await stats({ Cookie: oldSession })).status).toBe(401);
    expect((await openLink(pending)).status).toBe(403);
    const fromLink = cookieOf(opened, "tu_session");
    if (fromLink) expect((await stats({ Cookie: fromLink })).status).toBe(401);
    expect(machineSessionRows(B.id, B.sam.one.id)).toEqual([]);
  }

  test("registering again while the machine's link is opened and its session asks for statistics ends them all", async () => {
    const { B } = w;
    const pending = await dashboardLinkToken(app, B.sam.one.token);
    const [again, opened, asked] = await Promise.all([
      register(B.code, B.sam.email, B.sam.one.id),
      openLink(pending),
      stats({ Cookie: B.sam.session }),
    ]);
    expect(again.status).toBe(200);
    expect([204, 403]).toContain(opened.status);
    expect([200, 401]).toContain(asked.status);
    await expectOldSignInsEnded(B.sam.session, pending, opened);
  });

  test.each(["the registration", "the link"])("with both open together and %s taken first, the old sign-ins all end", async (firstTaken) => {
    const { B } = w;
    const pending = await dashboardLinkToken(app, B.sam.one.token);
    const json = { "Content-Type": "application/json", Origin: PUBLIC };
    const again = heldRequest(app, "/api/register", { method: "POST", text: JSON.stringify(registration(B.code, B.sam.email, B.sam.one.id)), headers: json });
    const open = heldRequest(app, OPEN, { method: "POST", text: JSON.stringify({ token: pending }), headers: json });
    await settle();                                                      // both handlers now wait for their bodies
    const [first, second] = firstTaken === "the link" ? [open, again] : [again, open];
    first.finish();
    await first.answer;
    second.finish();
    const opened = await open.answer;
    expect((await again.answer).status).toBe(200);
    expect(opened.status).toBe(firstTaken === "the link" ? 204 : 403);
    await expectOldSignInsEnded(B.sam.session, pending, opened);
  });
});

describe("on a self-hosted server", () => {
  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE) });
  });

  test("registering again ends that machine's member session and its link, and a browser signed in with the code stays signed in", async () => {
    const first = (await (await register(INVITE, "ann@example.com", MID)).json()) as { token: string };
    const session = await memberSignIn(app, first.token);
    const pending = await dashboardLinkToken(app, first.token);
    const coded = cookieOf(await postFromPage(app, "/api/login", { inviteCode: INVITE }), "tu_session");
    expect((await stats({ Cookie: coded })).status).toBe(200);

    expect((await register(INVITE, "ann@example.com", MID)).status).toBe(200);

    expect((await stats({ Cookie: session })).status).toBe(401);
    expect((await openLink(pending)).status).toBe(403);
    expect((await stats({ Cookie: coded })).status).toBe(200);
  });
});
