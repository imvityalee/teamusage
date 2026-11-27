import type { Stats } from "@teamusage/shared";
import { openDb, type Db } from "./db.js";
import { seedDemo } from "./demo.js";
import type { StatsRange } from "./stats-query.js";
import { getStats } from "./stats.js";
import { forTeam } from "./team-data.js";
import { createTeam } from "./teams.js";

export type DemoStats = { stats(range: StatsRange): Stats; memberExists(memberId: number): boolean };

type Seeded = { day: string; db: Db; teamId: number };

/**
 * The demo's numbers, from a database in memory that holds the seeded demo team and nothing else. It is made at the
 * first request and seeded again when the UTC day of `now()` changes, so the demo's last day is always today; the
 * database it replaces is closed. `openMemoryDb` is the database each seeding is made in.
 */
export function createDemoStats(now: () => number, openMemoryDb: () => Db = () => openDb(":memory:")): DemoStats {
  let seeded: Seeded | undefined;

  const current = (): Seeded => {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (seeded?.day === day) return seeded;
    seeded?.db.close();
    const db = openMemoryDb();
    const teamId = createTeam(db, "Demo");
    seedDemo(db, teamId, day);
    seeded = { day, db, teamId };
    return seeded;
  };

  return {
    stats: (range) => {
      const { db, teamId } = current();
      return getStats(db, teamId, range);
    },
    memberExists: (memberId) => {
      const { db, teamId } = current();
      return forTeam(db, teamId).memberExists(memberId);
    },
  };
}
