import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'eval-pipeline.mjs');
const mkRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-label-'));
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'reports', '064-acme-2026-09-01.md'), '# E\n\n**Archetype:** X\n**Score:** 3.9/5\n');
  return root;
};
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8' });
const file = (root) => join(root, 'data', 'eval', 'golden-user.jsonl');
const lines = (root) => readFileSync(file(root), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

test('label writes one line with the documented shape; creates the dir', () => {
  const root = mkRoot();
  try {
    const r = run(root, ['label', '064', '--score', '4.1', '--archetype', 'AI Platform', '--note', 'too low']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(root), [{ report: '064', archetype: 'AI Platform', score: 4.1, label_source: 'user-correction', note: 'too low' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('label updates in place (one line per report#), unpadded number normalised; other lines kept', () => {
  const root = mkRoot();
  try {
    writeFileSync(join(root, 'reports', '007-beta-2026-09-01.md'), '# E\n');
    assert.equal(run(root, ['label', '64', '--score', '4', '--archetype', 'A']).status, 0);
    assert.equal(run(root, ['label', '7', '--score', '2', '--archetype', 'B']).status, 0);
    assert.equal(run(root, ['label', '064', '--score', '4.5', '--archetype', 'C']).status, 0);
    const l = lines(root);
    assert.equal(l.length, 2);
    assert.deepEqual(l.map((x) => [x.report, x.score, x.archetype]), [['064', 4.5, 'C'], ['007', 2, 'B']]);
    assert.deepEqual(readdirSync(join(root, 'data', 'eval')), ['golden-user.jsonl']);   // no temp leftovers
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validation: score outside 1..5, non-numeric, empty archetype, bad report# -> exit 1, nothing written', () => {
  const root = mkRoot();
  try {
    for (const args of [
      ['label', '064', '--score', '0.5', '--archetype', 'A'],
      ['label', '064', '--score', '5.5', '--archetype', 'A'],
      ['label', '064', '--score', 'abc', '--archetype', 'A'],
      ['label', '064', '--score', '4', '--archetype', '  '],
      ['label', '064', '--score', '4'],
      ['label', 'abc', '--score', '4', '--archetype', 'A'],
      ['label', '12345', '--score', '4', '--archetype', 'A'],
      ['label', '--score', '4', '--archetype', 'A'],
    ]) {
      const r = run(root, args);
      assert.equal(r.status, 1, args.join(' '));
      assert.ok(r.stderr.length > 0);
    }
    assert.equal(existsSync(file(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses when no report file exists for the number unless --force', () => {
  const root = mkRoot();
  try {
    let r = run(root, ['label', '099', '--score', '3', '--archetype', 'A']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /report/i);
    assert.equal(existsSync(file(root)), false);
    r = run(root, ['label', '099', '--score', '3', '--archetype', 'A', '--force']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(root)[0].report, '099');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('note is single-lined; existing flag validation unaffected', () => {
  const root = mkRoot();
  try {
    assert.equal(run(root, ['label', '064', '--score', '4', '--archetype', 'A', '--note', 'a\tb\nc']).status, 0);
    assert.equal(lines(root)[0].note, 'a b c');
    assert.equal(run(root, ['label', '064', '--bogus']).status, 1);
    assert.equal(run(root, ['--bogus']).status, 1);
    assert.equal(run(root, ['--json', '--phase', 'p4']).status, 0);
    assert.equal(run(root, ['label', '--help']).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
