import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordDroppedTitle, MAX_LINES, KEEP_LINES } from '../lib/eval/_dropped-titles.mjs';
import { readDroppedTitles } from '../lib/eval/_data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.CAREER_OPS_PROFILE;
delete process.env.CAREER_OPS_NO_EVAL_LOG;

function mkRoot(profileRoles = ['AI Solutions Architect']) {
  const root = mkdtempSync(join(tmpdir(), 'eval-dropped-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), `target_roles:\n  primary:\n${profileRoles.map((r) => `    - "${r}"\n`).join('')}`);
  return root;
}
const log = (root) => join(root, 'data', 'eval', 'dropped-titles.tsv');
const entry = (root, title, extra = {}) => ({ root, title, company: 'Acme', portal: 'greenhouse', url: `https://x.com/${encodeURIComponent(title)}`, date: '2026-09-05', ...extra });

test('title sharing a profile keyword is logged; unrelated title is not', async () => {
  const root = mkRoot();
  try {
    assert.equal(await recordDroppedTitle(entry(root, 'Principal AI Platform Lead')), true);
    assert.equal(await recordDroppedTitle(entry(root, 'Warehouse Associate')), false);
    const rows = readDroppedTitles(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].date, rows[0].portal, rows[0].company, rows[0].title], ['2026-09-05', 'greenhouse', 'Acme', 'Principal AI Platform Lead']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit profileKeywords and a titleFilter predicate (kept title -> not logged)', async () => {
  const root = mkRoot([]);
  try {
    assert.equal(await recordDroppedTitle(entry(root, 'Data Scientist'), { profileKeywords: [] }), false);
    assert.equal(await recordDroppedTitle(entry(root, 'Data Scientist'), { profileKeywords: ['Data Platform'] }), true);
    assert.equal(await recordDroppedTitle(entry(root, 'Data Analyst'), { profileKeywords: ['Data Platform'], titleFilter: () => true }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dedup on normalized url + title; fields are sanitized to one TSV row', async () => {
  const root = mkRoot();
  try {
    const e = entry(root, 'AI Lead', { url: 'https://x.com/1?utm_source=a' });
    assert.equal(await recordDroppedTitle(e), true);
    assert.equal(await recordDroppedTitle({ ...e, url: 'https://x.com/1' }), false);
    assert.equal(await recordDroppedTitle({ ...e, title: 'AI Lead 2', company: '=cmd\tx\ny' }), true);
    const lines = readFileSync(log(root), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.split('\t').length === 5));
    assert.match(lines[1], /\t'=cmd x y\t/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('file is bounded: over MAX_LINES trims to the newest KEEP_LINES', async () => {
  const root = mkRoot();
  try {
    mkdirSync(join(root, 'data', 'eval'), { recursive: true });
    const rows = Array.from({ length: MAX_LINES }, (_, i) => ['2026-09-01', 'p', 'Co', `AI Role ${i}`, `https://x.com/${i}`].join('\t'));
    writeFileSync(log(root), rows.join('\n') + '\n');
    assert.equal(await recordDroppedTitle(entry(root, 'AI Newest')), true);
    const lines = readFileSync(log(root), 'utf-8').trim().split('\n');
    assert.equal(lines.length, KEEP_LINES);
    assert.match(lines.at(-1), /AI Newest/);
    assert.match(lines[0], /AI Role 1001\t/);          // oldest kept = MAX_LINES - (KEEP_LINES - 1)
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failure never throws; CAREER_OPS_NO_EVAL_LOG=1 disables', async () => {
  const root = mkRoot();
  try {
    writeFileSync(join(root, 'data', 'eval'), 'i am a file, not a directory');   // mkdir data/eval will fail
    assert.equal(await recordDroppedTitle(entry(root, 'AI Lead')), false);
    rmSync(join(root, 'data', 'eval'));
    process.env.CAREER_OPS_NO_EVAL_LOG = '1';
    try { assert.equal(await recordDroppedTitle(entry(root, 'AI Lead')), false); } finally { delete process.env.CAREER_OPS_NO_EVAL_LOG; }
    assert.equal(existsSync(log(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scan.mjs: a filtered-out profile-keyword title lands in the log, an unrelated one does not', () => {
  const root = mkRoot(['Client Services Analyst']);
  try {
    writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    writeFileSync(join(root, 'data', 'pipeline.md'), '# Pipeline\n\n');
    const portals = join(root, 'portals.yml');
    writeFileSync(portals, 'title_filter:\n  positive:\n    - "Help Desk"\ntracked_companies:\n  - name: Fixture Board\n    careers_url: https://example.invalid/jobs\n    parser:\n      command: node\n      script: tests/fixtures/noc-board.mjs\n');
    const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_PORTALS: portals, CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml') };
    const run = spawnSync(process.execPath, [join(ROOT, 'scan.mjs')], { cwd: ROOT, env, encoding: 'utf-8' });
    assert.equal(run.status, 0, run.stderr);
    const titles = readDroppedTitles(root).map((r) => r.title);
    assert.deepEqual(titles, ['Analyst, Client Services']);       // Team Member / Guest Experience Associate unrelated
    // opt-out
    rmSync(join(root, 'data', 'eval'), { recursive: true, force: true });
    rmSync(join(root, 'data', 'scan-history.tsv'), { force: true });
    const off = spawnSync(process.execPath, [join(ROOT, 'scan.mjs')], { cwd: ROOT, env: { ...env, CAREER_OPS_NO_EVAL_LOG: '1' }, encoding: 'utf-8' });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(existsSync(log(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
