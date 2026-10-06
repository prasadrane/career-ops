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

test('(c) same job from JobsPipe and JobDataLake (different URL spellings) -> added:1, both credited', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobdatalake-q1.json', { server: 'jobdatalake', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001/', { job_handle: 'h1' })] });
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', query_id: 'q1', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001?utm_source=jobspipe')] });

    const dry = ingest(sb.root, ['--run', RUN, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(dry.json.added, 1);
    assert.equal(dry.json.unconfirmed, 0);
    assert.equal(dry.json.dupes, 1);
    assert.equal(dry.json.seen, 2);
    assert.deepEqual(dry.json.errors, []);
    for (const f of ['data/scan-history.tsv', 'data/pipeline.md', 'data/scan-runs.tsv']) {
      assert.equal(existsSync(join(sb.root, f)), false, `--dry-run must not create ${f}`);
    }

    const live = ingest(sb.root);
    assert.equal(live.code, 0, live.err);
    assert.equal(live.json.added, 1);
    const rows = history(sb.root).slice(1);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row[2], 'mcp-jobdatalake');
    assert.equal(row[5], 'added');
    assert.match(row[10], /also_seen:mcp-jobspipe/);
    assert.equal(row[row.length - 1], 'q1', 'query_id is the trailing column');
    const pipeline = read(sb.root, 'data/pipeline.md');
    assert.equal(pipeline.split('\n').filter((l) => /^- \[ \] /.test(l)).length, 1);
    assert.match(pipeline, /mcp-jobspipe/);
  } finally { sb.done(); }
});

test('(c2) same company+title under different employer-direct URLs still dedups to one row', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobdatalake-q1.json', { server: 'jobdatalake', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [ACME('https://jobs.acme-ai.example/careers/applied-ai-engineer')] });
    const r = ingest(sb.root);
    assert.equal(r.json.added, 1);
    assert.equal(r.json.dupes, 1);
  } finally { sb.done(); }
});

test('re-running the same run is idempotent (everything is a dupe)', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    assert.equal(ingest(sb.root).json.added, 1);
    const again = ingest(sb.root);
    assert.equal(again.json.added, 0);
    assert.equal(again.json.dupes, 1);
    assert.equal(history(sb.root).length, 2, 'header + one row, nothing re-appended');
  } finally { sb.done(); }
});

test('(d) blacklisted company -> filtered.blacklist:1, nothing written for it', () => {
  const sb = sandbox({ blacklist: '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme AI | 2026-01-01 | company | no thanks |\n' });
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    const r = ingest(sb.root);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.filtered.blacklist, 1);
    assert.equal(r.json.added, 0);
    assert.equal(r.json.seen, 1);
    assert.equal(existsSync(join(sb.root, 'data/scan-history.tsv')), false);
  } finally { sb.done(); }
});

test('title and location filters from portals.yml are applied and counted', () => {
  const sb = sandbox({ portals: 'title_filter:\n  positive:\n    - "Solutions Architect"\nlocation_filter:\n  block:\n    - "Austin"\n' });
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [
      { title: 'Applied AI Engineer', company: 'A', url: 'https://jobs.lever.co/a/1', location: 'Remote' },
      { title: 'Solutions Architect', company: 'B', url: 'https://jobs.lever.co/b/1', location: 'Austin, TX' },
      { title: 'Solutions Architect', company: 'C', url: 'https://jobs.lever.co/c/1', location: 'Remote' },
    ] });
    const r = ingest(sb.root);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.filtered.title, 1);
    assert.equal(r.json.filtered.location, 1);
    assert.equal(r.json.added, 1);
  } finally { sb.done(); }
});

