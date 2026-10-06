import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnderNestedCheckout } from '../lib/mjs-files.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import probe from '../lib/eval/p2-title-audit.mjs';

const SINCE = new Date('2026-08-01T00:00:00Z');

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'eval-p2-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
const hist = (url, title, status = 'added', queryId = '') =>
  [url, '2026-09-01', 'greenhouse', title, 'Co', status, '', '', '', '', '', '', queryId].join('\t');
const TRACKER_HEAD = '# T\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n';
const trow = (n, role, score, status, url) => `| ${n} | 2026-09-02 | Co | ${role} | ${score}/5 | ${status} | Y | — | n | ${url} |\n`;
const PORTALS = 'title_filter:\n  positive: ["architect"]\n  negative: ["intern"]\n';

const drop = (root, rows) => w(root, 'data/eval/dropped-titles.tsv',
  rows.map(([title, company = 'Co']) => ['2026-09-05', 'greenhouse', company, title, 'https://x.com/d'].join('\t')).join('\n') + '\n');

test('logged dropped title sharing >=2 keywords with applied titles is sampled; unrelated is not', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', PORTALS);
    w(root, 'data/scan-history.tsv', hist('https://x.com/1', 'AI Solutions Architect') + '\n');
    drop(root, [['Principal AI Solutions Engineer'], ['Warehouse Associate'], ['Solutions Intern']]);
    w(root, 'data/applications.md', TRACKER_HEAD + trow(1, 'AI Solutions Architect', '4.5', 'Applied', 'https://x.com/1'));
    const r = await probe({ root, since: SINCE });
    assert.equal(r.phase, 'p2');
    assert.deepEqual(r.detail.recallSample.map((s) => s.title), ['Principal AI Solutions Engineer']);
    assert.match(r.detail.recallSample[0].reason, /ai/);
    assert.match(r.detail.recallSample[0].reason, /solutions/);
    assert.equal(r.metrics.recallSample, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('history rows alone (kept postings only) never produce a recall sample; no log -> recall insufficient-data', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', PORTALS);
    w(root, 'data/scan-history.tsv', hist('https://x.com/2', 'Principal AI Solutions Engineer', 'filtered_title') + '\n');
    w(root, 'data/applications.md', TRACKER_HEAD + trow(1, 'AI Solutions Architect', '4.5', 'Applied', 'https://x.com/1'));
    const r = await probe({ root, since: SINCE });
    assert.deepEqual(r.detail.recallSample, []);
    assert.equal(r.metrics.recallSample, 'insufficient-data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('precision is "(n too small)" below 5 evaluated; computed at/above', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', PORTALS);
    const mk = (n, scores) => {
      const rows = []; let tr = TRACKER_HEAD;
      for (let i = 0; i < n; i++) {
        rows.push(hist(`https://x.com/${i}`, `AI Architect ${i}`));
        tr += trow(i + 1, `AI Architect ${i}`, scores[i], 'Evaluated', `https://x.com/${i}`);
      }
      w(root, 'data/scan-history.tsv', rows.join('\n') + '\n');
      w(root, 'data/applications.md', tr);
    };
    mk(3, ['4.0', '4.0', '4.0']);
    let r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.precision, '(n too small)');
    assert.equal(r.verdict, 'insufficient-data');
    mk(6, ['4.0', '3.5', '2.0', '4.2', '3.0', '3.6']);   // 4 of 6 >= 3.5
    r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.evaluated, 6);
    assert.equal(r.metrics.precision, 67);
    assert.equal(r.verdict, 'pass');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('low precision warns/fails', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', PORTALS);
    const rows = []; let tr = TRACKER_HEAD;
    for (let i = 0; i < 10; i++) {
      rows.push(hist(`https://x.com/${i}`, `AI Architect ${i}`));
      tr += trow(i + 1, `AI Architect ${i}`, i < 1 ? '4.0' : '2.0', 'Evaluated', `https://x.com/${i}`);
    }
    w(root, 'data/scan-history.tsv', rows.join('\n') + '\n');
    w(root, 'data/applications.md', tr);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.precision, 10);
    assert.equal(r.verdict, 'fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('perQuery rolls up seen/added/evaluated/applied; 12-column legacy rows tolerated', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', PORTALS);
    const legacy = ['https://x.com/9', '2026-09-01', 'greenhouse', 'AI Architect', 'Co', 'added', '', '', '', '', '', ''].join('\t');
    w(root, 'data/scan-history.tsv', [
      hist('https://x.com/1', 'AI Architect', 'added', 'q1'),
      hist('https://x.com/2', 'AI Architect B', 'unconfirmed', 'q1'),
      hist('https://x.com/3', 'AI Architect C', 'added', 'q2'),
      legacy,
    ].join('\n') + '\n');
    w(root, 'data/applications.md', TRACKER_HEAD + trow(1, 'AI Architect', '4.2', 'Applied', 'https://x.com/1'));
    const r = await probe({ root, since: SINCE });
    const q1 = r.detail.perQuery.find((q) => q.query_id === 'q1');
    assert.deepEqual([q1.seen, q1.added, q1.evaluated, q1.applied], [2, 2, 1, 1]);
    assert.equal(r.detail.perQuery.find((q) => q.query_id === 'q2').seen, 1);
    assert.equal(r.detail.perQuery.find((q) => q.query_id === '').seen, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing/empty data and missing portals.yml -> insufficient-data, no throw', async () => {
  const root = mkRoot();
  try {
    let r = await probe({ root, since: SINCE });
    assert.equal(r.verdict, 'insufficient-data');
    w(root, 'data/scan-history.tsv', '');
    w(root, 'data/applications.md', '');
    r = await probe({ root, since: SINCE });
    assert.equal(r.verdict, 'insufficient-data');
    assert.deepEqual(r.detail.recallSample, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only: never writes or auto-adds anything (portals.yml untouched)', async () => {
  const root = mkRoot();
  try {
    w(root, 'portals.yml', PORTALS);
    w(root, 'data/scan-history.tsv', hist('https://x.com/2', 'Principal AI Solutions Engineer') + '\n');
    w(root, 'data/applications.md', TRACKER_HEAD + trow(1, 'AI Solutions Architect', '4.5', 'Applied', 'https://x.com/1'));
    const snap = () => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !isUnderNestedCheckout(root, relative(root, join(e.parentPath ?? e.path, e.name)))).map((e) => [join(e.parentPath ?? e.path, e.name), readFileSync(join(e.parentPath ?? e.path, e.name), 'utf-8')]));
    const before = snap();
    await probe({ root, since: SINCE });
    assert.deepEqual(snap(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
