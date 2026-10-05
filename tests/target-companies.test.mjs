// tests/target-companies.test.mjs — target-companies-first scan (Task 9).
// Loads the committed FIXTURE (data/ is a gitignored user layer), not
// data/target-companies.yml; the real file has the same content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadTargets, chunk, coverage } from '../lib/target-companies.mjs';
import { parseCompanyInput } from '../discover-ats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'target-companies.yml');

test('loadTargets: 100 entries, 25 dotnet then 75 general, order preserved', () => {
  const t = loadTargets(FIXTURE);
  assert.equal(t.length, 100);
  assert.equal(t.filter((x) => x.tier === 'dotnet').length, 25);
  assert.equal(t.filter((x) => x.tier === 'general').length, 75);
  assert.ok(t.slice(0, 25).every((x) => x.tier === 'dotnet'));
  assert.ok(t.slice(25).every((x) => x.tier === 'general'));
  assert.equal(t[0].name, 'Roblox');
});

test('loadTargets: searchNames split "A / B" and "Name (Alias)" into official names', () => {
  const by = Object.fromEntries(loadTargets(FIXTURE).map((x) => [x.name, x.searchNames]));
  assert.deepEqual(by['ByteDance / TikTok'], ['ByteDance', 'TikTok']);
  assert.deepEqual(by['Block (Square)'], ['Block', 'Square']);
  assert.deepEqual(by['Walt Disney / Disney+'], ['Walt Disney', 'Disney+']);
  assert.deepEqual(by['Amazon (AWS)'], ['Amazon', 'AWS']);
  assert.deepEqual(by['Gen Digital (Symantec)'], ['Gen Digital', 'Symantec']);
  assert.deepEqual(by['Western Digital'], ['Western Digital']);
});

test('chunk: 100 targets -> 5 chunks of <=20 primary names', () => {
  const t = loadTargets(FIXTURE);
  const c = chunk(t, 20);
  assert.equal(c.length, 5);
  assert.ok(c.every((x) => x.length <= 20));
  assert.equal(c.flat().length, 100);
  assert.ok(c.flat().includes('ByteDance') && !c.flat().includes('ByteDance / TikTok'));
  assert.equal(chunk(t).length, 5, 'default size is 20');
});

test('coverage: ats / mcp / custom-site-unscanned / no-results', () => {
  const targets = [
    { name: 'Roblox', searchNames: ['Roblox'] },
    { name: 'Block (Square)', searchNames: ['Block', 'Square'] },
    { name: 'Meta', searchNames: ['Meta'] },
    { name: 'Nobody', searchNames: ['Nobody'] },
  ];
  const r = coverage({
    targets,
    resolvedBoards: ['  roblox '],
    mcpSeen: ['square'],
    customSites: ['Meta'],
  });
  assert.deepEqual(r.map((x) => [x.name, x.route]), [
    ['Roblox', 'ats'], ['Block (Square)', 'mcp'], ['Meta', 'custom-site-unscanned'], ['Nobody', 'no-results'],
  ]);
});

test('discover-ats --in shape: tolerates tier/location keys', () => {
  const { companies, warnings } = parseCompanyInput(readFileSync(FIXTURE, 'utf-8'), []);
  assert.equal(companies.length, 100);
  assert.deepEqual(warnings, []);
  assert.equal(companies[0].name, 'Roblox');
});

function scanWith(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-cf-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
    writeFileSync(join(dir, 'targets.yml'), 'companies:\n  - { name: "Block (Square)", tier: general }\n  - { name: Alpha Corp, tier: dotnet }\n');
    writeFileSync(join(dir, 'nomatch.yml'), 'companies:\n  - { name: Nobody Inc }\n');
    writeFileSync(join(dir, 'partial.yml'), 'companies:\n  - { name: Alpha Corp }\n  - { name: Meta }\n');
    const entry = (n) => `  - name: ${n}\n    careers_url: https://example.invalid/${n}\n    parser:\n      command: node\n      script: tests/fixtures/company-board.mjs\n      args: ["{company}"]\n`;
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, `title_filter:\n  positive: ["Platform"]\ntracked_companies:\n${entry('Alpha Corp')}${entry('Square')}${entry('Gamma')}`);
    const r = spawnSync(process.execPath, [join(ROOT, 'scan.mjs'), '--dry-run', '--json', ...extraArgs.map((a) => a === '@T' ? join(dir, 'targets.yml') : a === '@N' ? join(dir, 'nomatch.yml') : a === '@P' ? join(dir, 'partial.yml') : a)], {
      cwd: dir, encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals },
    });
    return { r, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scan --companies-from restricts the board loop to named companies (aliases honoured)', () => {
  const { r, out } = scanWith(['--companies-from', '@T']);
  assert.equal(r.status, 0, out);
  const receipt = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.equal(receipt.scanned, 2, out);
});

test('scan without --companies-from scans every board (no behavior change)', () => {
  const { r, out } = scanWith([]);
  assert.equal(r.status, 0, out);
  const receipt = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.equal(receipt.scanned, 3, out);
});

test('scan --companies-from with a missing file fails loudly', () => {
  const { r, out } = scanWith(['--companies-from', 'no-such.yml']);
  assert.notEqual(r.status, 0);
  assert.match(out, /companies-from/);
});

test('scan --companies-from matching nothing exits 1 with a clear message', () => {
  const { r, out } = scanWith(['--companies-from', '@N']);
  assert.equal(r.status, 1, out);
  assert.match(out, /--companies-from matched no tracked_companies \(run discover-ats --write first\)/);
});

test('scan --companies-from partial match: exit 0, unmatched listed in receipt', () => {
  const { r, out } = scanWith(['--companies-from', '@P']);
  assert.equal(r.status, 0, out);
  const receipt = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.deepEqual(receipt.matched_targets, ['Alpha Corp']);
  assert.deepEqual(receipt.unmatched_targets, ['Meta']);
  assert.match(out, /Targets unmatched:\s+1 of 2/);
});

test('chunk: 20/21 boundary, size guard, case-insensitive dedupe of primaries', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, searchNames: [`C${i}`] }));
  assert.deepEqual(chunk(mk(20)).map((c) => c.length), [20]);
  assert.deepEqual(chunk(mk(21)).map((c) => c.length), [20, 1]);
  assert.deepEqual(chunk(mk(3), 0).map((c) => c.length), [1, 1, 1]);
  const dup = [
    { name: 'Meta', searchNames: ['Meta'] },
    { name: 'Meta (Facebook)', searchNames: ['Meta', 'Facebook'] },
    { name: 'META', searchNames: ['META'] },
  ];
  assert.deepEqual(chunk(dup), [['Meta']]);
});
