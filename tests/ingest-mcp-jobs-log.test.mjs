// tests/ingest-mcp-jobs.test.mjs - deterministic MCP result ingester (ingest-mcp-jobs.mjs).
//
// End-to-end: each check spawns the real CLI against a temp data root
// (CAREER_OPS_ROOT), because scan.mjs resolves its paths at module load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'ingest-mcp-jobs.mjs');
const FIX = join(ROOT, 'tests', 'fixtures', 'mcp');
const RUN = 'run-1';

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function sandbox({ portals, blacklist, profile, tracker } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ingest-mcp-'));
  mkdirSync(join(root, 'data', 'mcp-raw', RUN), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), tracker ?? TRACKER);
  if (portals !== undefined) writeFileSync(join(root, 'portals.yml'), portals);
  if (blacklist !== undefined) writeFileSync(join(root, 'data', 'blacklist.md'), blacklist);
  if (profile !== undefined) { mkdirSync(join(root, 'config'), { recursive: true }); writeFileSync(join(root, 'config', 'profile.yml'), profile); }
  return { root, raw: join(root, 'data', 'mcp-raw', RUN), done: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function envFor(root) {
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  for (const k of ['CAREER_OPS_DATA_DIR', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_PORTALS', 'CAREER_OPS_PROFILE', 'CAREER_OPS_TRACKER']) delete env[k];
  return env;
}

function ingest(root, args = ['--run', RUN]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: envFor(root), encoding: 'utf-8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

const put = (dir, name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
const read = (root, rel) => readFileSync(join(root, rel), 'utf-8');
const history = (root) => read(root, 'data/scan-history.tsv').split('\n').filter(Boolean).map((l) => l.split('\t'));
const sha = (root, rel) => createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');

const ACME = (url, extra = {}) => ({ title: 'Applied AI Engineer', company: 'Acme AI', url, location: 'Remote, US', posted_at: '2026-09-28', ...extra });

const tsvRows = (root, rel) => {
  const lines = read(root, rel).split('\n').filter(Boolean).map((l) => l.split('\t'));
  const [header, ...rest] = lines;
  return rest.map((c) => Object.fromEntries(header.map((h, i) => [h, c[i]])));
};

test('MCP freshness signals land in scan-history trust_flags as ghost:<score> and last_verified:<date>', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [
      ACME('https://boards.greenhouse.io/acmeai/jobs/4001', { ghost_score: 12, last_verified: '2026-10-03' }),
      { title: 'Applied AI Engineer', company: 'Plain Co', url: 'https://boards.greenhouse.io/plain/jobs/1', location: 'Remote, US' },
    ] });
    assert.equal(ingest(sb.root).code, 0);
    const rows = history(sb.root);
    const acme = rows.find((r) => r[0].includes('acmeai'));
    assert.match(acme[10], /ghost:12/);
    assert.match(acme[10], /last_verified:2026-10-03/);
    const plain = rows.find((r) => r[0].includes('/plain/'));
    assert.doesNotMatch(plain[10] ?? '', /ghost|last_verified/);
  } finally { sb.done(); }
});

test('mcp-ingest.tsv: per-server row with seen/added, plus an error row per errored file', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    put(sb.raw, 'jobdatalake-q1.json', '{ not json');
    put(sb.raw, 'foundrole-q1.json', { server: 'foundrole', query_id: 'q1', rows: [] });
    const dry = ingest(sb.root, ['--run', RUN, '--dry-run']);
    assert.equal(dry.code, 0);
    assert.equal(existsSync(join(sb.root, 'data', 'eval', 'mcp-ingest.tsv')), false, '--dry-run writes nothing');
    assert.equal(ingest(sb.root).code, 0);
    const rows = tsvRows(sb.root, 'data/eval/mcp-ingest.tsv');
    const jp = rows.find((r) => r.server === 'jobspipe' && !r.error_reason);
    assert.equal(jp.run_id, RUN);
    assert.equal(jp.seen, '1');
    assert.equal(jp.added, '1');
    assert.ok(rows.some((r) => r.server === 'jobdatalake' && r.error_reason === 'malformed-json'));
    assert.ok(rows.some((r) => r.server === 'foundrole' && r.error_reason === 'empty'));
  } finally { sb.done(); }
});

test('mcp-ingest.tsv: MCP rows duplicating an existing (ATS) posting count in dupes_existing per server', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    assert.equal(ingest(sb.root).code, 0);
    // second run (new run id) returns the same posting: now an existing dupe
    const run2 = join(sb.root, 'data', 'mcp-raw', 'run-2');
    mkdirSync(run2, { recursive: true });
    put(run2, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    assert.equal(ingest(sb.root, ['--run', 'run-2']).code, 0);
    const last = tsvRows(sb.root, 'data/eval/mcp-ingest.tsv').filter((r) => r.run_id === 'run-2' && r.server === 'jobspipe');
    assert.equal(last[0].dupes_existing, '1');
    assert.equal(last[0].added, '0');
  } finally { sb.done(); }
});

test('scan-runs status: all-empty files complete; malformed-only files fail', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [] });
    assert.equal(ingest(sb.root).code, 0);
    const a = read(sb.root, 'data/scan-runs.tsv');
    assert.match(a, /completed/);
    assert.doesNotMatch(a, /failed/);
    const run2 = join(sb.root, 'data', 'mcp-raw', 'run-2');
    mkdirSync(run2, { recursive: true });
    put(run2, 'jobspipe-q1.json', '{ nope');
    assert.equal(ingest(sb.root, ['--run', 'run-2']).code, 0);
    assert.match(read(sb.root, 'data/scan-runs.tsv'), /failed/);
  } finally { sb.done(); }
});


test('mcp-ingest.tsv: `files` counts only non-error files (errored files get their own error row)', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    put(sb.raw, 'jobspipe-q2.json', '{ broken');
    assert.equal(ingest(sb.root).code, 0);
    const rows = tsvRows(sb.root, 'data/eval/mcp-ingest.tsv').filter((r) => r.server === 'jobspipe');
    assert.equal(rows.find((r) => !r.error_reason).files, '1');
    assert.equal(rows.filter((r) => r.error_reason).length, 1);
  } finally { sb.done(); }
});

test('mcp-ingest.tsv is bounded: above 3000 rows it is trimmed to the newest 2000 (+ header)', () => {
  const sb = sandbox();
  try {
    mkdirSync(join(sb.root, 'data', 'eval'), { recursive: true });
    const header = 'timestamp\trun_id\tserver\tfiles\tseen\tadded\tdupes_existing\tunconfirmed\terror_reason';
    const old = Array.from({ length: 3005 }, (_, i) => `2026-01-01T00:00:00Z\told-${i}\tjobspipe\t1\t1\t0\t0\t0\t`);
    writeFileSync(join(sb.root, 'data', 'eval', 'mcp-ingest.tsv'), `${header}\n${old.join('\n')}\n`);
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    assert.equal(ingest(sb.root).code, 0);
    const lines = read(sb.root, 'data/eval/mcp-ingest.tsv').split('\n').filter(Boolean);
    assert.equal(lines[0], header);
    assert.equal(lines.length, 2001);
    assert.match(lines.at(-1), new RegExp(`\t${RUN}\tjobspipe\t`));
    assert.ok(!lines.some((l) => l.includes('\told-0\t')), 'oldest rows dropped');
  } finally { sb.done(); }
});
