import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnderNestedCheckout } from '../lib/mjs-files.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import probe from '../lib/eval/p3-verification.mjs';

const SINCE = new Date('2026-08-01T00:00:00Z');

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'eval-p3-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
const hist = (url, portal, status = 'added', { title = 'Role', date = '2026-09-01', flags = '' } = {}) =>
  [url, date, portal, title, 'Co', status, '', '', '', '', flags, ''].join('\t');
const TRACKER_HEAD = '# T\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n';
const trow = (n, status, notes, url) => `| ${n} | 2026-09-02 | Co | Role ${n} | 4.0/5 | ${status} | Y | — | ${notes} | ${url} |\n`;

function pipeline(root, { verified = 6, unconfirmed = 4 } = {}) {
  const lines = ['# Pipeline', ''];
  for (let i = 0; i < verified; i++) lines.push(`- [${i % 2 ? 'x' : ' '}] https://boards.greenhouse.io/co/jobs/${i} | Co | Role`);
  for (let i = 0; i < unconfirmed; i++) lines.push(`- [?] https://www.linkedin.com/jobs/view/${1000 + i} | Co | Role`);
  w(root, 'data/pipeline.md', lines.join('\n') + '\n');
}

test('10 pipeline rows (6 verified, 4 aggregator-unconfirmed) -> unconfirmedPct 40, warn', async () => {
  const root = mkRoot();
  try {
    pipeline(root);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.phase, 'p3');
    assert.equal(r.metrics.verifiedPct, 60);
    assert.equal(r.metrics.unconfirmedPct, 40);
    assert.equal(r.metrics.aggregatorOnlyPct, 40);
    assert.equal(r.verdict, 'warn');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an aggregator row also_seen at an employer ATS is not aggregator-only; ghost flags are counted', async () => {
  const root = mkRoot();
  try {
    pipeline(root);
    w(root, 'data/scan-history.tsv', [
      hist('https://www.linkedin.com/jobs/view/1000', 'mcp-jobspipe', 'unconfirmed', { flags: 'also_seen:greenhouse' }),
      hist('https://www.linkedin.com/jobs/view/1001', 'mcp-jobspipe', 'unconfirmed', { flags: 'also_seen:mcp-jobdatalake' }),
      hist('https://www.linkedin.com/jobs/view/1002', 'mcp-jobspipe', 'unconfirmed', { flags: 'ghost' }),
    ].join('\n') + '\n');
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.aggregatorOnlyPct, 30);       // 1000 employer-confirmed via also_seen:greenhouse
    assert.equal(r.detail.ghostFlagged, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('severe unconfirmed share -> fail; markers [!] count as unconfirmed', async () => {
  const root = mkRoot();
  try {
    w(root, 'data/pipeline.md', [
      '- [ ] https://a.com/1', '- [!] https://www.linkedin.com/jobs/view/1', '- [!] https://www.linkedin.com/jobs/view/2',
      '- [?] https://www.linkedin.com/jobs/view/3', '- [?] https://www.linkedin.com/jobs/view/4', '- [?] https://www.linkedin.com/jobs/view/5',
    ].join('\n') + '\n');
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.unconfirmedPct, 83);
    assert.equal(r.verdict, 'fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MCP liveness agreement below the floor -> insufficient-data; at floor it is computed', async () => {
  const root = mkRoot();
  try {
    pipeline(root);
    const mk = (n, agreeCount) => {
      const rows = []; let tr = TRACKER_HEAD;
      for (let i = 0; i < n; i++) {
        const url = `https://agg.example/${i}`;
        const agrees = i < agreeCount;
        // MCP predicted live (no ghost flag); outcome live when agrees, expired otherwise
        rows.push(hist(url, 'mcp-jobspipe', 'unconfirmed', { flags: 'last_verified' }));
        tr += trow(i + 1, agrees ? 'Applied' : 'Discarded', agrees ? 'liveness: active' : 'expired at employer', url);
      }
      w(root, 'data/scan-history.tsv', rows.join('\n') + '\n');
      w(root, 'data/applications.md', tr);
    };
    mk(3, 3);
    let r = await probe({ root, since: SINCE });
    assert.deepEqual(r.detail.mcpLivenessAgreement, { n: 3, agree: 3, verdict: 'insufficient-data' });
    assert.equal(r.metrics.mcpAgreement, '(n too small)');
    assert.equal(r.verdict, 'warn');                        // overall still driven by unconfirmedPct
    mk(8, 4);
    r = await probe({ root, since: SINCE });
    assert.deepEqual([r.detail.mcpLivenessAgreement.n, r.detail.mcpLivenessAgreement.agree], [8, 4]);
    assert.equal(r.metrics.mcpAgreement, 50);
    assert.ok(r.findings.some((f) => /agreement/.test(f)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ghost-flagged MCP row that later proved expired counts as agreement', async () => {
  const root = mkRoot();
  try {
    w(root, 'data/scan-history.tsv', hist('https://agg.example/1', 'mcp-jobspipe', 'unconfirmed', { flags: 'ghost' }) + '\n');
    w(root, 'data/applications.md', TRACKER_HEAD + trow(1, 'Discarded', 'not found at employer', 'https://agg.example/1'));
    const r = await probe({ root, since: SINCE });
    assert.deepEqual([r.detail.mcpLivenessAgreement.n, r.detail.mcpLivenessAgreement.agree], [1, 1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('liveness outcome regexes: "active interview" is not live, "$410" is not dead; rows without a hint are skipped', async () => {
  const root = mkRoot();
  try {
    w(root, 'data/scan-history.tsv', [
      hist('https://agg.example/1', 'mcp-jobspipe', 'unconfirmed', { flags: 'last_verified' }),
      hist('https://agg.example/2', 'mcp-jobspipe', 'unconfirmed', { flags: 'last_verified' }),
      hist('https://agg.example/3', 'mcp-jobspipe', 'unconfirmed'),   // no ghost/last_verified hint
    ].join('\n') + '\n');
    w(root, 'data/applications.md', TRACKER_HEAD
      + trow(1, 'Interview', 'active interview scheduled', 'https://agg.example/1')
      + trow(2, 'Applied', 'comp up to $410k', 'https://agg.example/2')
      + trow(3, 'Discarded', 'expired at employer', 'https://agg.example/3'));
    const r = await probe({ root, since: SINCE });
    assert.equal(r.detail.mcpLivenessAgreement.n, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repostRate: same company+title under 2+ urls on 2+ dates, with floor', async () => {
  const root = mkRoot();
  try {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(hist(`https://x.com/${i}`, 'greenhouse', 'added', { title: `Role ${i}`, date: '2026-09-01' }));
    rows.push(hist('https://x.com/r0', 'greenhouse', 'added', { title: 'Role 0', date: '2026-09-20' }));
    w(root, 'data/scan-history.tsv', rows.join('\n') + '\n');
    w(root, 'data/pipeline.md', '- [ ] https://x.com/0\n');
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.repostRate, 17);                 // 1 of 6 keys
    w(root, 'data/scan-history.tsv', rows.slice(0, 3).join('\n') + '\n');
    assert.equal((await probe({ root, since: SINCE })).metrics.repostRate, '(n too small)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing/empty data -> insufficient-data, no throw; below-floor pipeline too', async () => {
  const root = mkRoot();
  try {
    let r = await probe({ root, since: SINCE });
    assert.equal(r.phase, 'p3');
    assert.equal(r.verdict, 'insufficient-data');
    w(root, 'data/pipeline.md', '');
    w(root, 'data/scan-history.tsv', '');
    assert.equal((await probe({ root, since: SINCE })).verdict, 'insufficient-data');
    pipeline(root, { verified: 1, unconfirmed: 2 });
    r = await probe({ root, since: SINCE });
    assert.equal(r.verdict, 'insufficient-data');
    assert.equal(r.metrics.unconfirmedPct, '(n too small)');  // 3 rows: no bare percentage below the floor
    assert.equal(r.metrics.verifiedPct, '(n too small)');
    assert.equal(r.metrics.aggregatorOnlyPct, '(n too small)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probe is read-only', async () => {
  const root = mkRoot();
  try {
    pipeline(root);
    w(root, 'data/scan-history.tsv', hist('https://www.linkedin.com/jobs/view/1000', 'mcp-jobspipe', 'unconfirmed') + '\n');
    const snap = () => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !isUnderNestedCheckout(root, relative(root, join(e.parentPath ?? e.path, e.name)))).map((e) => [join(e.parentPath ?? e.path, e.name), readFileSync(join(e.parentPath ?? e.path, e.name), 'utf-8')]));
    const before = snap();
    await probe({ root, since: SINCE });
    assert.deepEqual(snap(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
