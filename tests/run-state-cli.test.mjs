import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'run-state.mjs');
import { main } from '../run-state.mjs';

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'run-state-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

function envFor(root, extra = {}) {
  return { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_AGENT: '', ...extra };
}

// In-process: calls main() with env/console swapped, so a CLI invocation costs ~ms instead of a
// node startup. Real processes are used only where the process boundary is under test (smoke, concurrency).
async function cli(root, args, extra = {}) {
  const saved = {};
  const env = { CAREER_OPS_ROOT: root, CAREER_OPS_AGENT: '', CAREER_OPS_PORTALS: undefined, ...extra };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const log = console.log; const err = console.error;
  let out = ''; let errOut = '';
  console.log = (...x) => { out += `${x.join(' ')}\n`; };
  console.error = (...x) => { errOut += `${x.join(' ')}\n`; };
  let code;
  try { code = await main(args); } finally {
    console.log = log; console.error = err;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(out); } catch { /* keep null */ } }
  return { code, out, err: errOut, json };
}

function cliSpawn(root, args, extra) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: envFor(root, extra), encoding: 'utf-8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function cliAsync(root, args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: envFor(root) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}

async function seed(root, n = 3) {
  const companies = Array.from({ length: n }, (_, i) => ({ name: `Co${i}` }));
  const spec = join(root, 'spec.json');
  writeFileSync(spec, JSON.stringify({
    targetChunks: [companies.map((c) => c.name)], mcpQueries: [{ id: 'q1' }], enabledServers: ['foundrole'],
  }));
  return cli(root, ['init', '--spec', spec, '--json']);
}

async function drain(root) {
  for (;;) {
    const c = await cli(root, ['claim', '--agent', 'a', '--json']);
    if (!c.json?.task) break;
    assert.equal((await cli(root, ['complete', c.json.task.task_id, '--agent', 'a', '--json'])).code, 0);
  }
}

