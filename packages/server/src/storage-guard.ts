import { statfsSync } from "node:fs";
import { codeOf } from "./open-failure.js";

/** Below this share of free space the server stops accepting what adds rows. */
export const MIN_FREE_FRACTION = 0.15;

/** Free and total space of a volume, in the same unit. */
export type DiskSpace = { free: number; total: number };

type State = "room" | "full" | "unmeasurable";

/** The space of the volume that holds `dir`, as an unprivileged process may use it (statfs: bavail and blocks). */
export function diskSpace(dir: string): DiskSpace {
  const { bavail, blocks } = statfsSync(dir);
  return { free: bavail, total: blocks };
}

const isNearlyFull = ({ free, total }: DiskSpace): boolean => total > 0 && free / total < MIN_FREE_FRACTION;

/** The line for entering `state` from `previous`, or none when the answer did not change. */
function lineFor(state: State, previous: State, failure: string): string | undefined {
  if (state === previous) return undefined;
  if (state === "full") return `teamusage: less than ${MIN_FREE_FRACTION * 100}% of the data volume is free; requests that add rows are refused`;
  if (state === "unmeasurable") return `teamusage: could not measure the free space of the data volume${failure}; the disk guard is off`;
  return previous === "full" ? "teamusage: the data volume has room again; requests that add rows are accepted" : undefined;
}

/**
 * Whether the volume holding `dir` is nearly full, measured at each call. A volume that cannot be measured counts as
 * not full. `log` gets one line each time the answer changes.
 */
export function storageGuard(o: { dir: string; measure?: (dir: string) => DiskSpace; log?: (line: string) => void }): () => boolean {
  const measure = o.measure ?? diskSpace;
  const log = o.log ?? ((line: string) => console.error(line));
  let previous: State = "room";
  return () => {
    let state: State;
    let failure = "";
    try {
      state = isNearlyFull(measure(o.dir)) ? "full" : "room";
    } catch (err) {
      state = "unmeasurable";
      failure = codeOf(err);
    }
    const line = lineFor(state, previous, failure);
    if (line) log(line);
    previous = state;
    return state === "full";
  };
}
