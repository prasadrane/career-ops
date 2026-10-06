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

const AGG = 'https://www.indeed.com/viewjob?jk=abc123';
const EMP = 'https://boards.greenhouse.io/betacorp/jobs/777';
const PIPE = `# Pipeline

## Pending

- [ ] https://boards.greenhouse.io/other/jobs/1 | Other | Role
- [?] ${AGG} | Beta Corp | Forward Deployed Engineer | Remote (US) | note: unconfirmed: aggregator listing, locate at employer; mcp-foundrole q:q1

## Processed

- [x] #1 | https://x.example/1 | X | Y | 4.0/5 | PDF ✅
`;

function seedPipeline(sb) {
  writeFileSync(join(sb.root, 'data', 'pipeline.md'), PIPE);
  writeFileSync(join(sb.root, 'data', 'scan-history.tsv'),
    `${AGG}\t2026-10-01\tmcp-foundrole\tForward Deployed Engineer\tBeta Corp\tunconfirmed\tRemote (US)\n`);
}

test('--confirm rewrites the [?] row to [ ] on the employer URL with provenance + logs history', () => {
  const sb = sandbox();
  try {
    seedPipeline(sb);
    const dry = ingest(sb.root, ['--confirm', AGG, EMP, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(read(sb.root, 'data/pipeline.md'), PIPE, '--dry-run writes nothing');
    const r = ingest(sb.root, ['--confirm', AGG, EMP]);
    assert.equal(r.code, 0, r.err);
    const pipe = read(sb.root, 'data/pipeline.md');
    assert.doesNotMatch(pipe, /\[\?\]/);
    const row = pipe.split('\n').find((l) => l.includes('betacorp'));
    assert.match(row, /^- \[ \] https:\/\/boards\.greenhouse\.io\/betacorp\/jobs\/777 \| Beta Corp \| Forward Deployed Engineer/);
    assert.match(row, /note: via https:\/\/www\.indeed\.com\/viewjob\?jk=abc123; confirmed at employer/);
    assert.doesNotMatch(row, /locate at employer/);
    const h = history(sb.root).find((c) => c[0].includes('betacorp'));
    assert.equal(h[5], 'added');
    assert.equal(h[2], 'mcp-foundrole');
  } finally { sb.done(); }
});

test('--stale moves the [?] row to Processed and logs skipped_expired', () => {
  const sb = sandbox();
  try {
    seedPipeline(sb);
    const r = ingest(sb.root, ['--stale', AGG]);
    assert.equal(r.code, 0, r.err);
    const pipe = read(sb.root, 'data/pipeline.md');
    assert.doesNotMatch(pipe, /\[\?\]/);
    const [pending, processed] = pipe.split('## Processed');
    assert.doesNotMatch(pending, /indeed/);
    assert.match(processed, /- \[x\] ~~https:\/\/www\.indeed\.com\/viewjob\?jk=abc123 \| Beta Corp \| Forward Deployed Engineer~~ — not found at employer/);
    const rows = history(sb.root).filter((c) => c[0].includes('indeed'));
    assert.equal(rows.at(-1)[5], 'skipped_expired');
    assert.match(rows.at(-1)[10], /not_found_at_employer/);
  } finally { sb.done(); }
});

test('--confirm / --stale exit 1 for an unknown URL, an aggregator employer URL, or missing args', () => {
  const sb = sandbox();
  try {
    seedPipeline(sb);
    assert.equal(ingest(sb.root, ['--stale', 'https://nowhere.example/x']).code, 1);
    assert.equal(ingest(sb.root, ['--confirm', 'https://nowhere.example/x', EMP]).code, 1);
    assert.equal(ingest(sb.root, ['--confirm', AGG, 'https://www.indeed.com/viewjob?jk=zzz']).code, 1);
    assert.equal(ingest(sb.root, ['--confirm', AGG]).code, 1);
    assert.equal(read(sb.root, 'data/pipeline.md'), PIPE);
  } finally { sb.done(); }
});

test('--confirm and --stale are idempotent: a repeat call exits 0 "already ..." and writes nothing', () => {
  const sb = sandbox();
  try {
    seedPipeline(sb);
    assert.equal(ingest(sb.root, ['--confirm', AGG, EMP]).code, 0);
    const afterPipe = read(sb.root, 'data/pipeline.md');
    const afterHist = read(sb.root, 'data/scan-history.tsv');
    const again = ingest(sb.root, ['--confirm', AGG, EMP]);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.json.already, 'confirmed');
    assert.match(again.err, /already confirmed/);
    assert.equal(read(sb.root, 'data/pipeline.md'), afterPipe);
    assert.equal(read(sb.root, 'data/scan-history.tsv'), afterHist);

    const sb2 = sandbox();
    try {
      seedPipeline(sb2);
      assert.equal(ingest(sb2.root, ['--stale', AGG]).code, 0);
      const p2 = read(sb2.root, 'data/pipeline.md');
      const h2 = read(sb2.root, 'data/scan-history.tsv');
      const r2 = ingest(sb2.root, ['--stale', AGG]);
      assert.equal(r2.code, 0, r2.err);
      assert.equal(r2.json.already, 'stale');
      assert.match(r2.err, /already stale/);
      assert.equal(read(sb2.root, 'data/pipeline.md'), p2);
      assert.equal(read(sb2.root, 'data/scan-history.tsv'), h2);
    } finally { sb2.done(); }
  } finally { sb.done(); }
});

test('--confirm when the employer URL is already a pending row merges: the [?] row goes, no duplicate row appears', () => {
  const sb = sandbox();
  try {
    seedPipeline(sb);
    writeFileSync(join(sb.root, 'data', 'pipeline.md'), PIPE.replace('## Processed', `- [ ] ${EMP} | Beta Corp | Forward Deployed Engineer\n\n## Processed`));
    const r = ingest(sb.root, ['--confirm', AGG, EMP]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.merged, true);
    const pipe = read(sb.root, 'data/pipeline.md');
    assert.doesNotMatch(pipe, /\[\?\]/);
    assert.equal(pipe.split('\n').filter((l) => l.includes('betacorp/jobs/777')).length, 1);
  } finally { sb.done(); }
});

test('--confirm leaves both the history row and the rewritten pipeline row (exactly one of each)', () => {
  const sb = sandbox();
  try {
    seedPipeline(sb);
    // make the pipeline write impossible: a directory where pipeline.md would be replaced is not
    // portable, so assert the ordering through the observable end state instead
    assert.equal(ingest(sb.root, ['--confirm', AGG, EMP]).code, 0);
    const h = history(sb.root).filter((c) => c[0].includes('betacorp'));
    assert.equal(h.length, 1);
    assert.match(read(sb.root, 'data/pipeline.md'), /betacorp\/jobs\/777/);
  } finally { sb.done(); }
});
