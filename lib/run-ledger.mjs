// lib/run-ledger.mjs — pure logic for the resumable pipeline run ledger.
//
// The ledger is a plain task list (data/runs/{run-id}/tasks.tsv) that any agent
// mutates through run-state.mjs, so a run that one agent abandoned (token
// exhaustion) can be taken over by another. Everything here is a pure function
// over task arrays: no I/O, no clock reads — `now` is always injected.
// Mutators return NEW arrays and never edit their input.

export const STALE_MS = 20 * 60 * 1000;

export const TSV_COLUMNS = [
  'task_id', 'seq', 'stage', 'title', 'command', 'status', 'owner',
  'claimed_at', 'heartbeat_at', 'finished_at', 'attempts', 'result_ref', 'note', 'needs',
];

export const STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];

// Ordered template. `expand` marks stages generated once per (server x chunk)
// or per (server x query). `needs: 'mcp'` tasks can be skipped by an agent
// without MCP access (`claim --no-mcp`).
export const TASK_TEMPLATE = [
  { stage: 'A1', title: 'resolve-target-boards', command: 'node run-state.mjs heartbeat; see modes/run.md stage A1', needs: 'none' },
  { stage: 'A2', title: 'scan-target-ats', command: 'node scan.mjs --targets-only', needs: 'none' },
  { stage: 'A3', title: 'mcp-target-{server}-chunk{n}', command: 'modes/mcp-sources.md target {server} {companies}', needs: 'mcp', expand: 'server-chunk' },
  { stage: 'B1', title: 'scan-broad-ats', command: 'node scan.mjs', needs: 'none' },
  { stage: 'B2', title: 'mcp-broad-{server}-{query}', command: 'modes/mcp-sources.md broad {server} {query}', needs: 'mcp', expand: 'server-query' },
  { stage: 'C1', title: 'ingest', command: 'node ingest-mcp-jobs.mjs --run', needs: 'none' },
  { stage: 'C2', title: 'liveness-employer-confirm', command: 'node check-liveness.mjs', needs: 'none' },
  { stage: 'D1', title: 'triage-evaluate', command: 'modes/pipeline.md (batch + data/batch-state.tsv)', needs: 'none' },
  { stage: 'D2', title: 'merge-tracker', command: 'node merge-tracker.mjs', needs: 'none' },
  { stage: 'E1', title: 'eval-pipeline', command: 'node eval-pipeline.mjs', needs: 'none' },
  { stage: 'E2', title: 'write-proposals', command: 'modes/eval.md proposals', needs: 'none' },
];

export function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) throw new Error(`invalid time: ${String(now)}`);
  return ms;
}

const iso = (now) => new Date(toMs(now)).toISOString();

function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function blankTask(taskId, seq, spec) {
  return {
    task_id: taskId, seq, stage: spec.stage, title: spec.title, command: spec.command,
    status: 'pending', owner: '', claimed_at: '', heartbeat_at: '', finished_at: '',
    attempts: 0, result_ref: '', note: '', needs: spec.needs,
  };
}

/**
 * Build the run record and its ordered task list.
 * @returns {{run: object, tasks: object[]}}
 */
export function initRun({ runId, now, params = {}, profileHash = '', targetChunks = [], mcpQueries = [], enabledServers = [] }) {
  const specs = [];
  for (const t of TASK_TEMPLATE) {
    if (t.expand === 'server-chunk') {
      for (const server of enabledServers) {
        targetChunks.forEach((chunk, i) => {
          specs.push({
            stage: t.stage, needs: t.needs,
            title: fill(t.title, { server, n: i + 1 }),
            command: fill(t.command, { server, companies: chunk.join(',') }),
          });
        });
      }
    } else if (t.expand === 'server-query') {
      for (const server of enabledServers) {
        for (const q of mcpQueries) {
          specs.push({
            stage: t.stage, needs: t.needs,
            title: fill(t.title, { server, query: slug(q.id) }),
            command: fill(t.command, { server, query: q.id }),
          });
        }
      }
    } else {
      specs.push({ stage: t.stage, title: t.title, command: t.command, needs: t.needs });
    }
  }
  const tasks = specs.map((s, i) => blankTask(`T${String(i + 1).padStart(3, '0')}`, i + 1, s));
  const run = {
    run_id: runId,
    started_at: iso(now),
    mode: 'full-pipeline',
    profile_hash: profileHash,
    params,
    status: 'running',
  };
  return { run, tasks };
}

export function isStale(task, now) {
  if (task.status !== 'in_progress') return false;
  const last = Date.parse(task.heartbeat_at || task.claimed_at);
  if (Number.isNaN(last)) return true;
  return toMs(now) - last > STALE_MS;
}

