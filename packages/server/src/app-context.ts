import type { Context } from "hono";
import type { Session } from "./sessions.js";
import type { Db } from "./db.js";
import type { GithubClient } from "./github.js";
import type { TeamData } from "./team-data.js";
import type { TeamLimits } from "./team-limits.js";

export type AppOptions = {
  /** The team an invite code opens, or null when it opens none. */
  teamForCode: (code: unknown) => number | null;
  /** Demo mode: stats of this team are open to everyone. */
  demoTeamId?: number;
  now?: () => number;
  /** A clock for measuring how long work takes, in milliseconds; the real one unless a test gives its own. */
  stopwatch?: () => number;
  /** Identifies the client for failed-attempt limiting. No request header is trusted by default. */
  clientKey?: (c: Context) => string;
  /** Receives one line per 500; defaults to stderr. */
  logError?: (line: string) => void;
  /**
   * Hosted mode: what a team may hold, how often a machine may upload, how many upload records a team may send and how
   * many milliseconds of statistics work a team may use, each a minute, and how many days of usage a team keeps. Absent
   * on a self-hosted server, which limits none.
   */
  limits?: {
    team: TeamLimits;
    uploadsPerMinute: number;
    teamUploadRecordsPerMinute: number;
    teamStatsMsPerMinute: number;
    usageDaysKept: number;
  };
  /** Hosted mode: users sign in with GitHub and teams are created by them. Absent on a self-hosted server. */
  hosted?: { github: GithubClient; publicUrl: string; codeKey: Buffer; maxTeams: number };
  /** A self-hosted server's own origin, when it knows it: signing in with the code and opening a member's link are then accepted only from pages at this origin. */
  signInOrigin?: string;
  /** How a long removal is paced: usage rows a slice, and the pause between slices that lets other requests in. Defaults: REMOVAL_SLICE_ROWS and one turn of the event loop (`setImmediate`). */
  removal?: { sliceRows?: number; pause?: () => Promise<void> };
};

/** A request whose invite code opens a team: the team and the request's body. */
export type InviteEntry = { teamId: number; body: Record<string, unknown> };

/** What every route group receives from createApp. */
export type RouteContext = {
  db: Db;
  opts: AppOptions;
  /**
   * Reads the request's body and the team its invite code opens; otherwise the 400, 403 or 429 that refuses it.
   * Over its limit, a client gets in only with a correct code, and only on a hosted server.
   */
  teamOfInvite(c: Context): Promise<InviteEntry | Response>;
  /** The server's clock in epoch milliseconds: `opts.now`, or the real one. */
  now(): number;
  /** Milliseconds for measuring how long work takes: `opts.stopwatch`, or the real one. */
  stopwatch(): number;
  /** The data of a team as the routes use it: the server's clock, and the limits and days kept when the server has any. */
  team(teamId: number): TeamData;
  /** The session the request's cookie opens; null when it has none, an unknown one or an expired one. */
  session(c: Context): Session | null;
  /** How a long removal is paced: `opts.removal` with its defaults filled in. */
  removal: { sliceRows: number; pause: () => Promise<void> };
};
