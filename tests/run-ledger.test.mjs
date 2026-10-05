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
  const b = claimNext(a.tasks, { agent: 'y', now: T0 });
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
  const skipped = r.tasks.filter((t) => t.status === 'skipped');
  assert.equal(skipped.length, 10);
  assert.ok(skipped.every((t) => t.note === 'agent has no MCP'));
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
  assert.equal(s.nextTask.task_id, 'T002');
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
