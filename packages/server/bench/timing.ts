const RUNS = 20;

export type Timing = { median: number; slowest: number };

/** Times `runs` calls of `run` (an even number, at least two). */
export function timeEach(runs: number, run: () => unknown): Timing {
  const ms = Array.from({ length: runs }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  const middle = runs / 2;
  return { median: (ms[middle - 1]! + ms[middle]!) / 2, slowest: ms[runs - 1]! };
}

/** Times `RUNS` calls of `run` after one untimed call, which pays for a cold page cache and statement planning. */
export function timeRuns(run: () => unknown): Timing {
  run();
  return timeEach(RUNS, run);
}

/** `label: median … ms, slowest … ms`. */
export const line = (label: string, t: Timing) => `${label}: median ${t.median.toFixed(1)} ms, slowest ${t.slowest.toFixed(1)} ms`;

/** `label: whole … ms, … slices, slowest slice … ms`, for a removal whose slices took `slices` ms each and whose last step took `last` ms. */
export function removalLine(label: string, slices: number[], last: number): string {
  const whole = slices.reduce((sum, ms) => sum + ms, last);
  return `${label}: whole ${whole.toFixed(1)} ms, ${slices.length} slices, slowest slice ${Math.max(...slices).toFixed(1)} ms`;
}
