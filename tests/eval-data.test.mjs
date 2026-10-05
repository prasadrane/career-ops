import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  readScanHistory, readTracker, readPipeline, readPortals, readRunLedgers, readScanRuns, flagList,
} from '../lib/eval/_data.mjs';

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'eval-data-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };

test('all readers are safe on an empty root', () => {
  const root = mkRoot();
  try {
    assert.deepEqual(readScanHistory(root), []);
    assert.deepEqual(readTracker(root), []);
    assert.deepEqual(readPipeline(root), []);
    assert.deepEqual(readPortals(root), {});
    assert.deepEqual(readRunLedgers(root), []);
    assert.deepEqual(readScanRuns(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readScanHistory tolerates 12- and 13-column rows and defaults status', () => {
  const root = mkRoot();
  try {
    const legacy = ['https://a.com/1?utm_source=x', '2026-09-01', 'greenhouse', 'Architect', 'Acme', 'added', 'US', 'fp', '2026-08-30', '', '', 'acme'].join('\t');
    const modern = ['https://b.com/2', '2026-09-02', 'mcp-jobspipe', 'Engineer', 'Beta', 'unconfirmed', '', '', '', '40', 'also_seen:ashby,ghost', 'beta', 'q1'].join('\t');
    const short = ['https://c.com/3', '2026-09-03', 'lever', 'Role', 'Gamma'].join('\t');
    w(root, 'data/scan-history.tsv', [legacy, modern, short].join('\n') + '\n');
    const rows = readScanHistory(root);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].query_id, '');
    assert.equal(rows[0].urlKey, 'https://a.com/1');
    assert.equal(rows[1].query_id, 'q1');
    assert.deepEqual(flagList(rows[1]), ['also_seen:ashby', 'ghost']);
    assert.equal(rows[2].status, 'added');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readPipeline parses markers; readPortals/readScanRuns/readRunLedgers read by name', () => {
  const root = mkRoot();
  try {
    w(root, 'data/pipeline.md', '# Pipeline\n- [ ] https://x.com/1 | A\n- [x] https://x.com/2\n- [?] https://linkedin.com/jobs/view/9\n- [!] https://linkedin.com/jobs/view/8\nnoise\n');
    const p = readPipeline(root);
    assert.deepEqual(p.map((r) => r.marker), [' ', 'x', '?', '!']);
    assert.equal(p[0].urlKey, 'https://x.com/1');
    w(root, 'portals.yml', 'mcp_sources:\n  enabled: [jobspipe]\n');
    assert.deepEqual(readPortals(root).mcp_sources.enabled, ['jobspipe']);
    w(root, 'data/scan-runs.tsv', 'timestamp\tstatus\tnew_added\n2026-09-01T00:00:00Z\tok\t3\n');
    assert.equal(readScanRuns(root)[0].new_added, '3');
    w(root, 'data/runs/r1/tasks.tsv', 'task_id\tstage\tstatus\n1\tscan\tdone\n');
    assert.deepEqual(readRunLedgers(root).map((r) => [r.run, r.status]), [['r1', 'done']]);
    w(root, 'portals.yml', ': : bad: [yaml');
    assert.deepEqual(readPortals(root), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BOM-prefixed TSV headers still resolve; readPortals honors CAREER_OPS_PORTALS', () => {
  const root = mkRoot();
  const prev = process.env.CAREER_OPS_PORTALS;
  try {
    w(root, 'data/scan-runs.tsv', '﻿timestamp\tstatus\tnew_added\n2026-09-01T00:00:00Z\tok\t3\n');
    assert.equal(readScanRuns(root)[0].timestamp, '2026-09-01T00:00:00Z');
    w(root, 'alt/portals.yml', 'mcp_sources:\n  enabled: [foundrole]\n');
    process.env.CAREER_OPS_PORTALS = join(root, 'alt', 'portals.yml');
    assert.deepEqual(readPortals(root).mcp_sources.enabled, ['foundrole']);
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('readTracker resolves urlKey from the url column or the report **URL:** header', () => {
  const root = mkRoot();
  try {
    w(root, 'reports/001-acme-2026-09-01.md', '# R\n\n**URL:** https://jobs.acme.com/1?gh_src=z\n');
    w(root, 'data/applications.md',
      '# T\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n'
      + '| 1 | 2026-09-01 | Acme | Architect | 4.2/5 | Applied | Y | [001](../reports/001-acme-2026-09-01.md) | n |\n');
    const t = readTracker(root);
    assert.equal(t.length, 1);
    assert.equal(t[0].scoreNum, 4.2);
    assert.equal(t[0].urlKey, 'https://jobs.acme.com/1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
