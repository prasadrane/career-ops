// tests/verify-pipeline-eval-stale.test.mjs — soft check: eval scorecard stale > 14 days.
// Opt-in: no data/eval/runs.tsv -> silent. Warning only, never an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = 'timestamp\tphase\tverdict\tmetrics_json\n';
const DAY = 86_400_000;

function run(runsTsv) {
  const dir = mkdtempSync(join(tmpdir(), 'vp-eval-stale-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'reports'), { recursive: true });
    const tracker = join(dir, 'data', 'applications.md');
    writeFileSync(tracker, '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    if (runsTsv !== null) {
      mkdirSync(join(dir, 'data', 'eval'), { recursive: true });
      writeFileSync(join(dir, 'data', 'eval', 'runs.tsv'), runsTsv);
    }
    const env = { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: join(dir, 'reports'),
      CAREER_OPS_PORTALS: join(dir, 'portals.yml') };
    const r = spawnSync(process.execPath, [join(ROOT, 'verify-pipeline.mjs')], { cwd: ROOT, env, encoding: 'utf-8', timeout: 60_000 });
    return { out: r.stdout ?? '', code: r.status };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

test('newest scorecard row 20 days old -> warning mentioning eval-pipeline, exit code unchanged', () => {
  const r = run(HEADER + `${iso(30)}\tp1\tpass\t{}\n${iso(20)}\tp1\tpass\t{}\n`);
  assert.match(r.out, /⚠️.*eval-pipeline/);
  assert.match(r.out, /20 days/);
  assert.equal(r.code, 0);
});

test('fresh scorecard -> no eval warning', () => {
  const r = run(HEADER + `${iso(2)}\tp1\tpass\t{}\n`);
  assert.doesNotMatch(r.out, /eval-pipeline/);
});

test('no runs.tsv -> no eval warning (opt-in)', () => {
  const r = run(null);
  assert.doesNotMatch(r.out, /eval-pipeline/);
});
