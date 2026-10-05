import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import probe from '../lib/eval/p1-source-yield.mjs';

const SINCE = new Date('2026-08-01T00:00:00Z');
const NOW = new Date('2026-09-04T00:00:00Z');

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'eval-p1-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
const hist = (url, date, portal, title, status = 'added', extra = []) =>
  [url, date, portal, title, 'Co', status, '', '', '', '', '', '', ...extra].join('\t');
const RUNS_HEADER = 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tnew_added';
const runs = (dates) => RUNS_HEADER + '\n' + dates.map((d) => `${d}T10:00:00Z\tok\t5\t5\t9\t3\t1`).join('\n') + '\n';

function fixture(root, { portals = 'mcp_sources:\n  enabled: [jobspipe, jobdatalake]\n' } = {}) {
  w(root, 'portals.yml', portals);
  w(root, 'data/scan-runs.tsv', runs(['2026-09-01', '2026-09-02', '2026-09-03']));
  const rows = [
    // greenhouse + lever add on each run date; ashby only long before the last 3 runs
    hist('https://boards.greenhouse.io/a/jobs/1', '2026-09-01', 'greenhouse', 'AI Architect'),
    hist('https://boards.greenhouse.io/a/jobs/2', '2026-09-02', 'greenhouse', 'AI Engineer'),
    hist('https://boards.greenhouse.io/a/jobs/3', '2026-09-03', 'greenhouse', 'AI Lead'),
    hist('https://jobs.lever.co/b/1', '2026-09-01', 'lever', 'Solutions Architect'),
    hist('https://jobs.lever.co/b/2', '2026-09-03', 'lever', 'FDE'),
    hist('https://jobs.ashbyhq.com/c/1', '2026-08-10', 'ashby', 'Old role'),
    hist('https://agg.example/1', '2026-09-01', 'mcp-jobspipe', 'Agg role', 'unconfirmed', ['', 'q1']),
  ];
  w(root, 'data/scan-history.tsv', rows.join('\n') + '\n');
  w(root, 'data/applications.md',
    '# T\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n'
    + '| 1 | 2026-09-02 | Co | AI Engineer | 4.4/5 | Interview | Y | — | https://boards.greenhouse.io/a/jobs/2 |\n');
}

test('source with 0 added over the last 3 runs -> warn; unused enabled connector listed', async () => {
  const root = mkRoot();
  try {
    fixture(root);
    const r = await probe({ root, since: SINCE, now: NOW });
    assert.equal(r.phase, 'p1');
    assert.equal(r.verdict, 'warn');
    const ashby = r.detail.sources.find((s) => s.id === 'ashby');
    assert.equal(ashby.addedLast3Runs, 0);
    assert.ok(r.findings.some((f) => /ashby/.test(f) && /last 3/.test(f)));
    assert.deepEqual(r.detail.connectorsConfigured, ['jobdatalake', 'jobspipe']);
    assert.deepEqual(r.detail.connectorsUsed, ['jobspipe']);
    assert.ok(r.findings.some((f) => /jobdatalake/.test(f) && /configured but unused/.test(f)));
    assert.equal(r.metrics.connectorsConfigured, 2);
    assert.equal(r.metrics.connectorsUsed, 1);
    const gh = r.detail.sources.find((s) => s.id === 'greenhouse');
    assert.equal(gh.seen, 3);
    assert.equal(gh.added, 3);
    assert.equal(r.detail.sources.find((s) => s.id === 'lever').addedLast3Runs, 2);
    assert.equal(r.detail.sources.find((s) => s.id === 'mcp-jobspipe').added, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tracker rows join back to the source via normalized URL (applied / interviews)', async () => {
  const root = mkRoot();
  try {
    fixture(root);
    // tracker row carries the url in its url column
    w(root, 'data/applications.md',
      '# T\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n'
      + '| 1 | 2026-09-02 | Co | AI Engineer | 4.4/5 | Interview | Y | — | n | https://boards.greenhouse.io/a/jobs/2?utm_source=x |\n');
    const r = await probe({ root, since: SINCE, now: NOW });
    const gh = r.detail.sources.find((s) => s.id === 'greenhouse');
    assert.equal(gh.applied, 1);
    assert.equal(gh.interviews, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabled MCP source with zero rows ever -> configured-but-unused, verdict warn (healthy others)', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', 'mcp_sources:\n  enabled: [foundrole]\n');
    w(root, 'data/scan-runs.tsv', runs(['2026-09-01', '2026-09-02', '2026-09-03']));
    w(root, 'data/scan-history.tsv', [
      hist('https://x.com/1', '2026-09-01', 'greenhouse', 'A'),
      hist('https://x.com/2', '2026-09-02', 'greenhouse', 'B'),
      hist('https://x.com/3', '2026-09-03', 'greenhouse', 'C'),
    ].join('\n') + '\n');
    const r = await probe({ root, since: SINCE, now: NOW });
    assert.equal(r.verdict, 'warn');
    assert.deepEqual(r.detail.connectorsConfigured, ['foundrole']);
    assert.deepEqual(r.detail.connectorsUsed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabled source that errored in every ledger run -> fail', async () => {
  const root = mkRoot();
  try {
    fixture(root);
    w(root, 'data/runs/r1/tasks.tsv', 'task_id\tseq\tstage\ttitle\tcommand\tstatus\n1\t1\tscan\tmcp jobspipe query\t-\tfailed\n');
    w(root, 'data/runs/r2/tasks.tsv', 'task_id\tseq\tstage\ttitle\tcommand\tstatus\n1\t1\tscan\tmcp jobspipe query\t-\tfailed\n');
    w(root, 'data/runs/r3/tasks.tsv', 'task_id\tseq\tstage\ttitle\tcommand\tstatus\n1\t1\tscan\tmcp jobspipe query\t-\tfailed\n');
    const r = await probe({ root, since: SINCE, now: NOW });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.detail.sources.find((s) => s.id === 'mcp-jobspipe').errorRate, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing/empty data -> insufficient-data, no throw', async () => {
  const root = mkRoot();
  try {
    const r = await probe({ root, since: SINCE, now: NOW });
    assert.equal(r.phase, 'p1');
    assert.equal(r.verdict, 'insufficient-data');
    w(root, 'data/scan-history.tsv', '');
    w(root, 'data/scan-runs.tsv', '');
    assert.equal((await probe({ root, since: SINCE, now: NOW })).verdict, 'insufficient-data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probe is read-only', async () => {
  const root = mkRoot();
  try {
    fixture(root);
    const snap = () => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => [join(e.parentPath ?? e.path, e.name), readFileSync(join(e.parentPath ?? e.path, e.name), 'utf-8')]));
    const before = snap();
    await probe({ root, since: SINCE, now: NOW });
    assert.deepEqual(snap(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
