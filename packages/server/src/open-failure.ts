import { NewerSchemaError, UpgradeFailedError } from "./migrate.js";

/** A self-hosted start found a database that a hosted server has created a team in. */
export class HostedDatabaseError extends Error {
  constructor() {
    super("this database belongs to a hosted server");
    this.name = "HostedDatabaseError";
  }
}

/** " (EADDRINUSE)" for an error with a string code; never the message, which can hold paths. */
export function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
}

/** The line printed when storage cannot be opened or is refused; it never includes the error's message, which can hold paths. */
export function openFailureMessage(err: unknown): string {
  if (err instanceof NewerSchemaError) return "teamusage: this database was written by a newer teamusage; upgrade the server";
  if (err instanceof HostedDatabaseError) return "teamusage: this database belongs to a hosted server; set TEAMUSAGE_MODE=hosted";
  if (err instanceof UpgradeFailedError) return `teamusage: upgrade step ${err.step} of the database failed and was rolled back${codeOf(err.cause)}`;
  return `teamusage: could not open the data directory or database${codeOf(err)}`;
}
