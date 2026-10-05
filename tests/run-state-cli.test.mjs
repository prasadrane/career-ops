import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'run-state.mjs');

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'run-state-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

function envFor(root, extra = {}) {
  return { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_AGENT: '', ...extra };
}

function cli(root, args, extra) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: envFor(root, extra), encoding: 'utf-8' });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { /* keep null */ } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

function cliAsync(root, args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: envFor(root) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}

function seed(root, n = 3) {
  const companies = Array.from({ length: n }, (_, i) => ({ name: `Co${i}` }));
  const spec = join(root, 'spec.json');
  writeFileSync(spec, JSON.stringify({
    targetChunks: [companies.map((c) => c.name)], mcpQueries: [{ id: 'q1' }], enabledServers: ['foundrole'],
  }));
  return cli(root, ['init', '--spec', spec, '--json']);
}

function drain(root) {
  for (;;) {
    const c = cli(root, ['claim', '--agent', 'a', '--json']);
    if (!c.json?.task) break;
    assert.equal(cli(root, ['complete', c.json.task.task_id, '--json']).code, 0);
  }
}

test('status: exit 0 with no run', () => {
  const root = mkRoot();
  try {
    const s = cli(root, ['status', '--json']);
    assert.equal(s.code, 0);
    assert.equal(s.json.run, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init then status exit 10; complete all -> exit 0 and run completed', () => {
  const root = mkRoot();
  try {
    const i = seed(root);
    assert.equal(i.code, 0, i.err);
    assert.ok(i.json.run.run_id);
    const s = cli(root, ['status', '--json']);
    assert.equal(s.code, 10);
    assert.equal(s.json.profileChanged, false);
    assert.ok(s.json.summary.pending > 0);
    drain(root);
    const s2 = cli(root, ['status', '--json']);
    assert.equal(s2.code, 0);
    assert.equal(s2.json.run.status, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('abort -> status exit 0; init refused while running', () => {
  const root = mkRoot();
  try {
    seed(root);
    assert.equal(seed(root).code, 1);
    assert.equal(cli(root, ['abort', '--json']).code, 0);
    assert.equal(cli(root, ['status', '--json']).code, 0);
    assert.equal(seed(root).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claim default agent from CAREER_OPS_AGENT, else unknown; --no-mcp skips mcp', () => {
  const root = mkRoot();
  try {
    seed(root);
    const a = cli(root, ['claim', '--json'], { CAREER_OPS_AGENT: 'codex' });
    assert.equal(a.json.task.owner, 'codex');
    cli(root, ['complete', a.json.task.task_id]);
    const b = cli(root, ['claim', '--json']);
    assert.equal(b.json.task.owner, 'unknown');
    cli(root, ['complete', b.json.task.task_id]);
    const c = cli(root, ['claim', '--no-mcp', '--json']);
    assert.equal(c.json.task.stage, 'B1');
    const tsv = readFileSync(join(root, 'data', 'runs', readdirSync(join(root, 'data', 'runs'))[0], 'tasks.tsv'), 'utf-8');
    assert.match(tsv, /agent has no MCP/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('heartbeat, fail, skip subcommands', () => {
  const root = mkRoot();
  try {
    seed(root);
    const a = cli(root, ['claim', '--json']).json.task.task_id;
    assert.equal(cli(root, ['heartbeat', a, '--json']).code, 0);
    assert.equal(cli(root, ['fail', a, '--note', 'boom', '--json']).code, 0);
    assert.equal(cli(root, ['complete', a, '--json']).code, 1);
    assert.equal(cli(root, ['skip', 'T002', '--note', 'n', '--json']).code, 0);
    const s = cli(root, ['status', '--json']);
    assert.equal(s.json.summary.failed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profileChanged:true when run profile_hash differs from current', () => {
  const root = mkRoot();
  try {
    const i = seed(root);
    const runJson = join(root, 'data', 'runs', i.json.run.run_id, 'run.json');
    const run = JSON.parse(readFileSync(runJson, 'utf-8'));
    run.profile_hash = 'stale-hash';
    writeFileSync(runJson, JSON.stringify(run));
    const s = cli(root, ['status', '--json']);
    assert.equal(s.json.profileChanged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent claims never return the same task', async () => {
  const root = mkRoot();
  try {
    seed(root, 3);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => cliAsync(root, ['claim', '--agent', `p${i}`, '--json'])),
    );
    const ids = results.map((r) => { assert.equal(r.code, 0, r.out); return JSON.parse(r.out).task.task_id; });
    assert.equal(new Set(ids).size, ids.length, `duplicate claims: ${ids}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
