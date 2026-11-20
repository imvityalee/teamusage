/**
 * An error whose message is fixed text written by this client (at most with a cleaned, truncated server message), so it
 * is safe to print, log and show in Codex. It never holds tokens, invite codes, paths or file contents.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A command line this client cannot use; the CLI exits with 2. */
export class UsageError extends UserError {}

const SETUP_HINT = "run `teamusage setup`";

/** Every SyncError message. The plugins' skills explain each one to the user; skills.test.ts checks they all do. */
export const SYNC_ERRORS = {
  notSetUp: `teamusage is not set up; ${SETUP_HINT}`,
  tokenUnbound: `this machine's token is not bound to a server and email, so nothing was sent; ${SETUP_HINT}`,
  identityChanged: `the server URL or email changed since this machine registered, so nothing was sent; ${SETUP_HINT} to confirm`,
  noToken: `this machine has no token; ${SETUP_HINT}`,
  tokenRejected: `the server rejected this machine's token; ${SETUP_HINT}`,
  inviteRefused: `the server refused the invite code; ${SETUP_HINT}`,
  lock: "could not create the sync lock",
} as const;

export type SyncErrorReason = keyof typeof SYNC_ERRORS;

export class SyncError extends UserError {
  readonly reason: SyncErrorReason;
  constructor(reason: SyncErrorReason) {
    super(SYNC_ERRORS[reason]);
    this.reason = reason;
  }

  /** A setup or token problem the user can fix (everything but the sync lock); these get a Codex notice. */
  get setupProblem(): boolean {
    return this.reason !== "lock";
  }
}

/** Safe to show or log: a UserError's own message; anything else is reduced to its error code. */
export function errorMessage(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? `unexpected error (${code})` : "unexpected error";
}