test('status: exit 0 with no run', async () => {
  const root = mkRoot();
  try {
    const s = await cli(root, ['status', '--json']);
    assert.equal(s.code, 0);
    assert.equal(s.json.run, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init then status exit 10; complete all -> exit 0 and run completed', async () => {
  const root = mkRoot();
  try {
    const i = await seed(root);
    assert.equal(i.code, 0, i.err);
    assert.ok(i.json.run.run_id);
    const s = await cli(root, ['status', '--json']);
    assert.equal(s.code, 10);
    assert.equal(s.json.profileChanged, false);
    assert.ok(s.json.summary.pending > 0);
    await drain(root);
    const s2 = await cli(root, ['status', '--json']);
    assert.equal(s2.code, 0);
    assert.equal(s2.json.run.status, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('abort -> status exit 0; init refused while running', async () => {
  const root = mkRoot();
  try {
    await seed(root);
    assert.equal((await seed(root)).code, 1);
    assert.equal((await cli(root, ['abort', '--json'])).code, 0);
    assert.equal((await cli(root, ['status', '--json'])).code, 0);
    assert.equal((await seed(root)).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claim default agent from CAREER_OPS_AGENT, else unknown; --no-mcp skips mcp', async () => {
  const root = mkRoot();
  try {
    await seed(root);
    const a = await cli(root, ['claim', '--json'], { CAREER_OPS_AGENT: 'codex' });
    assert.equal(a.json.task.owner, 'codex');
    await cli(root, ['complete', a.json.task.task_id, '--agent', 'codex']);
    const b = await cli(root, ['claim', '--json']);
    assert.equal(b.json.task.owner, 'unknown');
    await cli(root, ['complete', b.json.task.task_id]);
    const c = await cli(root, ['claim', '--no-mcp', '--json']);
    assert.equal(c.json.task.stage, 'B1');
    const tsv = readFileSync(join(root, 'data', 'runs', readdirSync(join(root, 'data', 'runs'))[0], 'tasks.tsv'), 'utf-8');
    assert.match(tsv, /agent has no MCP/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('heartbeat, fail, skip subcommands', async () => {
  const root = mkRoot();
  try {
    await seed(root);
    const a = (await cli(root, ['claim', '--json'])).json.task.task_id;
    assert.equal((await cli(root, ['heartbeat', a, '--json'])).code, 0);
    assert.equal((await cli(root, ['fail', a, '--note', 'boom', '--json'])).code, 0);
    assert.equal((await cli(root, ['complete', a, '--json'])).code, 1);
    assert.equal((await cli(root, ['skip', 'T002', '--note', 'n', '--json'])).code, 0);
    const s = await cli(root, ['status', '--json']);
    assert.equal(s.json.summary.failed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profileChanged:true when run profile_hash differs from current', async () => {
  const root = mkRoot();
  try {
    const i = await seed(root);
    const runJson = join(root, 'data', 'runs', i.json.run.run_id, 'run.json');
    const run = JSON.parse(readFileSync(runJson, 'utf-8'));
    run.profile_hash = 'stale-hash';
    writeFileSync(runJson, JSON.stringify(run));
    const s = await cli(root, ['status', '--json']);
    assert.equal(s.json.profileChanged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent claims never return the same task', async () => {
  const root = mkRoot();
  try {
    await seed(root, 3);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => cliAsync(root, ['claim', '--agent', `p${i}`, '--json'])),
    );
    // stage ordering: only the first claim wins (rest are blocked, exit 11)
    const ids = results.filter((r) => r.code === 0).map((r) => JSON.parse(r.out).task.task_id);
    assert.equal(results.filter((r) => r.code === 0).length + results.filter((r) => r.code === 11).length, 4);
    assert.ok(ids.length >= 1);
    assert.ok(results.every((r) => r.code === 0 || r.code === 11), results.map((r) => r.code).join());
    assert.equal(new Set(ids).size, ids.length, `duplicate claims: ${ids}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ownership: stale takeover rejects late complete/fail/heartbeat from old owner', async () => {
  const root = mkRoot();
  try {
    const i = await seed(root);
    const a = (await cli(root, ['claim', '--agent', 'A', '--json'])).json.task;
    assert.equal(a.attempts, 1);
    // claim prefers pending over stale, so retire every other task first
    for (let n = 2; n <= 11; n++) await cli(root, ['skip', 'T' + String(n).padStart(3, '0'), '--force', '--agent', 'A']);
    // backdate A's heartbeat so it is stale
    const tsvPath = join(root, 'data', 'runs', i.json.run.run_id, 'tasks.tsv');
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const lines = readFileSync(tsvPath, 'utf-8').split('\n');
    const cols = lines[0].split('\t');
    const row = lines[1].split('\t');
    row[cols.indexOf('claimed_at')] = old;
    row[cols.indexOf('heartbeat_at')] = old;
    lines[1] = row.join('\t');
    writeFileSync(tsvPath, lines.join('\n'));
    const b = (await cli(root, ['claim', '--agent', 'B', '--json'])).json.task;
    assert.equal(b.task_id, a.task_id);
    assert.equal(b.attempts, 2);
    for (const sub of [['complete'], ['fail'], ['heartbeat']]) {
      const r = await cli(root, [...sub, a.task_id, '--agent', 'A', '--json']);
      assert.equal(r.code, 1, sub[0]);
      assert.match(r.json.error, /owned by B/);
    }
    const st = readFileSync(tsvPath, 'utf-8').split('\n')[1].split('\t');
    assert.equal(st[cols.indexOf('status')], 'in_progress');
    assert.equal(st[cols.indexOf('owner')], 'B');
    // attempt mismatch rejected even for the right owner
    const bad = await cli(root, ['complete', a.task_id, '--agent', 'B', '--attempt', '1', '--json']);
    assert.equal(bad.code, 1);
    assert.match(bad.json.error, /attempt 2/);
    // skip on someone else's in-progress task needs --force
    assert.equal((await cli(root, ['skip', a.task_id, '--agent', 'A', '--json'])).code, 1);
    // the owner can still finish
    assert.equal((await cli(root, ['heartbeat', a.task_id, '--agent', 'B', '--attempt', '2', '--json'])).code, 0);
    assert.equal((await cli(root, ['complete', a.task_id, '--agent', 'B', '--attempt', '2', '--json'])).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skip --force overrides ownership; valued flag does not swallow next flag', async () => {
  const root = mkRoot();
  try {
    await seed(root);
    const a = (await cli(root, ['claim', '--agent', 'A', '--json'])).json.task;
    assert.equal((await cli(root, ['skip', a.task_id, '--agent', 'B', '--force', '--json'])).code, 0);
    const r = await cli(root, ['claim', '--agent', '--json']);
    assert.equal(r.code, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function writePortals(root, extra = '') {
  writeFileSync(join(root, 'portals.yml'), [
    'title_filter:', '  positive: ["engineer"]', 'location_filter:', '  allow: ["remote"]',
    'mcp_sources:', '  enabled: [foundrole, jobspipe]', '  queries:', '    - id: q-one', '      titles: ["x"]',
    'tracked_companies:', '  - name: Acme', '    enabled: true', extra,
  ].join('\n'));
}

test('init WITHOUT --spec reads mcp_sources + target chunks from portals.yml / target-companies.yml', async () => {
  const root = mkRoot();
  try {
    writePortals(root);
    writeFileSync(join(root, 'data', 'target-companies.yml'),
      'companies:\n  - name: "Alpha, Inc"\n  - name: Beta\n');
    const i = await cli(root, ['init', '--json']);
    assert.equal(i.code, 0, i.err);
    const tsv = readFileSync(join(root, 'data', 'runs', i.json.run.run_id, 'tasks.tsv'), 'utf-8');
    assert.match(tsv, /mcp-target-foundrole-chunk1/);
    assert.match(tsv, /mcp-target-jobspipe-chunk1/);
    assert.match(tsv, /mcp-broad-foundrole-q-one/);
    assert.match(tsv, /\["Alpha, Inc","Beta"\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init without --spec and without mcp_sources creates no MCP tasks', async () => {
  const root = mkRoot();
  try {
    const i = await cli(root, ['init', '--json']);
    assert.equal(i.code, 0, i.err);
    const tsv = readFileSync(join(root, 'data', 'runs', i.json.run.run_id, 'tasks.tsv'), 'utf-8');
    assert.doesNotMatch(tsv, /\tmcp\t/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profile hash ignores tracked_companies edits but not title_filter edits', async () => {
  const root = mkRoot();
  try {
    writePortals(root);
    await cli(root, ['init', '--json']);
    assert.equal((await cli(root, ['status', '--json'])).json.profileChanged, false);
    writePortals(root, '  - name: Added By A1\n    enabled: true');
    assert.equal((await cli(root, ['status', '--json'])).json.profileChanged, false);
    writeFileSync(join(root, 'portals.yml'), readFileSync(join(root, 'portals.yml'), 'utf-8').replace('"engineer"', '"designer"'));
    assert.equal((await cli(root, ['status', '--json'])).json.profileChanged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claim: blocked by earlier in-progress stage exits 11', async () => {
  const root = mkRoot();
  try {
    await seed(root);
    assert.equal((await cli(root, ['claim', '--agent', 'a', '--json'])).code, 0);
    const b = await cli(root, ['claim', '--agent', 'b', '--json']);
    assert.equal(b.code, 11);
    assert.equal(b.json.blockedBy, 'T001');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claim --no-mcp defers MCP tasks: run stays running, status exit 10 + deferredMcp, MCP agent resumes', async () => {
  const root = mkRoot();
  try {
    await seed(root);
    // finish A1/A2 normally, then a no-MCP agent drains everything it can
    for (;;) {
      const c = await cli(root, ['claim', '--agent', 'n', '--no-mcp', '--json']);
      if (!c.json?.task) {
        assert.equal(c.code, 0);
        assert.ok(c.json.onlyMcp > 0, JSON.stringify(c.json));
        break;
      }
      assert.equal((await cli(root, ['complete', c.json.task.task_id, '--agent', 'n', '--json'])).code, 0);
    }
    const s = await cli(root, ['status', '--json']);
    assert.equal(s.code, 10);
    assert.equal(s.json.run.status, 'running');
    assert.ok(s.json.summary.deferredMcp > 0);
    const m = await cli(root, ['claim', '--agent', 'm', '--json']);
    assert.equal(m.json.task.needs, 'mcp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('smoke (real process): exit codes 0 / 10 / 11 through the CLI boundary', async () => {
  const root = mkRoot();
  try {
    const spec = join(root, 'spec.json');
    writeFileSync(spec, JSON.stringify({ targetChunks: [['Co']], mcpQueries: [{ id: 'q1' }], enabledServers: ['foundrole'] }));
    assert.equal(cliSpawn(root, ['init', '--spec', spec]).code, 0);
    assert.equal(cliSpawn(root, ['status']).code, 10);
    assert.equal(cliSpawn(root, ['claim', '--agent', 'a']).code, 0);
    assert.equal(cliSpawn(root, ['claim', '--agent', 'b']).code, 11);
    assert.equal(cliSpawn(root, ['nope']).code, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
