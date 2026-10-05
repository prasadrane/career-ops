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
