import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_MS, TASK_TEMPLATE, initRun, claimNext, heartbeat, complete, fail, skip,
  summarize, serializeTasks, parseTasks,
} from '../lib/run-ledger.mjs';

const T0 = Date.parse('2026-10-04T10:00:00Z');
const MIN = 60_000;

function fixture() {
  const targetChunks = Array.from({ length: 5 }, (_, c) =>
    Array.from({ length: 20 }, (_, i) => `Co${c * 20 + i}`));
  return initRun({
    runId: 'r1', now: T0, params: { x: 1 }, profileHash: 'h1',
    targetChunks, mcpQueries: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
    enabledServers: ['foundrole', 'jobdatalake'],
  });
}

test('STALE_MS is 20 minutes', () => {
  assert.equal(STALE_MS, 20 * MIN);
});

test('TASK_TEMPLATE entries carry stage/title/command/needs', () => {
  for (const t of TASK_TEMPLATE) {
    assert.ok(t.stage && t.title && t.command, t.stage);
    assert.ok(['mcp', 'none'].includes(t.needs));
  }
});

test('initRun: strictly increasing seq and ordered stages', () => {
  const { run, tasks } = fixture();
  assert.equal(run.status, 'running');
  assert.equal(run.profile_hash, 'h1');
  for (let i = 1; i < tasks.length; i++) assert.ok(tasks[i].seq > tasks[i - 1].seq);
  const stages = [];
  for (const t of tasks) if (stages.at(-1) !== t.stage) stages.push(t.stage);
  assert.deepEqual(stages, ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'E1', 'E2']);
  assert.equal(tasks.filter((t) => t.stage === 'A3').length, 2 * 5);
  assert.equal(tasks.filter((t) => t.stage === 'B2').length, 2 * 3);
  assert.ok(tasks.every((t) => t.status === 'pending' && t.attempts === 0));
  assert.ok(tasks.filter((t) => t.stage === 'A3').every((t) => t.needs === 'mcp'));
  assert.equal(tasks.find((t) => t.stage === 'A1').needs, 'none');
});

test('claimNext: first pending, then next; does not mutate input', () => {
  const { tasks } = fixture();
  const a = claimNext(tasks, { agent: 'x', now: T0 });
  assert.equal(a.task.seq, 1);
  assert.equal(a.task.status, 'in_progress');
  assert.equal(a.task.owner, 'x');
  assert.equal(a.task.attempts, 1);
  assert.equal(tasks[0].status, 'pending');
  const blocked = claimNext(a.tasks, { agent: 'y', now: T0 });
  assert.equal(blocked.task, null);
  assert.equal(blocked.blockedBy, 'T001');
  const b = claimNext(complete(a.tasks, 'T001', { now: T0 }), { agent: 'y', now: T0 });
  assert.equal(b.task.seq, 2);
});

test('claimNext: stale at 21 min re-claimed with attempts 2; 19 min not', () => {
  const { tasks } = fixture();
  let cur = tasks.slice(0, 1).map((t) => t);
  cur = claimNext(cur, { agent: 'x', now: T0 }).tasks;
  assert.equal(claimNext(cur, { agent: 'y', now: T0 + 19 * MIN }), null);
  const r = claimNext(cur, { agent: 'y', now: T0 + 21 * MIN });
  assert.equal(r.task.attempts, 2);
  assert.equal(r.task.owner, 'y');
});

test('heartbeat refreshes staleness clock', () => {
  const { tasks } = fixture();
  let cur = claimNext(tasks.slice(0, 1), { agent: 'x', now: T0 }).tasks;
  cur = heartbeat(cur, 'T001', T0 + 15 * MIN);
  assert.equal(claimNext(cur, { agent: 'y', now: T0 + 30 * MIN }), null);
  assert.ok(claimNext(cur, { agent: 'y', now: T0 + 36 * MIN }));
});

test('complete on pending throws; on in_progress records resultRef', () => {
  const { tasks } = fixture();
  assert.throws(() => complete(tasks, 'T001', { now: T0 }), /not in_progress/);
  const c = claimNext(tasks, { agent: 'x', now: T0 });
  const done = complete(c.tasks, 'T001', { now: T0 + MIN, resultRef: 'data/mcp-raw/r1/a.json' });
  assert.equal(done[0].status, 'completed');
  assert.equal(done[0].result_ref, 'data/mcp-raw/r1/a.json');
  assert.throws(() => complete(done, 'T001', { now: T0 }), /not in_progress/);
});

