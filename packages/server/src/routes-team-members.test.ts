import { beforeEach, expect, test } from "vitest";
import { goodReg } from "./app.fixture.js";
import { machineIdOf, postFromPage, PUBLIC } from "./hosted.fixture.js";
import { asUser, manageWorld, notGithubSessions, send, T0, type ManageWorld, type Who } from "./manage.fixture.js";
import { forTeam } from "./team-data.js";

const JOINED = T0;
const SYNCED = T0;

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const membersPath = (team = w.B) => `/api/teams/${team.publicId}/members`;
const as = (who: Who, path: string) => asUser(w, who, path);

test("an admin gets the team's members with their machines, and nothing of another team", async () => {
  const res = await as("cyd", membersPath());
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  for (const marker of [w.A.name, w.A.code, w.A.members[1]!.name, w.A.members[1]!.email]) expect(text).not.toContain(marker);
  expect(JSON.parse(text)).toEqual({
    members: [
      {
        id: w.B.sam.memberId,
        name: "Sam",
        email: "sam@example.com",
        joinedAt: JOINED,
        machines: [
          { id: w.B.sam.one.id, label: "sam-laptop", lastSyncAt: SYNCED },
          { id: w.B.sam.two.id, label: "sam-desktop", lastSyncAt: SYNCED },
        ],
      },
      {
        id: w.B.tia.memberId,
        name: "Tia",
        email: "tia@example.com",
        joinedAt: JOINED,
        machines: [{ id: w.B.tia.one.id, label: "tia-laptop", lastSyncAt: SYNCED }],
      },
    ],
  });
});

test("the owner gets the list too", async () => {
  const res = await as("bob", membersPath());
  expect(res.status).toBe(200);
  expect(((await res.json()) as { members: unknown[] }).members).toHaveLength(2);
});

test("a member with no machine left is listed with no machines, and keeps the time they joined", async () => {
  forTeam(w.db, w.B.id).removeMachine(w.B.tia.one.id);
  const { members } = (await (await as("cyd", membersPath())).json()) as { members: { id: number; joinedAt: string; machines: unknown[] }[] };
  expect(members.map((m) => m.id)).toEqual([w.B.sam.memberId, w.B.tia.memberId]);
  expect(members[1]).toMatchObject({ joinedAt: JOINED, machines: [] });
});

test("a team with no member answers an empty list", async () => {
  const created = await asUser(w, "eve", "/api/teams", { method: "POST", body: { name: "Empty Nest", dashboardAccess: "members" } });
  const { team } = (await created.json()) as { team: { id: string } };
  const res = await as("eve", `/api/teams/${team.id}/members`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ members: [] });
});

test("a viewer gets 403", async () => {
  const res = await as("dee", membersPath());
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "your role does not allow this" });
});

test("a user with no role in the team gets the 404 of a team that does not exist", async () => {
  for (const who of ["ann", "zoe", "eve"] as const) {
    const res = await as(who, membersPath());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "team not found" });
  }
});

test("no credential, a machine token and a member's session get 401", async () => {
  for (const headers of [...notGithubSessions(w), { Cookie: w.A.memberSession }]) {
    const res = await send(w, "GET", membersPath(), undefined, { ...headers, Origin: PUBLIC });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }
});

test("a registration after a list shows in the next list", async () => {
  const joined = await postFromPage(w.app, "/api/register", goodReg({ inviteCode: w.B.code, name: "Una", email: "una@example.com", machineId: machineIdOf(0xc1), machineLabel: "una-laptop" }));
  expect(joined.status).toBe(200);
  const after = (await (await as("cyd", membersPath())).json()) as { members: { name: string }[] };
  expect(after.members.map((m) => m.name)).toEqual(["Sam", "Tia", "Una"]);
});
