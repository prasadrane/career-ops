// lib/run-ledger.mjs — pure logic for the resumable pipeline run ledger.
//
// The ledger is a plain task list (data/runs/{run-id}/tasks.tsv) that any agent
// mutates through run-state.mjs, so a run that one agent abandoned (token
// exhaustion) can be taken over by another. Everything here is a pure function
// over task arrays: no I/O, no clock reads — `now` is always injected.
// Mutators return NEW arrays and never edit their input.

export const DEFAULT_STALE_MIN = 20;
export const STALE_MS = DEFAULT_STALE_MIN * 60 * 1000;

export const TSV_COLUMNS = [
  'task_id', 'seq', 'stage', 'title', 'command', 'status', 'owner',
  'claimed_at', 'heartbeat_at', 'finished_at', 'attempts', 'result_ref', 'note', 'needs', 'stale_min',
];

export const STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'skipped', 'deferred'];

// Ordered template. `expand` marks stages generated once per (server x chunk)
// or per (server x query). `needs: 'mcp'` tasks are DEFERRED (not skipped) by an
// agent without MCP access (`claim --no-mcp`): they stay unfinished and an
// MCP-capable agent claims them later. `stale_min` is the per-task heartbeat
// silence after which an in_progress task is stale (default 20).
export const TASK_TEMPLATE = [
  { stage: 'A1', title: 'resolve-target-boards', command: 'node discover-ats.mjs --in data/target-companies.yml', needs: 'none' },
  { stage: 'A2', title: 'scan-target-ats', command: 'node scan.mjs --companies-from data/target-companies.yml', needs: 'none', stale_min: 60 },
  { stage: 'A3', title: 'mcp-target-{server}-chunk{n}', command: 'mode mcp-sources: sweep target chunk {n} via {server} for companies (JSON array) {companies}; write data/mcp-raw/{run_id}/', needs: 'mcp', expand: 'server-chunk' },
  { stage: 'B1', title: 'scan-broad-ats', command: 'node scan.mjs', needs: 'none', stale_min: 60 },
  { stage: 'B2', title: 'mcp-broad-{server}-{query}', command: 'mode mcp-sources: run query {query} via {server}; write data/mcp-raw/{run_id}/', needs: 'mcp', expand: 'server-query' },
  { stage: 'C1', title: 'ingest', command: 'node ingest-mcp-jobs.mjs --run {run_id}', needs: 'none' },
  { stage: 'C2', title: 'liveness-employer-confirm', command: 'node check-liveness.mjs <urls from data/pipeline.md>; confirm [?] aggregator rows at the employer (AGENTS.md Aggregator rule)', needs: 'none' },
  { stage: 'D1', title: 'triage-evaluate', command: 'mode pipeline: triage + evaluate pending rows (batch state in batch/batch-state.tsv)', needs: 'none', stale_min: 60 },
  { stage: 'D2', title: 'merge-tracker', command: 'node merge-tracker.mjs', needs: 'none' },
  { stage: 'E1', title: 'eval-pipeline', command: 'node eval-pipeline.mjs --summary', needs: 'none' },
  { stage: 'E2', title: 'write-proposals', command: 'node eval-pipeline.mjs --propose --no-record --summary (suggest-only proposals)', needs: 'none' },
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
    stale_min: spec.stale_min ?? DEFAULT_STALE_MIN,
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
            stage: t.stage, needs: t.needs, stale_min: t.stale_min,
            title: fill(t.title, { server, n: i + 1 }),
            command: fill(t.command, { server, n: i + 1, companies: JSON.stringify(chunk), run_id: runId }),
          });
        });
      }
    } else if (t.expand === 'server-query') {
      for (const server of enabledServers) {
        for (const q of mcpQueries) {
          specs.push({
            stage: t.stage, needs: t.needs, stale_min: t.stale_min,
            title: fill(t.title, { server, query: slug(q.id) }),
            command: fill(t.command, { server, query: q.id, run_id: runId }),
          });
        }
      }
    } else {
      specs.push({ stage: t.stage, title: t.title, command: fill(t.command, { run_id: runId }), needs: t.needs, stale_min: t.stale_min });
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
  const min = Number(task.stale_min) > 0 ? Number(task.stale_min) : DEFAULT_STALE_MIN;
  return toMs(now) - last > min * 60 * 1000;
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

const claimable = (t, now) => t.status === 'pending' || t.status === 'deferred' || isStale(t, now);

/** Lowest-seq task an agent could take: pending, deferred (MCP) or stale. */
function lowestClaimable(tasks, now, skipIds) {
  let best = null;
  for (const t of tasks) {
    if (skipIds.has(t.task_id) || !claimable(t, now)) continue;
    if (!best || t.seq < best.seq) best = t;
  }
  return best;
}

/**
 * Claim the lowest-seq task among pending, deferred and stale in_progress
 * (attempts + 1), so a resumer redoes a crashed task BEFORE its downstream
 * consumers. A task is refused while an earlier-stage task is non-stale
 * in_progress (blockedBy). With noMcp, needs=mcp tasks are DEFERRED (stay
 * unfinished, claimable later by an MCP-capable agent).
 * @returns {{task: object|null, tasks: object[], blockedBy?: string, onlyMcp?: number} | null}
 *   null when nothing is claimable at all.
 */
export function claimNext(tasks, { agent = 'unknown', now, noMcp = false }) {
  let cur = tasks;
  let changed = false;
  const t = iso(now);
  const passed = new Set();
  for (;;) {
    const cand = lowestClaimable(cur, now, passed);
    if (!cand) break;
    if (noMcp && cand.needs === 'mcp') {
      if (cand.status !== 'deferred') {
        cur = replaceTask(cur, cand.task_id, {
          status: 'deferred', owner: agent, finished_at: '', heartbeat_at: '', note: 'agent has no MCP',
        });
        changed = true;
      }
      passed.add(cand.task_id);
      continue;
    }
    const blocker = cur.find((x) => x.status === 'in_progress' && !isStale(x, now)
      && x.stage !== cand.stage && x.seq < cand.seq);
    if (blocker) return { task: null, tasks: cur, blockedBy: blocker.task_id };
    const attempts = Number(cand.attempts || 0) + 1;
    const next = replaceTask(cur, cand.task_id, {
      status: 'in_progress', owner: agent, claimed_at: t, heartbeat_at: t, finished_at: '', attempts,
      note: cand.status === 'deferred' ? '' : cand.note,
    });
    return { task: next.find((x) => x.task_id === cand.task_id), tasks: next };
  }
  const deferred = cur.filter((x) => x.status === 'deferred').length;
  if (noMcp && deferred > 0) return { task: null, tasks: cur, onlyMcp: deferred };
  return changed ? { task: null, tasks: cur } : null;
}

// A late call from an agent that went stale must not overwrite the agent that
// took the task over. Checked only when the caller identifies itself (agent)
// and/or the attempt it was given at claim time.
function assertOwner(task, { agent, attempt } = {}) {
  if (agent !== undefined && agent !== null && task.owner !== agent) {
    throw new Error(`task ${task.task_id} is owned by ${task.owner || 'nobody'}, not ${agent}`);
  }
  if (attempt !== undefined && attempt !== null && Number(attempt) !== Number(task.attempts)) {
    throw new Error(`task ${task.task_id} is on attempt ${task.attempts}, not ${attempt}`);
  }
}

export function heartbeat(tasks, taskId, now, who = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'in_progress') throw new Error(`task ${taskId} is ${task.status}, not in_progress`);
  assertOwner(task, who);
  return replaceTask(tasks, taskId, { heartbeat_at: iso(now) });
}

