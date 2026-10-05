import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import probe from '../lib/eval/p4-score-drift.mjs';

const SINCE = new Date('2026-08-01T00:00:00Z');
const mkRoot = () => mkdtempSync(join(tmpdir(), 'eval-p4-'));
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
const report = (root, n, { score = 4.0, archetype = 'AI Platform' } = {}) =>
  w(root, `reports/${String(n).padStart(3, '0')}-acme-2026-09-01.md`,
    `# Evaluation: Acme — Role\n\n**Date:** 2026-09-01\n**URL:** https://x.test/${n}\n**Archetype:** ${archetype}\n**Score:** ${score}/5\n**Legitimacy:** High Confidence\n`);
const golden = (root, rows) =>
  w(root, 'data/eval/golden-user.jsonl', rows.map((r) => JSON.stringify({ label_source: 'user-correction', note: '', ...r })).join('\n') + '\n');

function fixture(root, n, matches, { scoreDelta = 0.2 } = {}) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    report(root, i, { score: 4.0, archetype: 'AI Platform' });
    rows.push({ report: String(i).padStart(3, '0'), archetype: i <= matches ? 'AI Platform' : 'Data Eng', score: 4.0 + scoreDelta });
  }
  golden(root, rows);
}

test('no data at all -> insufficient-data, no throw', async () => {
  const root = mkRoot();
  try {
    const r = await probe({ root, since: SINCE });
    assert.equal(r.phase, 'p4');
    assert.equal(r.verdict, 'insufficient-data');
    assert.equal(r.metrics.userGoldenN, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('golden-user n=4 -> insufficient-data with (n too small)', async () => {
  const root = mkRoot();
  try {
    fixture(root, 4, 4);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.verdict, 'insufficient-data');
    assert.equal(r.metrics.userGoldenN, 4);
    assert.equal(r.metrics.archetypeAgreement, '(n too small)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('n=8, 7 archetype matches -> 0.875 pass; mean abs score delta computed', async () => {
  const root = mkRoot();
  try {
    fixture(root, 8, 7, { scoreDelta: 0.3 });
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.userGoldenN, 8);
    assert.equal(r.metrics.archetypeAgreement, 0.875);
    assert.equal(r.metrics.meanAbsScoreDelta, 0.3);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.metrics.driftVsLastRun, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agreement 0.625 -> warn; 0.5 -> fail', async () => {
  const a = mkRoot(); const b = mkRoot();
  try {
    fixture(a, 8, 5);
    assert.equal((await probe({ root: a, since: SINCE })).verdict, 'warn');
    fixture(b, 8, 4);
    assert.equal((await probe({ root: b, since: SINCE })).verdict, 'fail');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('labels whose report is missing are listed, not counted as comparable', async () => {
  const root = mkRoot();
  try {
    for (let i = 1; i <= 6; i++) report(root, i);
    golden(root, [...Array.from({ length: 6 }, (_, i) => ({ report: String(i + 1).padStart(3, '0'), archetype: 'AI Platform', score: 4 })),
      { report: '099', archetype: 'X', score: 3 }]);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.userGoldenN, 7);
    assert.equal(r.metrics.archetypeAgreement, 1);
    assert.ok(r.findings.some((f) => /099/.test(f) && /no report/i.test(f)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unpadded label number matches padded report; malformed jsonl lines skipped', async () => {
  const root = mkRoot();
  try {
    for (let i = 1; i <= 5; i++) report(root, i);
    w(root, 'data/eval/golden-user.jsonl',
      ['{bad json', ...[1, 2, 3, 4, 5].map((i) => JSON.stringify({ report: String(i), archetype: 'ai platform', score: 4 }))].join('\n'));
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.userGoldenN, 5);
    assert.equal(r.metrics.archetypeAgreement, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('driftVsLastRun compares meanAbsScoreDelta with the previous p4 runs.tsv row', async () => {
  const root = mkRoot();
  try {
    fixture(root, 8, 8, { scoreDelta: 0.5 });
    w(root, 'data/eval/runs.tsv',
      'timestamp\tphase\tverdict\tmetrics_json\n'
      + `2026-09-01T00:00:00Z\tp4\tpass\t${JSON.stringify({ userGoldenN: 8, archetypeAgreement: 1, meanAbsScoreDelta: 0.2 })}\n`
      + '2026-09-02T00:00:00Z\tp3\tpass\t{}\n');
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.driftVsLastRun, 0.3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