function replaceTask(tasks, taskId, patch) {
  let found = false;
  const out = tasks.map((t) => {
    if (t.task_id !== taskId) return t;
    found = true;
    return { ...t, ...patch };
  });
  if (!found) throw new Error(`unknown task: ${taskId}`);
  return out;
}

function getTask(tasks, taskId) {
  const t = tasks.find((x) => x.task_id === taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  return t;
}

/**
 * Take the first pending task, else the first stale in_progress one
 * (attempts + 1). With noMcp, needs=mcp tasks are marked skipped instead.
 * @returns {{task: object, tasks: object[]} | null}  null when nothing claimable.
 *   If tasks were skipped but nothing was claimed, returns {task: null, tasks}.
 */
export function claimNext(tasks, { agent = 'unknown', now, noMcp = false }) {
  let cur = tasks;
  let skippedAny = false;
  const t = iso(now);
  for (;;) {
    const cand = cur.find((x) => x.status === 'pending') || cur.find((x) => isStale(x, now));
    if (!cand) break;
    if (noMcp && cand.needs === 'mcp') {
      cur = replaceTask(cur, cand.task_id, {
        status: 'skipped', finished_at: t, owner: agent, note: 'agent has no MCP',
      });
      skippedAny = true;
      continue;
    }
    const attempts = Number(cand.attempts || 0) + 1;
    const next = replaceTask(cur, cand.task_id, {
      status: 'in_progress', owner: agent, claimed_at: t, heartbeat_at: t, finished_at: '', attempts,
    });
    return { task: next.find((x) => x.task_id === cand.task_id), tasks: next };
  }
  return skippedAny ? { task: null, tasks: cur } : null;
}

export function heartbeat(tasks, taskId, now) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'in_progress') throw new Error(`task ${taskId} is ${task.status}, not in_progress`);
  return replaceTask(tasks, taskId, { heartbeat_at: iso(now) });
}

export function complete(tasks, taskId, { now, resultRef = '' } = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'in_progress') throw new Error(`cannot complete task ${taskId}: status is ${task.status}, not in_progress`);
  return replaceTask(tasks, taskId, {
    status: 'completed', finished_at: iso(now), result_ref: resultRef || task.result_ref,
  });
}

export function fail(tasks, taskId, { now, note = '' } = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'in_progress') throw new Error(`cannot fail task ${taskId}: status is ${task.status}, not in_progress`);
  return replaceTask(tasks, taskId, { status: 'failed', finished_at: iso(now), note });
}

export function skip(tasks, taskId, { now, note = '' } = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'pending' && task.status !== 'in_progress') {
    throw new Error(`cannot skip task ${taskId}: status is ${task.status}`);
  }
  return replaceTask(tasks, taskId, { status: 'skipped', finished_at: iso(now), note });
}

export function summarize(tasks, now) {
  const count = (s) => tasks.filter((t) => t.status === s).length;
  const stale = tasks.filter((t) => isStale(t, now)).length;
  const inProgress = count('in_progress');
  const next = tasks.find((t) => t.status === 'pending') || tasks.find((t) => isStale(t, now)) || null;
  let lastActive = '';
  let lastAgent = '';
  for (const t of tasks) {
    for (const ts of [t.claimed_at, t.heartbeat_at, t.finished_at]) {
      if (ts && (!lastActive || Date.parse(ts) > Date.parse(lastActive))) {
        lastActive = ts;
        lastAgent = t.owner || '';
      }
    }
  }
  return {
    total: tasks.length,
    done: count('completed') + count('skipped'),
    pending: count('pending'),
    inProgress,
    stale,
    failed: count('failed'),
    nextTask: next ? { task_id: next.task_id, stage: next.stage, title: next.title } : null,
    lastActive: lastActive || null,
    lastAgent: lastAgent || null,
  };
}

/** True when a run still has work an agent could do (pending or in_progress). */
export function hasUnfinished(tasks) {
  return tasks.some((t) => t.status === 'pending' || t.status === 'in_progress');
}

// --- TSV (de)serialisation -------------------------------------------------

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

export function serializeTasks(tasks) {
  const lines = [TSV_COLUMNS.join('\t')];
  for (const t of tasks) lines.push(TSV_COLUMNS.map((c) => clean(t[c])).join('\t'));
  return `${lines.join('\n')}\n`;
}

export function parseTasks(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const t = {};
    header.forEach((h, i) => { t[h] = cells[i] ?? ''; });
    t.seq = Number(t.seq);
    t.attempts = Number(t.attempts || 0);
    if (!t.needs) t.needs = 'none';
    return t;
  });
}
