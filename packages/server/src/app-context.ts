import type { Context } from "hono";
import type { Db } from "./db.js";

export type AppOptions = {
  /** The team an invite code opens, or null when it opens none. */
  teamForCode: (code: unknown) => number | null;
  /** Demo mode: stats of this team are open to everyone. */
  demoTeamId?: number;
  now?: () => number;
  /** Identifies the client for failed-attempt limiting. No request header is trusted by default. */
  clientKey?: (c: Context) => string;
  /** Receives one line per 500; defaults to stderr. */
  logError?: (line: string) => void;
};

/** What every route group receives from createApp. */
export type RouteContext = {
  db: Db;
  opts: AppOptions;
  /** 429 when the client has used up its failed attempts, else null. */
  throttled(c: Context): Response | null;
  /** The team the invite code opens; a code that opens none counts as a failed attempt. */
  teamOfInvite(c: Context, code: unknown): number | null;
};
