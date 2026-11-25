import type { Hono } from "hono";
import { createApp } from "./app.js";
import type { AppOptions } from "./app-context.js";
import { openDb } from "./db.js";
import type { GithubClient, GithubUser } from "./github.js";
import { hostedTeamCodes } from "./hosted-teams.js";

/** The hosted test server's own origin. */
export const PUBLIC = "https://teamusage.example";
/** The hosted test server's code key. */
export const KEY = Buffer.alloc(32, 7);
/** The GitHub users the fixture's fake GitHub knows, by the callback code that signs each in. */
const USERS: Record<string, GithubUser> = {
  "code-ann": { id: 1, login: "ann" },
  "code-bob": { id: 2, login: "bob" },
};

export type FakeGithub = GithubClient & { calls: { code: string; verifier: string }[] };

/**
 * A GitHub that knows `users` by callback code and records every `fetchUser` call. Like GitHub, it takes a code
 * once: GitHub issues a fresh code for each sign-in, so here a code is taken once per sign-in's verifier.
 */
export function fakeGithub(users: Record<string, GithubUser>): FakeGithub {
  const calls: FakeGithub["calls"] = [];
  const exchanged = new Set<string>();
  return {
    calls,
    authorizeUrl: ({ state, challenge }) => `https://github.test/authorize?state=${state}&challenge=${challenge}`,
    fetchUser: async (a) => {
      calls.push(a);
      const key = `${a.code} ${a.verifier}`;
      const user = users[a.code];
      if (user === undefined || exchanged.has(key)) return null;
      exchanged.add(key);
      return user;
    },
  };
}

/** A hosted app on a fresh in-memory database, with the fake GitHub it signs users in with. */
export function hostedApp(o: { clientKey?: AppOptions["clientKey"]; maxTeams?: number; logError?: AppOptions["logError"] } = {}) {
  const db = openDb(":memory:");
  const github = fakeGithub(USERS);
  const app = createApp(db, {
    teamForCode: hostedTeamCodes(db),
    clientKey: o.clientKey,
    logError: o.logError,
    hosted: { github, publicUrl: PUBLIC, codeKey: KEY, maxTeams: o.maxTeams ?? 200 },
  });
  return { db, app, github };
}

/** The `name=value` pair of the cookie `name` that the response sets; "" when it sets none. */
export const cookieOf = (res: Response, name: string): string =>
  new RegExp(`${name}=[^;]*`).exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";

/** Signs in through start and callback with the GitHub callback `code`; returns the `tu_session` cookie. */
export async function signIn(app: Hono, code: string): Promise<string> {
  const start = await app.request("/auth/github/start");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const res = await app.request(`/auth/github/callback?code=${encodeURIComponent(code)}&state=${state}`, {
    headers: { Cookie: cookieOf(start, "tu_oauth") },
  });
  const session = cookieOf(res, "tu_session");
  if (!session) throw new Error(`signing in with ${code} failed`);
  return session;
}
