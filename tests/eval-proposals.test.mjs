import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProposals, writeProposals } from '../lib/eval/proposals.mjs';

const CLI = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'eval-pipeline.mjs');
const mkRoot = () => mkdtempSync(join(tmpdir(), 'eval-prop-'));
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const PROTECTED = ['portals.yml', 'config/profile.yml', 'modes/_profile.md', 'cv.md', 'modes/_shared.md'];

const PHASES = [
  { phase: 'p1', verdict: 'warn', metrics: {}, findings: [], detail: { sources: [
    { id: 'mcp-foundrole', seen: 40, added: 3, addedLast3Runs: 0, everSeen: 40 },
    { id: 'greenhouse', seen: 40, added: 9, addedLast3Runs: 4, everSeen: 40 },
  ] } },
  { phase: 'p2', verdict: 'pass', metrics: {}, findings: [], detail: { recallSample: [
    { title: 'Staff Platform Engineer', company: 'Acme', reason: 'shares platform, engineer with "Platform Engineer"' },
  ] } },
  { phase: 'p4', verdict: 'warn', metrics: { archetypeAgreement: 0.625 }, findings: [], detail: { mismatches: [
    { report: '064', labeled: 'AI Platform', current: 'Data Eng' },
  ] } },
  { phase: 'p5', verdict: 'fail', metrics: { coverageDelta: -10 }, findings: [], detail: { artifacts: [
    { report: '012', lowered: [{ keyword: 'Airflow', bullet: 'Scheduled Airflow DAGs' }] },
  ] } },
];

test('buildProposals: each item cites a metric and evidence', () => {
  const items = buildProposals(PHASES);
  const text = items.map((i) => i.text).join('\n');
  assert.match(text, /mcp-foundrole: 0 adds in last 3 runs.*consider disabling/);
  assert.doesNotMatch(text, /greenhouse.*consider disabling/);
  assert.match(text, /Staff Platform Engineer.*consider adding keyword "platform"/);
  assert.match(text, /Airflow.*Scheduled Airflow DAGs/);
  assert.match(text, /064/);
  for (const i of items) { assert.ok(i.metric); assert.ok(i.evidence); }
});

test('buildProposals: empty / insufficient phases -> no items, no throw', () => {
  assert.deepEqual(buildProposals([]), []);
  assert.deepEqual(buildProposals(undefined), []);
  assert.deepEqual(buildProposals([{ phase: 'p1', verdict: 'insufficient-data', metrics: {}, findings: [] }]), []);
});

test('writeProposals writes only data/eval/proposals.md; protected files byte-identical', () => {
  const root = mkRoot();
  try {
    for (const f of PROTECTED) w(root, f, `content of ${f}\n`);
    const before = Object.fromEntries(PROTECTED.map((f) => [f, sha(join(root, f))]));
    const out = writeProposals(root, PHASES, '2026-10-05T00:00:00Z');
    assert.equal(out, join(root, 'data', 'eval', 'proposals.md'));
    const md = readFileSync(out, 'utf-8');
    assert.match(md, /suggest-only/i);
    assert.match(md, /consider disabling/);
    for (const f of PROTECTED) assert.equal(sha(join(root, f)), before[f], `${f} changed`);
    assert.deepEqual(readdirSync(join(root, 'data')).sort(), ['eval']);
    assert.deepEqual(readdirSync(join(root, 'data', 'eval')), ['proposals.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: --propose writes proposals.md and leaves protected files unchanged; default writes none', () => {
  const root = mkRoot();
  try {
    for (const f of PROTECTED) w(root, f, `content of ${f}\n`);
    w(root, 'data/applications.md', '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    const before = Object.fromEntries(PROTECTED.map((f) => [f, sha(join(root, f))]));
    const env = { ...process.env, CAREER_OPS_ROOT: root };
    let r = spawnSync(process.execPath, [CLI, '--json'], { env, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(root, 'data', 'eval', 'proposals.md')), false);
    r = spawnSync(process.execPath, [CLI, '--json', '--propose'], { env, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(root, 'data', 'eval', 'proposals.md')), true);
    JSON.parse(r.stdout);   // proposals notice must not pollute --json stdout
    for (const f of PROTECTED) assert.equal(sha(join(root, f)), before[f], `${f} changed`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
