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

test('template ships mcp_sources disabled, with the documented example commented out', () => {
  const m = template.mcp_sources;
  assert.ok(m && typeof m === 'object', 'mcp_sources block present');
  assert.deepEqual(m.enabled, [], 'no server is enabled out of the box');
  assert.deepEqual(m.queries, []);
  const text = readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf-8').replace(/\r\n/g, '\n').split('\n');
  const at = text.findIndex((l) => /^\s*# Example \(uncomment/.test(l));
  assert.ok(at > 0, 'commented example present');
  const body = [];
  for (const l of text.slice(at + 1)) { if (!/^\s{2}# ?/.test(l)) break; body.push(l.replace(/^(\s{2})# ?/, '$1')); }
  const ex = yaml.load(`mcp_sources:\n${body.join('\n')}`).mcp_sources;
  assert.ok(Array.isArray(ex.queries) && ex.queries.length >= 1);
  const q = ex.queries[0];
  assert.equal(q.id, 'agentic-ai-us-remote');
  assert.ok(Array.isArray(q.titles) && q.titles.length >= 1);
  assert.equal(q.remote, true);
  assert.deepEqual(q.countries, ['US']);
  assert.equal(q.max_age_days, 14);
  assert.equal(q.min_salary_usd, 150000);
  assert.deepEqual(ex.budget, { jobspipe_calls_per_run: 20, jobdatalake_calls_per_run: 40, foundrole_calls_per_run: 15 });
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
