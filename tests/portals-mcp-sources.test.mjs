// tests/portals-mcp-sources.test.mjs - the `mcp_sources` block in templates/portals.example.yml
// is documented, parses, and is ignored (not rejected) by validate-portals.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = yaml.load(readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf-8'));

test('template carries the documented mcp_sources shape', () => {
  const m = template.mcp_sources;
  assert.ok(m && typeof m === 'object', 'mcp_sources block present');
  assert.deepEqual(m.enabled, ['jobspipe', 'jobdatalake', 'foundrole']);
  assert.ok(Array.isArray(m.queries) && m.queries.length >= 1);
  const q = m.queries[0];
  assert.equal(q.id, 'agentic-ai-us-remote');
  assert.ok(Array.isArray(q.titles) && q.titles.length >= 1);
  assert.equal(q.remote, true);
  assert.deepEqual(q.countries, ['US']);
  assert.equal(q.max_age_days, 14);
  assert.equal(q.min_salary_usd, 150000);
  assert.deepEqual(m.budget, { jobspipe_calls_per_run: 20, jobdatalake_calls_per_run: 40, foundrole_calls_per_run: 15 });
});

test('validate-portals.mjs accepts/ignores mcp_sources (no error or warning names it)', () => {
  const run = (file) => spawnSync(process.execPath, [join(ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf-8' });
  const tpl = run(join(ROOT, 'templates', 'portals.example.yml'));
  assert.doesNotMatch(tpl.stdout, /mcp_sources/, tpl.stdout);
  assert.match(tpl.stdout, /0 errors/, tpl.stdout);

  const dir = mkdtempSync(join(tmpdir(), 'portals-mcp-'));
  try {
    const file = join(dir, 'portals.yml');
    writeFileSync(file, 'title_filter:\n  positive: ["AI"]\nmcp_sources:\n  enabled: []\n  queries: []\n');
    const r = run(file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /0 errors, 0 warnings/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
