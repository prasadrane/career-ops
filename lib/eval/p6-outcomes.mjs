/**
 * p6-outcomes.mjs — P6 (outcomes) probe: do the evaluation scores predict real outcomes?
 *
 * Wraps `node calibrate.mjs --json` (spawned against {root}; this probe computes nothing itself)
 * and maps calibrate's verdict kind to a scorecard verdict:
 *   separating   -> pass   (high-score bands reach interviews more often)
 *   flat         -> warn   (no separation yet)
 *   inverted     -> fail   (high-score bands convert WORSE)
 *   insufficient -> insufficient-data (also: no tracker, spawn failure, unparseable output)
 * Metrics: resolved, inFlight. Never throws; advisory only (calibrate never changes scoring).
 */

import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CALIBRATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'calibrate.mjs');
const VERDICTS = { separating: 'pass', flat: 'warn', inverted: 'fail', insufficient: 'insufficient-data' };

export default async function probe({ root }) {
  const insufficient = (finding) => ({
    phase: 'p6', verdict: 'insufficient-data', metrics: { resolved: 0, inFlight: 0 }, findings: [finding],
  });
  try {
    const r = spawnSync(process.execPath, [CALIBRATE, '--json'], {
      env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8', timeout: 30_000,
    });
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = null; }
    if (!out || typeof out !== 'object') {
      const why = String(r.stdout || r.stderr || r.error?.message || 'no output').trim().split('\n')[0].slice(0, 200);
      return insufficient(`calibrate produced no result: ${why}`);
    }
    const kind = out.verdict?.kind;
    const verdict = Object.hasOwn(VERDICTS, kind) ? VERDICTS[kind] : 'insufficient-data';
    return {
      phase: 'p6',
      verdict,
      metrics: { resolved: out.resolved ?? 0, inFlight: out.inFlight ?? 0 },
      findings: [String(out.verdict?.text ?? 'calibrate returned no verdict text')],
      detail: { bands: out.bands ?? [] },
    };
  } catch (err) {
    return insufficient(`calibrate could not run: ${err.message}`);
  }
}
