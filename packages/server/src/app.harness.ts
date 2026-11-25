import { beforeEach } from "vitest";
import { createApp } from "./app.js";
import { goodReg, INVITE } from "./app.fixture.js";
import { openDb, type Db } from "./db.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

/** The database, app and logged error lines of the running test; `useFreshApp` replaces them before each test. */
export let db: Db;
export let app: ReturnType<typeof createApp>;
export let logged: string[];
export const logError = (line: string) => logged.push(line);

/** Gives every test of the calling file a fresh in-memory database and an app on it. */
export function useFreshApp() {
  beforeEach(() => {
    db = openDb(":memory:");
    logged = [];
    app = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE), logError });
  });
}

export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });

export const register = async (over: Record<string, unknown> = {}) => {
  const res = await post("/api/register", goodReg(over));
  return (await res.json()) as { token: string; memberId: number };
};
export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export const sessionCookie = (res: Response): string => {
  const sc = res.headers.get("Set-Cookie") ?? "";
  return /tu_session=[^;]+/.exec(sc)?.[0] ?? "";
};
export const login = (headers: Record<string, string> = {}, code = INVITE) => post("/api/login", { inviteCode: code }, headers);
export const getStatsReq = (qs: string, headers: Record<string, string> = {}) => app.request(`/api/stats?${qs}`, { headers });
export const RANGE = "from=2026-11-01&to=2026-11-10";
