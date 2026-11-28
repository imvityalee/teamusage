import { afterEach } from "vitest";
import type { DashboardAccess } from "./hosted-teams.js";
import { fakeGithub, postFromPage, signIn } from "./hosted.fixture.js";
import { conn, hosted, PUBLIC_URL, roomy, tempDataDir } from "./main.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";

/** The day the whole-site tests run on, at noon UTC: a fixed clock, never the real one. */
export const TODAY = "2026-11-20";
export const NOON = Date.parse(`${TODAY}T12:00:00.000Z`);

/** GitHub users by callback code. Their GitHub ids are far from any row id a test's database makes. */
export const PEOPLE = {
  "code-bob": { id: 7101, login: "bob" },
  "code-ann": { id: 7202, login: "ann" },
  "code-eve": { id: 7303, login: "eve" },
};

const servers: BuiltServer[] = [];
// Registered by every test file that imports this module: its servers close after each test.
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A hosted server on a fresh data directory with the fake GitHub of `PEOPLE`, room on its volume and `opts`; closed after the test. */
export function hostedServer(opts: Parameters<typeof buildServer>[1] = {}): BuiltServer {
  const s = buildServer(hosted(tempDataDir()), { github: fakeGithub(PEOPLE), measureDisk: roomy, now: () => NOON, ...opts });
  servers.push(s);
  return s;
}

/** Keeps `s` to be closed after the test. */
export function closedAfterTest(s: BuiltServer): BuiltServer {
  servers.push(s);
  return s;
}

/** A request from the server's own pages: JSON with the hosted origin and the browser's `cookie`, if any. */
export const fromPage = async (s: BuiltServer, path: string, body: unknown, cookie = ""): Promise<Response> =>
  postFromPage(s.app, path, body, cookie ? { Cookie: cookie } : {}, { origin: PUBLIC_URL, conn });

/** A GET with the browser's `cookie`, if any. */
export const getWith = async (s: BuiltServer, path: string, cookie = ""): Promise<Response> =>
  s.app.request(path, cookie ? { headers: { Cookie: cookie } } : {}, conn);

/** Signs `code`'s GitHub user in and creates a team named `name`; returns their session cookie, the team's public id and its code. */
export async function ownerWithTeam(s: BuiltServer, code: keyof typeof PEOPLE, name: string, access: DashboardAccess) {
  const cookie = await signIn(s.app, code);
  const res = await fromPage(s, "/api/teams", { name, dashboardAccess: access }, cookie);
  if (res.status !== 201) throw new Error(`creating a team answered ${res.status}`);
  const created = (await res.json()) as { team: { id: string }; code: string };
  return { cookie, team: created.team.id, code: created.code };
}

/** The row ids of every team on the server. */
export const teamRowIds = (s: BuiltServer): number[] =>
  (s.db.prepare("select id from teams").all() as { id: number }[]).map((t) => t.id);
