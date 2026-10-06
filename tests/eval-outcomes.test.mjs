import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import probe from '../lib/eval/p6-outcomes.mjs';

const HEAD = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n';
const mkRoot = (rows = '') => {
  const root = mkdtempSync(join(tmpdir(), 'eval-p6-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), HEAD + rows);
  return root;
};

test('no tracker -> insufficient-data, never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-p6-'));
  try {
    const r = await probe({ root, since: new Date() });
    assert.equal(r.phase, 'p6');
    assert.equal(r.verdict, 'insufficient-data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty tracker -> insufficient-data with resolved/inFlight metrics', async () => {
  const root = mkRoot();
  try {
    const r = await probe({ root, since: new Date() });
    assert.equal(r.verdict, 'insufficient-data');
    assert.equal(r.metrics.resolved, 0);
    assert.equal(r.metrics.inFlight, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('high-score applications reaching interviews -> separating -> pass', async () => {
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push(`| ${i} | 2026-09-01 | Hi${i} | Role | 4.6/5 | Interview | ✅ | [${i}](reports/x.md) | |`);
  for (let i = 7; i <= 12; i++) rows.push(`| ${i} | 2026-09-01 | Lo${i} | Role | 3.2/5 | Rejected | ✅ | [${i}](reports/x.md) | |`);
  const root = mkRoot(rows.join('\n') + '\n');
  try {
    const r = await probe({ root, since: new Date() });
    assert.equal(r.verdict, 'pass', JSON.stringify(r));
    assert.equal(r.metrics.resolved, 12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
