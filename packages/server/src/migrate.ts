import type { Db } from "./db.js";
import { baseline } from "./migrations/baseline.js";
import { hostedTeams } from "./migrations/hosted.js";
import { teamKeys } from "./migrations/team-keys.js";
import { usageCountsTable } from "./migrations/usage-counts.js";
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

/** An upgrade step failed and was rolled back; `cause` is what it threw. */
export class UpgradeFailedError extends Error {
  constructor(readonly step: number, cause: unknown) {
    super(`upgrade step ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "UpgradeFailedError";
  }
}

const BASELINE = 1;

export const STEPS: readonly Step[] = [baseline, teamKeys, orderedUsageIndexes, hostedTeams, usageCountsTable];

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
    steps.forEach((step, index) => {
      try {
        applyStep(db, step, index + 1);
      } catch (err) {
        throw new UpgradeFailedError(index + 1, err);
      }
    });
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function migrate(db: Db): void {
  runSteps(db, STEPS);
}
