const RUNS = 20;

export type Timing = { median: number; slowest: number };

/** Times `RUNS` calls of `run` after one untimed call, which pays for a cold page cache and statement planning. */
export function timeRuns(run: () => unknown): Timing {
  run();
  const ms = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  const middle = RUNS / 2;
  return { median: (ms[middle - 1]! + ms[middle]!) / 2, slowest: ms[RUNS - 1]! };
}

/** `label: median … ms, slowest … ms`. */
export const line = (label: string, t: Timing) => `${label}: median ${t.median.toFixed(1)} ms, slowest ${t.slowest.toFixed(1)} ms`;
