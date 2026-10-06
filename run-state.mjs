#!/usr/bin/env node
// run-state.mjs — resumable, agent-agnostic pipeline run ledger CLI.
//
//   node run-state.mjs init [--spec file.json] [--params '{"k":"v"}'] [--json]
//   node run-state.mjs status [--json] [--run <id>]     exit 10 = unfinished running run
//   node run-state.mjs claim [--agent <name>] [--no-mcp] [--json] [--run <id>]
//   node run-state.mjs heartbeat <task> | complete <task> [--result-ref p]
//                      | fail <task> [--note t] | skip <task> [--note t]
//   node run-state.mjs abort [--run <id>]
//
// Data lives in {DATA_ROOT}/data/runs/{run-id}/ (run.json, tasks.tsv). Every
// mutation runs under the pipeline-lock primitive and writes atomically
// (tmp file + rename), so two agents racing on `claim` never get one task.
// Pure logic: lib/run-ledger.mjs. Agent name: --agent, else CAREER_OPS_AGENT,
// else "unknown". Exit codes: 0 ok, 10 (status only) unfinished run,
// 11 (claim only) blocked by an earlier in-progress stage, 1 error.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { createHash, randomBytes } from 'crypto';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { loadTargets, chunk } from './lib/target-companies.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  initRun, claimNext, heartbeat, complete, fail, skip, summarize, hasUnfinished,
  serializeTasks, parseTasks,
} from './lib/run-ledger.mjs';

const runsDir = (root) => join(root, 'data', 'runs');

