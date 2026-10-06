/**
 * p4-score-drift.mjs — P4 (scoring) probe: do current reports still agree with YOUR frozen corrections?
 *
 * Reads data/eval/golden-user.jsonl (written only by `node eval-pipeline.mjs label ...`, an explicit
 * user action) and compares each label to the current report's header (`**Archetype:**`, `**Score:**`).
 * It never re-scores: no LLM calls, no network. Live re-scoring stays `eval-golden.mjs --live`.
 *
 *   userGoldenN          label lines read (malformed lines skipped)
 *   archetypeAgreement   share of comparable labels whose archetype matches the report's (0..1, 3 dp)
 *   meanAbsScoreDelta    mean |labelled score - report score| over comparable labels (2 dp)
 *   driftVsLastRun       meanAbsScoreDelta minus the previous p4 row's value in data/eval/runs.tsv
 *                        (positive = reports drifting further from your labels); null with no prior value
 *
 * "Comparable" = the label's report number resolves to a reports/{###}-*.md file. Labels with no report
 * are listed as a finding and excluded from every rate.
 * Verdict (higher is better) on archetypeAgreement via verdict(): < WARN_BELOW warn, < FAIL_BELOW fail,
 * fewer than SAMPLE_FLOOR labels -> insufficient-data ("(n too small)" in metrics). Read-only.
 */

import { join } from 'path';
import { SAMPLE_FLOOR, verdict } from './verdict.mjs';
import { readGoldenUser, readReports, readTsv } from './_data.mjs';

export const AGREEMENT_WARN_BELOW = 0.8;   // archetype agreement < 80% -> warn
export const AGREEMENT_FAIL_BELOW = 0.6;   // < 60% -> fail
export const SCORE_DELTA_WARN_ABOVE = 1.0;  // mean |score delta| > 1.0 downgrades pass -> warn

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Same archetype: equal after normalisation, or one contains the other (reports may append qualifiers). */
export function archetypeMatches(a, b) {
  const x = norm(a); const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function lastP4MeanDelta(root) {
  const rows = readTsv(join(root, 'data', 'eval', 'runs.tsv')).filter((r) => r.phase === 'p4');
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(rows[i].metrics_json || '{}').meanAbsScoreDelta;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    } catch { /* ignore malformed metrics_json */ }
  }
  return null;
}

export default async function probe({ root }) {
  const labels = readGoldenUser(root);
  const byNum = new Map(readReports(root).map((r) => [Number(r.num), r]));
  const n = labels.length;

  const comparable = [];
  const orphans = [];
  for (const l of labels) {
    const rep = byNum.get(Number(l.report));
    if (rep) comparable.push({ label: l, rep });
    else orphans.push(String(l.report));
  }

  const matches = comparable.filter(({ label, rep }) => archetypeMatches(label.archetype, rep.archetype));
  const mismatches = comparable.filter((c) => !matches.includes(c))
    .map(({ label, rep }) => ({ report: String(label.report).padStart(3, '0'), labeled: label.archetype, current: rep.archetype }));
  const deltas = comparable
    .filter(({ label, rep }) => Number.isFinite(Number(label.score)) && Number.isFinite(rep.score))
    .map(({ label, rep }) => Math.abs(Number(label.score) - rep.score));

  const tooSmall = n < SAMPLE_FLOOR || comparable.length < SAMPLE_FLOOR;
  const agreement = comparable.length ? matches.length / comparable.length : NaN;
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : NaN;
  const prev = lastP4MeanDelta(root);
  const drift = !tooSmall && Number.isFinite(meanDelta) && prev !== null ? round(meanDelta - prev, 2) : null;

  const findings = [];
  if (n === 0) findings.push('no user-labelled golden set yet: add one with `node eval-pipeline.mjs label <report#> --score X --archetype Y`');
  else if (tooSmall) findings.push(`golden-user set too small for a verdict (${comparable.length} comparable of ${n} labels, need ${SAMPLE_FLOOR})`);
  else findings.push(`archetype agreement ${matches.length}/${comparable.length}; mean |score delta| ${round(meanDelta, 2)}`);
  for (const o of orphans) findings.push(`label ${o.padStart(3, '0')}: no report file found, excluded`);
  for (const m of mismatches.slice(0, 5)) findings.push(`report ${m.report}: you labelled "${m.labeled}", report says "${m.current || '(none)'}"`);

  let v = verdict({
    value: agreement, n: comparable.length, warnBelow: AGREEMENT_WARN_BELOW, failBelow: AGREEMENT_FAIL_BELOW,
  });
  if (v === 'pass' && Number.isFinite(meanDelta) && meanDelta > SCORE_DELTA_WARN_ABOVE) {
    v = 'warn';
    findings.push(`archetypes agree but scores drifted: mean |score delta| ${round(meanDelta, 2)} > ${SCORE_DELTA_WARN_ABOVE}`);
  }

  return {
    phase: 'p4',
    verdict: v,
    metrics: {
      userGoldenN: n,
      archetypeAgreement: tooSmall ? '(n too small)' : round(agreement, 3),
      meanAbsScoreDelta: tooSmall || !Number.isFinite(meanDelta) ? '(n too small)' : round(meanDelta, 2),
      driftVsLastRun: drift,
    },
    findings,
    detail: { comparable: comparable.length, orphans, mismatches },
  };
}