test('fail records note; skip works from pending', () => {
  const { tasks } = fixture();
  const c = claimNext(tasks, { agent: 'x', now: T0 });
  const f = fail(c.tasks, 'T001', { now: T0, note: 'boom' });
  assert.equal(f[0].status, 'failed');
  assert.equal(f[0].note, 'boom');
  const s = skip(tasks, 'T002', { now: T0, note: 'n/a' });
  assert.equal(s[1].status, 'skipped');
  assert.throws(() => fail(tasks, 'T001', { now: T0 }), /not in_progress/);
});

test('noMcp skips mcp tasks and claims next non-mcp task', () => {
  const { tasks } = fixture();
  // claim A1, A2 first so A3 (mcp) is next
  let cur = tasks;
  for (let i = 0; i < 2; i++) {
    const c = claimNext(cur, { agent: 'x', now: T0 });
    cur = complete(c.tasks, c.task.task_id, { now: T0 });
  }
  const r = claimNext(cur, { agent: 'nomcp', now: T0, noMcp: true });
  assert.equal(r.task.stage, 'B1');
  const deferred = r.tasks.filter((t) => t.status === 'deferred');
  assert.equal(deferred.length, 10);
  assert.ok(deferred.every((t) => t.note === 'agent has no MCP'));
  assert.equal(r.tasks.filter((t) => t.status === 'skipped').length, 0);
  assert.equal(summarize(r.tasks, T0).deferredMcp, 10);
  // an MCP-capable agent claims the lowest-seq deferred task
  const m = claimNext(complete(r.tasks, r.task.task_id, { now: T0 }), { agent: 'mcp', now: T0 });
  assert.equal(m.task.stage, 'A3');
  assert.equal(m.task.seq, deferred[0].seq);
});

test('summarize reports stale and counts', () => {
  const { tasks } = fixture();
  let cur = claimNext(tasks, { agent: 'codex', now: T0 }).tasks;
  const s0 = summarize(cur, T0 + MIN);
  assert.equal(s0.stale, 0);
  assert.equal(s0.inProgress, 1);
  const s = summarize(cur, T0 + 21 * MIN);
  assert.equal(s.stale, 1);
  assert.equal(s.total, tasks.length);
  assert.equal(s.pending, tasks.length - 1);
  assert.equal(s.lastAgent, 'codex');
  assert.equal(s.nextTask.task_id, 'T001'); // stale task has the lowest seq
  cur = complete(cur, 'T001', { now: T0 + MIN });
  assert.equal(summarize(cur, T0 + MIN).done, 1);
});

test('tsv roundtrip preserves tasks and tolerates tabs in values', () => {
  const { tasks } = fixture();
  tasks[0].note = 'a\tb\nc';
  const back = parseTasks(serializeTasks(tasks));
  assert.equal(back.length, tasks.length);
  assert.equal(back[0].note, 'a b c');
  assert.equal(back[0].seq, 1);
  assert.equal(back[0].attempts, 0);
  assert.equal(back[3].needs, 'mcp');
});

test('ownership: stale takeover blocks late calls from the old owner', () => {
  const { tasks } = fixture();
  const a = claimNext(tasks.slice(0, 1), { agent: 'A', now: T0 });
  const b = claimNext(a.tasks, { agent: 'B', now: T0 + 21 * MIN });
  assert.equal(b.task.owner, 'B');
  const hb = heartbeat(b.tasks, 'T001', T0 + 22 * MIN, { agent: 'B', attempt: 2 });
  assert.throws(() => complete(hb, 'T001', { now: T0 + 23 * MIN, agent: 'A', attempt: 1 }), /owned by B/);
  assert.throws(() => fail(hb, 'T001', { now: T0, agent: 'A' }), /owned by B/);
  assert.throws(() => heartbeat(hb, 'T001', T0, { agent: 'A' }), /owned by B/);
  assert.equal(hb[0].status, 'in_progress');
  assert.equal(hb[0].owner, 'B');
  assert.equal(hb[0].heartbeat_at, new Date(T0 + 22 * MIN).toISOString());
  assert.throws(() => complete(hb, 'T001', { now: T0, agent: 'B', attempt: 1 }), /attempt 2/);
  assert.throws(() => skip(hb, 'T001', { now: T0, agent: 'A' }), /--force/);
  assert.equal(skip(hb, 'T001', { now: T0, agent: 'A', force: true })[0].status, 'skipped');
  // owner can complete its own task
  assert.equal(complete(hb, 'T001', { now: T0 + 24 * MIN, agent: 'B', attempt: 2 })[0].status, 'completed');
});