function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      // Windows: rename over a file another process is reading can briefly EPERM/EBUSY.
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function readIf(p) {
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

function portalsPath(root) {
  const o = process.env.CAREER_OPS_PORTALS;
  return o ? resolve(root, o) : join(root, 'portals.yml');
}

function readPortals(root) {
  const raw = readIf(portalsPath(root));
  if (!raw) return { raw: '', doc: null };
  try {
    const doc = yaml.load(raw);
    return { raw, doc: doc && typeof doc === 'object' ? doc : null };
  } catch {
    return { raw, doc: null };
  }
}

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Hash of what defines queries/filters: the portals.yml filter blocks (NOT the
 * whole file: A1 edits tracked_companies mid-run), profile.yml, target list.
 * A changed hash means a resumed run is stale.
 */
export function computeProfileHash(root) {
  const h = createHash('sha256');
  const { raw, doc } = readPortals(root);
  if (doc) {
    for (const k of ['title_filter', 'location_filter', 'mcp_sources']) {
      h.update(`portals.${k}\0${stableJson(doc[k])}\0`);
    }
  } else {
    h.update(`portals.yml\0${raw}\0`);
  }
  for (const rel of ['config/profile.yml', 'data/target-companies.yml']) {
    h.update(`${rel}\0${readIf(join(root, rel))}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

/** Enabled MCP servers + query ids from portals.yml `mcp_sources` (absent = none). */
function mcpFromPortals(root) {
  const m = readPortals(root).doc?.mcp_sources;
  const enabledServers = Array.isArray(m?.enabled) ? m.enabled.map(String) : [];
  const mcpQueries = (Array.isArray(m?.queries) ? m.queries : [])
    .filter((q) => q && q.id).map((q) => ({ id: String(q.id) }));
  return { enabledServers, mcpQueries };
}

function targetChunksFromFile(root) {
  const p = join(root, 'data', 'target-companies.yml');
  if (!existsSync(p)) return [];
  try { return chunk(loadTargets(p)); } catch { return []; }
}

function listRunIds(root) {
  const d = runsDir(root);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function loadRun(root, id) {
  const dir = join(runsDir(root), id);
  try {
    return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** Explicit --run, else the latest run with status running. */
function resolveRunId(root, opts, { fallbackLatest = false } = {}) {
  if (opts.run) return opts.run;
  const ids = listRunIds(root).reverse();
  for (const id of ids) if (loadRun(root, id)?.status === 'running') return id;
  return fallbackLatest ? ids[0] ?? null : null;
}

function readTasks(root, id) {
  return parseTasks(readIf(join(runsDir(root), id, 'tasks.tsv')));
}

function writeTasks(root, id, tasks) {
  atomicWrite(join(runsDir(root), id, 'tasks.tsv'), serializeTasks(tasks));
}

function parseArgs(argv) {
  const opts = { _: [] };
  const valued = new Set(['agent', 'run', 'spec', 'params', 'note', 'result-ref', 'attempt']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (valued.has(k)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
        opts[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
        i++;
      }
      else opts[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    } else opts._.push(a);
  }
  return opts;
}

function emit(opts, obj, text) {
  if (opts.json) console.log(JSON.stringify(obj));
  else console.log(text);
}

function die(opts, msg) {
  if (opts.json) console.log(JSON.stringify({ error: msg }));
  console.error(`run-state: ${msg}`);
  return 1;
}

function finalizeIfDone(root, id, tasks, now) {
  if (hasUnfinished(tasks)) return;
  const run = loadRun(root, id);
  if (run && run.status === 'running') {
    run.status = 'completed';
    run.finished_at = now.toISOString();
    atomicWrite(join(runsDir(root), id, 'run.json'), JSON.stringify(run, null, 2));
  }
}

async function mutate(root, id, fn) {
  const dir = join(runsDir(root), id);
  if (!existsSync(join(dir, 'tasks.tsv'))) throw new Error(`no such run: ${id}`);
  return withPipelineLock(join(dir, 'tasks.tsv'), async () => {
    const before = readTasks(root, id);
    const { tasks, result } = fn(before);
    writeTasks(root, id, tasks);
    return result;
  });
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return die({ json: argv.includes('--json') }, err.message);
  }
  const [cmd, taskArg] = opts._;
  const root = getCareerOpsRoot();
  const now = new Date();
  const agent = opts.agent || process.env.CAREER_OPS_AGENT || 'unknown';

  try {
    switch (cmd) {
      case 'init': {
        mkdirSync(runsDir(root), { recursive: true });
        const existing = resolveRunId(root, {});
        if (existing) return die(opts, `run ${existing} is still running; abort it first (node run-state.mjs abort)`);
        let spec = {};
        if (opts.spec) spec = JSON.parse(readFileSync(opts.spec, 'utf-8'));
        const params = opts.params ? JSON.parse(opts.params) : (spec.params ?? {});
        const targetChunks = spec.targetChunks ?? targetChunksFromFile(root);
        const fromPortals = (spec.mcpQueries && spec.enabledServers) ? null : mcpFromPortals(root);
        const runId = `${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;
        const { run, tasks } = initRun({
          runId, now, params, profileHash: computeProfileHash(root), targetChunks,
          mcpQueries: spec.mcpQueries ?? fromPortals.mcpQueries,
          enabledServers: spec.enabledServers ?? fromPortals.enabledServers,
        });
        const dir = join(runsDir(root), runId);
        mkdirSync(dir, { recursive: true });
        writeTasks(root, runId, tasks);
        atomicWrite(join(dir, 'run.json'), JSON.stringify(run, null, 2));
        emit(opts, { run, total: tasks.length }, `initialized run ${runId} (${tasks.length} tasks)`);
        return 0;
      }
      case 'status': {
        const id = resolveRunId(root, opts, { fallbackLatest: true });
        const run = id ? loadRun(root, id) : null;
        if (!run) {
          emit(opts, { run: null, summary: null, profileChanged: false, unfinished: false }, 'no run');
          return 0;
        }
        const tasks = readTasks(root, id);
        const summary = summarize(tasks, now);
        const unfinished = run.status === 'running' && hasUnfinished(tasks);
        const profileChanged = run.profile_hash !== computeProfileHash(root);
        emit(opts, { run, summary, profileChanged, unfinished },
          `run ${id} [${run.status}] ${summary.done}/${summary.total} done, ${summary.pending} pending, `
          + `${summary.inProgress} in progress (${summary.stale} stale), ${summary.failed} failed`
          + `${summary.deferredMcp ? `, ${summary.deferredMcp} deferred (MCP)` : ''}`
          + `${summary.nextTask ? `; next ${summary.nextTask.task_id} ${summary.nextTask.title}` : ''}`
          + `${summary.lastActive ? `; last active ${summary.lastActive} by ${summary.lastAgent}` : ''}`
          + `${profileChanged ? '; PROFILE CHANGED since init' : ''}`);
        return unfinished ? 10 : 0;
      }
      case 'claim': {
        const id = resolveRunId(root, opts);
        if (!id) return die(opts, 'no running run (node run-state.mjs init)');
        const r = await mutate(root, id, (tasks) => {
          const res = claimNext(tasks, { agent, now, noMcp: !!opts.noMcp });
          if (!res) return { tasks, result: null };
          if (res.task) finalizeIfDone(root, id, res.tasks, now);
          return { tasks: res.tasks, result: res };
        });
        if (r?.blockedBy) {
          emit(opts, { run_id: id, task: null, blockedBy: r.blockedBy },
            `blocked-by ${r.blockedBy}: an earlier-stage task is still in progress; retry later`);
          return 11;
        }
        if (r && !r.task && r.onlyMcp) {
          emit(opts, { run_id: id, task: null, onlyMcp: r.onlyMcp },
            `only MCP tasks remain (${r.onlyMcp} deferred)`);
          return 0;
        }
        const claimed = r?.task ?? null;
        emit(opts, { run_id: id, task: claimed }, claimed
          ? `claimed ${claimed.task_id} ${claimed.stage} ${claimed.title} (attempt ${claimed.attempts})
${claimed.command}`
          : 'no claimable task');
        return 0;
      }
      case 'heartbeat':
      case 'complete':
      case 'fail':
      case 'skip': {
        if (!taskArg) return die(opts, `${cmd} needs a task id`);
        const id = resolveRunId(root, opts);
        if (!id) return die(opts, 'no running run');
        const who = { agent, attempt: opts.attempt };
        const ops = {
          heartbeat: (t) => heartbeat(t, taskArg, now, who),
          complete: (t) => complete(t, taskArg, { now, resultRef: opts.resultRef, ...who }),
          fail: (t) => fail(t, taskArg, { now, note: opts.note, ...who }),
          skip: (t) => skip(t, taskArg, { now, note: opts.note, agent, force: !!opts.force }),
        };
        await mutate(root, id, (tasks) => {
          const next = ops[cmd](tasks);
          if (cmd !== 'heartbeat') finalizeIfDone(root, id, next, now);
          return { tasks: next, result: null };
        });
        emit(opts, { run_id: id, task_id: taskArg, action: cmd }, `${cmd} ${taskArg} ok`);
        return 0;
      }
      case 'abort': {
        const id = resolveRunId(root, opts);
        if (!id) return die(opts, 'no running run');
        const dir = join(runsDir(root), id);
        await withPipelineLock(join(dir, 'tasks.tsv'), async () => {
          const run = loadRun(root, id);
          if (!run) throw new Error(`no such run: ${id}`);
          run.status = 'aborted';
          run.finished_at = now.toISOString();
          atomicWrite(join(dir, 'run.json'), JSON.stringify(run, null, 2));
        });
        emit(opts, { run_id: id, status: 'aborted' }, `aborted run ${id} (kept for audit)`);
        return 0;
      }
      default:
        console.error('usage: node run-state.mjs init|status|claim|heartbeat|complete|fail|skip|abort [--json] [--agent <name>] [--run <id>] [--no-mcp]');
        return 1;
    }
  } catch (err) {
    return die(opts, err.message);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
