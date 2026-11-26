import type { AppOptions } from "./app-context.js";
import { storageGuard, type DiskSpace } from "./storage-guard.js";
import { HOSTED_CAPS, UPLOADS_PER_MINUTE } from "./team-limits.js";

export type HostedLimits = NonNullable<AppOptions["limits"]>;

/**
 * What a hosted server's teams may hold and how often a machine may upload. Nothing that adds a row is accepted while
 * the volume holding `dataDir` is nearly full; `measure` replaces the real measurement of that volume.
 */
export function hostedLimits(dataDir: string, measure?: (dir: string) => DiskSpace): HostedLimits {
  return {
    team: { ...HOSTED_CAPS, storageLow: storageGuard({ dir: dataDir, measure }) },
    uploadsPerMinute: UPLOADS_PER_MINUTE,
  };
}
