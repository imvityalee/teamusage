import type { Db } from "./db.js";
import { baseline } from "./migrations/baseline.js";
import { teamKeys } from "./migrations/team-keys.js";
import { orderedUsageIndexes } from "./migrations/usage-indexes.js";

/** One numbered upgrade of the database; step N moves it from version N - 1 to N. */
export type Step = (db: Db) => void;

/** The database was written by a release newer than this one. */
export class NewerSchemaError extends Error {
  constructor() {
    super("the database was written by a newer teamusage");
    this.name = "NewerSchemaError";
  }
}

const BASELINE = 1;

export const STEPS: readonly Step[] = [baseline, teamKeys, orderedUsageIndexes];

export const SCHEMA_VERSION = STEPS.length;

function readVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function assertNoDanglingReferences(db: Db): void {
  if ((db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("the upgrade left a row that refers to a missing row");
}

/** Runs the step unless the database is already at its number; the version is read in the transaction that acts on it. */
function applyStep(db: Db, step: Step, number: number): void {
  db.transaction(() => {
    if (readVersion(db) >= number) return;
    step(db);
    // A database from before versioned upgrades may hold rows whose owner is gone; the baseline takes it as it is.
    if (number !== BASELINE) assertNoDanglingReferences(db);
    db.pragma(`user_version = ${number}`);
  }).immediate();
}

export function runSteps(db: Db, steps: readonly Step[]): void {
  if (readVersion(db) > steps.length) throw new NewerSchemaError();
  // SQLite ignores this pragma inside a transaction, so it is switched around the steps' transactions.
  db.pragma("foreign_keys = OFF");
  try {
    steps.forEach((step, index) => applyStep(db, step, index + 1));
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function migrate(db: Db): void {
  runSteps(db, STEPS);
}