test('title-filtered rows sharing a profile keyword are logged as near-misses; unrelated ones are not; --dry-run logs nothing', () => {
  const sb = sandbox({
    portals: 'title_filter:\n  positive:\n    - "Solutions Architect"\n',
    profile: 'target_roles:\n  primary:\n    - "Applied AI Engineer"\n',
  });
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [
      { title: 'Applied AI Engineer', company: 'A', url: 'https://jobs.lever.co/a/1', location: 'Remote' },
      { title: 'Warehouse Associate', company: 'B', url: 'https://jobs.lever.co/b/1', location: 'Remote' },
      { title: 'Solutions Architect', company: 'C', url: 'https://jobs.lever.co/c/1', location: 'Remote' },
    ] });
    const logFile = join(sb.root, 'data', 'eval', 'dropped-titles.tsv');
    const dry = ingest(sb.root, ['--run', RUN, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(existsSync(logFile), false);
    const r = ingest(sb.root);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.filtered.title, 2);
    assert.equal('droppedTitles' in r.json, false);
    const rows = read(sb.root, 'data/eval/dropped-titles.tsv').trim().split('\n').map((l) => l.split('\t'));
    assert.deepEqual(rows.map((c) => c[3]), ['Applied AI Engineer']);
    assert.equal(rows[0][1], 'mcp-jobspipe');
  } finally { sb.done(); }
});

test('cooldown window from profile.yml is applied and counted', () => {
  const today = new Date().toISOString().slice(0, 10);
  const sb = sandbox({ profile: `re_apply_windows:\n  "Acme AI":\n    last_apply_date: "${today}"\n    same_role_days: 30\n    applied_to: ["Applied AI Engineer"]\n` });
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    const r = ingest(sb.root);
    assert.equal(r.json.filtered.cooldown, 1);
    assert.equal(r.json.added, 0);
  } finally { sb.done(); }
});

test('job already in the tracker is a dupe', () => {
  const tracker = `${TRACKER}| 1 | 2026-09-01 | Acme AI | Applied AI Engineer | 4.2/5 | Applied | ✅ | [001](reports/001-acme-2026-09-01.md) | |\n`;
  const sb = sandbox({ tracker });
  try {
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/9999')] });
    const r = ingest(sb.root);
    assert.equal(r.json.dupes, 1);
    assert.equal(r.json.added, 0);
  } finally { sb.done(); }
});

test('aggregator rows (FoundRole, Indeed host, unidentified employer) are unconfirmed: status + [?] marker', () => {
  const sb = sandbox();
  try {
    copyFileSync(join(FIX, 'foundrole.json'), join(sb.raw, 'foundrole-target-companies-chunk-1.json'));
    put(sb.raw, 'jobspipe-q2.json', { server: 'jobspipe', query_id: 'q2', rows: [
      { title: 'Forward Deployed Engineer', company: 'Beta Corp', url: 'https://www.indeed.com/viewjob?jk=abc123&utm_source=x' },
      { title: 'Hidden Employer Role', company: '', url: 'https://jobs.lever.co/hidden/1' },
    ] });
    const r = ingest(sb.root);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.added, 0);
    assert.equal(r.json.unconfirmed, 4);
    const rows = history(sb.root).slice(1);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((c) => c[5] === 'unconfirmed'));
    const fr = rows.find((c) => c[0].includes('/jobs/77'));
    assert.equal(fr[0], 'https://example-board.test/jobs/77?token=keep-me&src=fr', 'URL params preserved');
    assert.equal(fr[2], 'mcp-foundrole');
    assert.equal(fr[fr.length - 1], 'target-companies-chunk-1');
    const pipeline = read(sb.root, 'data/pipeline.md');
    assert.equal(pipeline.split('\n').filter((l) => /^- \[\?\] /.test(l)).length, 4);
    assert.equal(pipeline.split('\n').filter((l) => /^- \[ \] /.test(l)).length, 0);
  } finally { sb.done(); }
});

test('an aggregator listing of a job already added from an employer URL is absorbed, not re-queued', () => {
  const sb = sandbox();
  try {
    put(sb.raw, 'foundrole-q1.json', { server: 'foundrole', rows: [{ id: 'f1', resultItemId: 'r1', title: 'Applied AI Engineer', company: 'Acme AI', url: 'https://example-board.test/jobs/1' }] });
    put(sb.raw, 'jobspipe-q1.json', { server: 'jobspipe', rows: [ACME('https://boards.greenhouse.io/acmeai/jobs/4001')] });
    const r = ingest(sb.root);
    assert.equal(r.json.added, 1);
    assert.equal(r.json.unconfirmed, 0);
    assert.equal(r.json.dupes, 1);
    const [row] = history(sb.root).slice(1);
    assert.equal(row[2], 'mcp-jobspipe');
    assert.match(row[10], /also_seen:mcp-foundrole/);
  } finally { sb.done(); }
});

