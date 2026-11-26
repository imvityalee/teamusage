import type { AppOptions } from "./app-context.js";
import type { Db } from "./db.js";
import { reusableBytes } from "./db-space.js";
import { storageGuard, type DiskSpace } from "./storage-guard.js";
import { HOSTED_CAPS, TEAM_STATS_MS_PER_MINUTE, TEAM_UPLOAD_RECORDS_PER_MINUTE, UPLOADS_PER_MINUTE } from "./team-limits.js";

export type HostedLimits = NonNullable<AppOptions["limits"]>;

/**
 * What a hosted server's teams may hold, how often a machine may upload and what a team may use a minute. Nothing
 * that adds a row is accepted while the volume holding `dataDir` is nearly full, counting the free pages of `db` as
 * free space; `measure` replaces the real measurement of that volume.
 */
export function hostedLimits(o: { dataDir: string; db: Db; measure?: (dir: string) => DiskSpace }): HostedLimits {
  return {
    team: { ...HOSTED_CAPS, storageLow: storageGuard({ dir: o.dataDir, measure: o.measure, reusable: () => reusableBytes(o.db) }) },
    uploadsPerMinute: UPLOADS_PER_MINUTE,
    teamUploadRecordsPerMinute: TEAM_UPLOAD_RECORDS_PER_MINUTE,
    teamStatsMsPerMinute: TEAM_STATS_MS_PER_MINUTE,
  };
}
