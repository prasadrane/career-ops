// Guards field-name drift between the real probes (P1/P2) and buildProposals: the proposals
// generator reads detail.sources[].addedLast3Runs/everSeen, so feed it REAL probe output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import p1 from '../lib/eval/p1-source-yield.mjs';
import p2 from '../lib/eval/p2-title-audit.mjs';
import { buildProposals } from '../lib/eval/proposals.mjs';

const SINCE = new Date('2026-08-01T00:00:00Z');
const NOW = new Date('2026-09-04T00:00:00Z');
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
const hist = (url, date, portal, title, status = 'added') =>
  [url, date, portal, title, 'Co', status, '', '', '', '', '', '', ''].join('\t');
const runs = (dates) => 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tnew_added\n'
  + dates.map((d) => `${d}T10:00:00Z\tok\t5\t5\t9\t3\t1`).join('\n') + '\n';

test('real P1 + P2 output -> at least one proposal for a source with 0 adds in the last 3 runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-propint-'));
  try {
    w(root, 'portals.yml', 'mcp_sources:\n  enabled: [jobspipe]\n');
    w(root, 'data/scan-runs.tsv', runs(['2026-09-01', '2026-09-02', '2026-09-03']));
    w(root, 'data/scan-history.tsv', [
      hist('https://boards.greenhouse.io/a/jobs/1', '2026-09-01', 'greenhouse', 'AI Architect'),
      hist('https://boards.greenhouse.io/a/jobs/2', '2026-09-03', 'greenhouse', 'AI Engineer'),
      hist('https://jobs.ashbyhq.com/c/1', '2026-08-10', 'ashby', 'Old role'),
    ].join('\n') + '\n');
    w(root, 'data/applications.md',
      '# T\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n'
      + '| 1 | 2026-09-02 | Co | AI Engineer | 4.4/5 | Interview | Y | — | https://boards.greenhouse.io/a/jobs/2 |\n');

    const r1 = await p1({ root, since: SINCE, now: NOW });
    const r2 = await p2({ root, since: SINCE, now: NOW });
    assert.equal(r1.phase, 'p1');
    assert.equal(r2.phase, 'p2');

    const items = buildProposals([r1, r2]);
    const ashby = items.filter((i) => i.phase === 'p1' && /ashby: 0 adds in last 3 runs/.test(i.text));
    assert.equal(ashby.length, 1, `expected an ashby proposal, got: ${items.map((i) => i.text).join(' | ')}`);
    assert.ok(ashby[0].metric && ashby[0].evidence);
    assert.ok(!items.some((i) => /greenhouse: 0 adds/.test(i.text)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