test('initRun interpolates {run_id}/{n}/{companies} in every command', () => {
  const { tasks } = initRun({
    runId: 'R1', now: T0, enabledServers: ['s'], targetChunks: [['A']], mcpQueries: [{ id: 'q' }],
  });
  for (const t of tasks) {
    assert.ok(!t.command.includes('{run_id}') && !t.command.includes('{n}'), `${t.stage}: ${t.command}`);
  }
  assert.match(tasks.find((t) => t.stage === 'C1').command, /--run R1/);
  assert.match(tasks.find((t) => t.stage === 'A3').command, /\["A"\]/);
});

test('claimNext: lowest-seq among pending and stale (crashed task redone first)', () => {
  const { tasks } = fixture();
  let cur = claimNext(tasks, { agent: 'x', now: T0 }).tasks; // T001 in progress, then crashes
  const r = claimNext(cur, { agent: 'y', now: T0 + 25 * MIN });
  assert.equal(r.task.task_id, 'T001');
  assert.equal(r.task.attempts, 2);
});

test('claimNext: only MCP tasks remain for a no-MCP agent', () => {
  const { tasks } = initRun({ runId: 'r', now: T0, enabledServers: ['s'], targetChunks: [['A']], mcpQueries: [] });
  let cur = tasks;
  for (let i = 0; i < 2; i++) {
    const c = claimNext(cur, { agent: 'x', now: T0 });
    cur = complete(c.tasks, c.task.task_id, { now: T0 });
  }
  const r = claimNext(cur, { agent: 'n', now: T0, noMcp: true });
  assert.equal(r.task.stage, 'B1');
});

test('onlyMcp: a no-MCP agent with only deferred MCP tasks left gets {task:null, onlyMcp:N}', () => {
  const { tasks } = initRun({ runId: 'r', now: T0, enabledServers: ['s'], targetChunks: [['A']], mcpQueries: [{ id: 'q' }] });
  let cur = tasks;
  let last;
  for (let i = 0; i < 50; i++) {
    last = claimNext(cur, { agent: 'n', now: T0, noMcp: true });
    if (!last || !last.task) break;
    cur = complete(last.tasks, last.task.task_id, { now: T0 });
  }
  assert.equal(last.task, null);
  assert.equal(last.onlyMcp, 2);   // one A3 chunk + one B2 query
  assert.equal(summarize(last.tasks, T0).deferredMcp, 2);
  assert.equal(last.tasks.filter((t) => t.status === 'deferred').length, 2);
});

test('per-task stale_min: A2/B1/D1 stay live at 40 min; default tasks go stale at 21', () => {
  const { tasks } = fixture();
  assert.equal(tasks.find((t) => t.stage === 'A1').stale_min, 20);
  for (const st of ['A2', 'B1', 'D1']) assert.equal(tasks.find((t) => t.stage === st).stale_min, 60);
  const t = { ...tasks[1], status: 'in_progress', claimed_at: new Date(T0).toISOString(), heartbeat_at: new Date(T0).toISOString() };
  assert.equal(t.stage, 'A2');
  assert.equal(claimNext([t], { agent: 'y', now: T0 + 40 * MIN }), null);
  assert.ok(claimNext([t], { agent: 'y', now: T0 + 61 * MIN }));
});

test('parseTasks tolerates a tasks.tsv without stale_min; command JSON-quotes company names', () => {
  const { tasks } = fixture();
  const NL = String.fromCharCode(10); const TAB = String.fromCharCode(9);
  const text = serializeTasks(tasks).split(NL).map((l) => l.split(TAB).slice(0, -1).join(TAB)).join(NL);
  assert.equal(parseTasks(text)[0].stale_min, 20);
  const { tasks: t2 } = initRun({ runId: 'R', now: T0, enabledServers: ['s'], targetChunks: [['A, B', 'C']], mcpQueries: [] });
  assert.match(t2.find((t) => t.stage === 'A3').command, /\["A, B","C"\]/);
});

test('A1 is a preview (no --write); E2 does not record', () => {
  const { tasks } = fixture();
  assert.doesNotMatch(tasks.find((t) => t.stage === 'A1').command, /--write/);
  assert.match(tasks.find((t) => t.stage === 'E2').command, /--propose --no-record/);
  assert.match(tasks.find((t) => t.stage === 'D1').command, /batch\/batch-state\.tsv/);
});
