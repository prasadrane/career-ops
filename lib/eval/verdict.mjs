/**
 * verdict.mjs — shared verdict helpers for the pipeline eval scorecard.
 *
 * Probe contract (every lib/eval/<phase>-<name>.mjs default-exports):
 *   async function probe({ root, since }) =>
 *     { phase: 'p1'..'p6', verdict, metrics: Record<string, number|string>, findings: string[] }
 * Thresholds are named constants at the top of each probe file.
 */

export const SAMPLE_FLOOR = 5;

const SEVERITY = { pass: 0, warn: 1, fail: 2 };

/**
 * Higher value is better. value >= warnBelow -> pass; >= failBelow -> warn; else fail.
 * Fewer than `floor` samples (or non-finite inputs) -> insufficient-data.
 * @returns {'pass'|'warn'|'fail'|'insufficient-data'}
 */
export function verdict({ value, n, warnBelow, failBelow, floor = SAMPLE_FLOOR }) {
  if (!Number.isFinite(value) || !Number.isFinite(n) || n < floor) return 'insufficient-data';
  if (value >= warnBelow) return 'pass';
  if (value >= failBelow) return 'warn';
  return 'fail';
}

/**
 * Worst verdict across phases, ignoring insufficient-data unless all are.
 * @param {{phase?:string, verdict:string}[]} phases
 * @returns {string}
 */
export function rollup(phases) {
  let worst = null;
  for (const p of phases ?? []) {
    if (!(p.verdict in SEVERITY)) continue;
    if (worst === null || SEVERITY[p.verdict] > SEVERITY[worst]) worst = p.verdict;
  }
  return worst ?? 'insufficient-data';
}
