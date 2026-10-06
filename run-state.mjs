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
// else "unknown". Exit codes: 0 ok, 10 (status only) unfinished run, 1 error.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  initRun, claimNext, heartbeat, complete, fail, skip, summarize, hasUnfinished,
  serializeTasks, parseTasks,
} from './lib/run-ledger.mjs';

const CHUNK_SIZE = 20;

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

/** Hash of the files that define queries/filters; changes mean a resumed run is stale. */
export function computeProfileHash(root) {
  const h = createHash('sha256');
  for (const rel of ['config/profile.yml', 'portals.yml', 'data/target-companies.yml']) {
    h.update(`${rel}\0${readIf(join(root, rel))}\0`);
  }
  return h.digest('hex').slice(0, 16);
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

function companiesFromTargets(root) {
  const raw = readIf(join(root, 'data', 'target-companies.yml'));
  if (!raw) return [];
  let doc;
  try { doc = yaml.load(raw); } catch { return []; }
  const list = Array.isArray(doc) ? doc : (doc?.companies ?? doc?.targets ?? []);
  return list.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
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
        const targetChunks = spec.targetChunks ?? chunk(companiesFromTargets(root), CHUNK_SIZE);
        const runId = `${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;
        const { run, tasks } = initRun({
          runId, now, params, profileHash: computeProfileHash(root), targetChunks,
          mcpQueries: spec.mcpQueries ?? [], enabledServers: spec.enabledServers ?? [],
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
          + `${summary.nextTask ? `; next ${summary.nextTask.task_id} ${summary.nextTask.title}` : ''}`
          + `${summary.lastActive ? `; last active ${summary.lastActive} by ${summary.lastAgent}` : ''}`
          + `${profileChanged ? '; PROFILE CHANGED since init' : ''}`);
        return unfinished ? 10 : 0;
      }
      case 'claim': {
        const id = resolveRunId(root, opts);
        if (!id) return die(opts, 'no running run (node run-state.mjs init)');
        const claimed = await mutate(root, id, (tasks) => {
          const r = claimNext(tasks, { agent, now, noMcp: !!opts.noMcp });
          if (!r) return { tasks, result: null };
          finalizeIfDone(root, id, r.tasks, now);
          return { tasks: r.tasks, result: r.task };
        });
        emit(opts, { run_id: id, task: claimed }, claimed
          ? `claimed ${claimed.task_id} ${claimed.stage} ${claimed.title} (attempt ${claimed.attempts})\n${claimed.command}`
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
