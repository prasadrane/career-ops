import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'eval-pipeline.mjs');

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'eval-pipeline-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  return root;
}
function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8' });
}

test('--json on empty tracker: exit 0, six phases, all insufficient-data', () => {
  const root = mkRoot();
  try {
    const r = run(root, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(Array.isArray(j.phases));
    assert.deepEqual(j.phases.map((p) => p.phase), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    for (const p of j.phases) assert.equal(p.verdict, 'insufficient-data');
    assert.equal(j.overall, 'insufficient-data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--phase subset and runs.tsv recording', () => {
  const root = mkRoot();
  try {
    const r = run(root, ['--json', '--phase', 'p1,p3']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).phases.map((p) => p.phase), ['p1', 'p3']);
    const lines = readFileSync(join(root, 'data', 'eval', 'runs.tsv'), 'utf-8').trim().split('\n');
    assert.equal(lines[0], 'timestamp\tphase\tverdict\tmetrics_json');
    assert.equal(lines.length, 3);
    assert.match(lines[1], /\tp1\tinsufficient-data\t/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--no-record writes nothing', () => {
  const root = mkRoot();
  try {
    assert.equal(run(root, ['--json', '--no-record']).status, 0);
    assert.equal(existsSync(join(root, 'data', 'eval')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--summary prints a table; bad flags/values exit 1', () => {
  const root = mkRoot();
  try {
    const r = run(root, ['--summary', '--no-record']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /p1/);
    assert.match(r.stdout, /insufficient-data/);
    assert.equal(run(root, ['--bogus']).status, 1);
    assert.equal(run(root, ['--phase', 'p9']).status, 1);
    assert.equal(run(root, ['--since', 'abc']).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { runProbes } from '../eval-pipeline.mjs';
import { rollup } from '../lib/eval/verdict.mjs';

function probeDir(files) {
  const d = mkdtempSync(join(tmpdir(), 'eval-probes-'));
  for (const [n, body] of Object.entries(files)) writeFileSync(join(d, n), body);
  return d;
}
const OK = "export default async () => ({phase:'p1',verdict:'pass',metrics:{x:1},findings:[]});";
const BOOM = "export default async () => { throw new Error('kaboom'); };";

test('throwing probe makes its phase fail and rollup fail; healthy probe still reports', async () => {
  const d = probeDir({ 'p1-ok.mjs': OK, 'p2-boom.mjs': BOOM });
  try {
    const { phases, unattributed } = await runProbes({ root: d, since: new Date() }, ['p1', 'p2', 'p3'], d);
    assert.equal(phases[0].verdict, 'pass');
    assert.equal(phases[1].verdict, 'fail');
    assert.match(phases[1].findings[0], /probe p2-boom\.mjs failed: kaboom/);
    assert.equal(phases[2].verdict, 'insufficient-data');
    assert.equal(unattributed.length, 0);
    assert.equal(rollup(phases), 'fail');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('unprefixed throwing probe exits 1 with stderr, others still printed', () => {
  const d = probeDir({ 'p1-ok.mjs': OK, 'boom.mjs': BOOM });
  const root = mkRoot();
  try {
    const r = spawnSync(process.execPath, [CLI, '--json', '--no-record'],
      { env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_EVAL_PROBE_DIR: d }, encoding: 'utf-8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /eval-pipeline: probe boom\.mjs failed: kaboom/);
    assert.equal(JSON.parse(r.stdout).phases[0].verdict, 'pass');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
