#!/usr/bin/env node
// eval-pipeline.mjs — pipeline scorecard: one verdict per phase (p1..p6).
//
//   node eval-pipeline.mjs [--phase p1,p3] [--json|--summary] [--since 30d] [--no-record]
//
// Probes are discovered by scanning lib/eval/*.mjs (excluding verdict.mjs and
// files starting with `_`); each default-exports
//   async probe({ root, since }) => { phase, verdict, metrics, findings }
// and is named lib/eval/<phase>-<name>.mjs. The phase id comes from the
// returned `phase`. A phase with no probe reports `insufficient-data` with the
// finding "probe not installed". A probe that throws reports
// `insufficient-data` with the error as a finding (the scorecard never crashes).
// Every run appends one row per phase to {DATA_ROOT}/data/eval/runs.tsv
// (header `timestamp\tphase\tverdict\tmetrics_json`) unless --no-record.
// Exit codes: 0 ok (verdicts are advisory), 1 usage error.

import { existsSync, mkdirSync, readdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { rollup } from './lib/eval/verdict.mjs';

export const PHASES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const DEFAULT_SINCE_DAYS = 30;
const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'eval');
const USAGE = 'usage: node eval-pipeline.mjs [--phase p1,p3] [--json|--summary] [--since 30d] [--no-record]';
const RUNS_HEADER = 'timestamp\tphase\tverdict\tmetrics_json\n';

/** "30d" or "30" -> days (positive integer) or null. */
export function parseSince(raw) {
  const m = /^(\d+)d?$/.exec(String(raw ?? `${DEFAULT_SINCE_DAYS}d`));
  if (!m || Number(m[1]) < 1) return null;
  return Number(m[1]);
}

export function probeFiles(dir = EVAL_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && f !== 'verdict.mjs' && !f.startsWith('_'))
    .sort();
}

async function runProbes(ctx, wanted) {
  const byPhase = new Map();
  for (const f of probeFiles()) {
    const m = /^(p[1-6])-/.exec(f);
    try {
      const mod = await import(pathToFileURL(join(EVAL_DIR, f)).href);
      const res = await mod.default(ctx);
      const phase = res?.phase ?? m?.[1];
      if (!PHASES.includes(phase)) throw new Error(`probe ${f} returned unknown phase "${phase}"`);
      byPhase.set(phase, { metrics: {}, findings: [], ...res, phase });
    } catch (err) {
      const phase = m?.[1];
      if (phase) {
        byPhase.set(phase, { phase, verdict: 'insufficient-data', metrics: {}, findings: [`probe ${f} failed: ${err.message}`] });
      }
    }
  }
  return wanted.map((phase) => byPhase.get(phase)
    ?? { phase, verdict: 'insufficient-data', metrics: {}, findings: ['probe not installed'] });
}

function record(root, timestamp, phases) {
  const dir = join(root, 'data', 'eval');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'runs.tsv');
  if (!existsSync(file)) writeFileSync(file, RUNS_HEADER);
  const clean = (s) => String(s).replace(/[\t\r\n]/g, ' ');
  appendFileSync(file, phases
    .map((p) => `${timestamp}\t${p.phase}\t${p.verdict}\t${clean(JSON.stringify(p.metrics ?? {}))}\n`).join(''));
}

function renderSummary(result) {
  const lines = [`Pipeline scorecard (since ${result.since.slice(0, 10)})`, ''];
  for (const p of result.phases) {
    lines.push(`${p.phase}  ${p.verdict.padEnd(17)} ${Object.entries(p.metrics ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const f of p.findings ?? []) lines.push(`      - ${f}`);
  }
  lines.push('', `overall: ${result.overall}`);
  return lines.join('\n');
}

export async function main(argv) {
  validateFlags(argv, ['--phase', '--json', '--summary', '--since', '--no-record', '--help'], USAGE,
    { valueFlags: ['--phase', '--since'], requireOperand: true });

  const days = parseSince(flagValue(argv, '--since'));
  if (days === null) { console.error(`eval-pipeline: invalid --since (use Nd, e.g. 30d)\n${USAGE}`); return 1; }

  let wanted = PHASES;
  const phaseArg = flagValue(argv, '--phase');
  if (phaseArg !== undefined) {
    wanted = phaseArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = wanted.filter((p) => !PHASES.includes(p));
    if (!wanted.length || bad.length) {
      console.error(`eval-pipeline: unknown phase ${bad.join(',') || '(empty)'} (valid: ${PHASES.join(',')})`);
      return 1;
    }
    wanted = PHASES.filter((p) => wanted.includes(p));
  }

  const root = getCareerOpsRoot();
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const phases = await runProbes({ root, since }, wanted);
  const result = { generated: now.toISOString(), since: since.toISOString(), phases, overall: rollup(phases) };

  if (!hasFlag(argv, '--no-record')) record(root, result.generated, phases);

  console.log(hasFlag(argv, '--json') ? JSON.stringify(result, null, 2) : renderSummary(result));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