export function complete(tasks, taskId, { now, resultRef = '', agent, attempt } = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'in_progress') throw new Error(`cannot complete task ${taskId}: status is ${task.status}, not in_progress`);
  assertOwner(task, { agent, attempt });
  return replaceTask(tasks, taskId, {
    status: 'completed', finished_at: iso(now), result_ref: resultRef || task.result_ref,
  });
}

export function fail(tasks, taskId, { now, note = '', agent, attempt } = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'in_progress') throw new Error(`cannot fail task ${taskId}: status is ${task.status}, not in_progress`);
  assertOwner(task, { agent, attempt });
  return replaceTask(tasks, taskId, { status: 'failed', finished_at: iso(now), note });
}

export function skip(tasks, taskId, { now, note = '', agent, force = false } = {}) {
  const task = getTask(tasks, taskId);
  if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'deferred') {
    throw new Error(`cannot skip task ${taskId}: status is ${task.status}`);
  }
  if (task.status === 'in_progress' && !force && agent !== undefined && task.owner !== agent) {
    throw new Error(`task ${taskId} is in progress for ${task.owner || 'nobody'}; use --force to skip it as ${agent}`);
  }
  return replaceTask(tasks, taskId, { status: 'skipped', finished_at: iso(now), note });
}

export function summarize(tasks, now) {
  const count = (s) => tasks.filter((t) => t.status === s).length;
  const stale = tasks.filter((t) => isStale(t, now)).length;
  const inProgress = count('in_progress');
  const next = lowestClaimable(tasks, now, new Set());
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
    deferredMcp: count('deferred'),
    nextTask: next ? { task_id: next.task_id, stage: next.stage, title: next.title } : null,
    lastActive: lastActive || null,
    lastAgent: lastAgent || null,
  };
}

/** True when a run still has work an agent could do (pending, deferred or in_progress). */
export function hasUnfinished(tasks) {
  return tasks.some((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'deferred');
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
    t.stale_min = Number(t.stale_min) > 0 ? Number(t.stale_min) : DEFAULT_STALE_MIN;
    return t;
  });
}
