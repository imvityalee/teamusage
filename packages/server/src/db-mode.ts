import type { ServerConfig } from "./config.js";
import { getSetting, setSetting, type Db } from "./db.js";

const MODE = "mode";
const HOSTED = "hosted";

/** A self-hosted start found a database that a hosted server has marked as its own. */
export class HostedDatabaseError extends Error {
  constructor() {
    super("this database belongs to a hosted server");
    this.name = "HostedDatabaseError";
  }
}

/** A hosted start found a database that holds a self-hosted server's team. */
export class SelfHostedDatabaseError extends Error {
  constructor() {
    super("this database belongs to a self-hosted server");
    this.name = "SelfHostedDatabaseError";
  }
}

/** True when a hosted server has marked the database as its own. */
export function isHostedDatabase(db: Db): boolean {
  return getSetting(db, MODE) === HOSTED;
}

/**
 * Marks the database as a hosted server's. A database that holds a team without a code hash, which only a
 * self-hosted server creates, is left as it is and refused with SelfHostedDatabaseError.
 */
export function markHostedDatabase(db: Db): void {
  // Immediate: no other connection writes between the check and the mark.
  db.transaction(() => {
    if (db.prepare("select 1 from teams where code_hash is null limit 1").get() !== undefined) throw new SelfHostedDatabaseError();
    setSetting(db, MODE, HOSTED);
  }).immediate();
}

/** Before anything else is written: a hosted start marks the database, a self-hosted one refuses a marked one. */
export function claimDatabase(db: Db, mode: ServerConfig["mode"]): void {
  if (mode === "hosted") markHostedDatabase(db);
  else if (isHostedDatabase(db)) throw new HostedDatabaseError();
}
