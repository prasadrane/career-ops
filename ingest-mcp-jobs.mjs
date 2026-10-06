#!/usr/bin/env node
// ingest-mcp-jobs.mjs - deterministic ingester for job postings the AGENT fetched from
// MCP job-search servers (JobsPipe, JobDataLake, FoundRole).
//
//   node ingest-mcp-jobs.mjs --run <run-id> [--dry-run]
//   node ingest-mcp-jobs.mjs --confirm <aggregator-url> <employer-url> [--dry-run]
//   node ingest-mcp-jobs.mjs --stale <aggregator-url> [--dry-run]
// --confirm / --stale resolve one `- [?]` row of data/pipeline.md deterministically (the
// agent never hand-edits it): confirm rewrites it to `- [ ]` on the employer URL (aggregator
// URL kept as provenance) and logs scan-history `added`; stale moves it to Processed and
// logs `skipped_expired` (note `not found at employer`). Exit 1 when no `[?]` row matches.
//
// Reads data/mcp-raw/{run-id}/*.json (envelope shape: see lib/mcp-adapters.mjs),
// normalizes each row, then applies the SAME filters and dedup scan.mjs applies
// (blacklist, title_filter, location_filter, URL + company/role dedup, cooldown)
// and writes through scan.mjs's canonical writers:
//   - data/scan-history.tsv  portal = mcp-{server}, trailing query_id column
//   - data/pipeline.md       `- [ ]` rows (employer-direct) or `- [?]` rows (aggregator)
//   - data/scan-runs.tsv     one row, existing columns only (see "scan-runs" below)
// No LLM, no network. --dry-run computes and prints the summary and writes nothing.
//
// Prints one JSON object:
//   {seen, filtered:{title,location,blacklist,cooldown}, dupes, added, unconfirmed,
//    errors:[{server, reason}]}
//   reason: empty | malformed-json | no-valid-rows | unknown-server | unreadable | no-raw-dir
// Per-file problems never fail the run (exit 0): the other servers still ingest and the
// problem is listed in `errors` so the scorecard shows that source as error/empty.
// A missing or empty raw directory is `seen: 0` + errors [{reason: 'no-raw-dir'}], exit 0.
// Exit 1 only on usage errors (missing --run).
//
// Aggregator rule (AGENTS.md): a posting is UNCONFIRMED (status `unconfirmed`, `[?]`
// marker, counted in `unconfirmed`, never in `added`) when the adapter says so
// (FoundRole), the URL is on a known aggregator (url-key.mjs / data-static list), or the
// employer is unidentified (empty company). `[?]` rows are not evaluable pending items
// until the employer is confirmed. A listing of a job already present from an
// employer-direct source (this run or a prior one) is absorbed as a dupe instead.
//
// Cross-source credit: when two sources return the same posting one row is written and
// the other source is recorded as `also_seen:{portal}` in the history trust_flags column
// and in the pipeline note.
//
// scan-runs: scan-runs.tsv is read BY COLUMN NAME and stats.mjs excludes rows wider than
// the header, so a new `portal_kind` column would silently drop every row. Instead the
// row uses the existing columns (companies=0, boards=0, found=seen) and the MCP origin is
// recoverable from scan-history `portal` / `query_id`.
//
// Untrusted data: raw text is copied only into the NormalizedJob fields, written through
// the sanitizing scan.mjs writers, and never interpreted.
//
// Not applied (not part of the output contract): posting-age, salary, visa and content
// filters (MCP queries already carry max_age_days/min_salary_usd; no JD body is fetched).
// Cooldown-skipped rows are counted but not written to scan-history, unlike scan.mjs.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import {
  PORTALS_PATH,
  SCAN_RUNS_PATH,
  appendScanRunSummary,
  appendToPipeline,
  atomicWriteFile,
  PIPELINE_PATH,
  SCAN_HISTORY_PATH,
  sanitizeMarkdownField,
  sanitizePipelineUrl,
  appendToScanHistory,
  buildCompanyCanonicalizer,
  buildCooldownFilter,
  buildLocationFilter,
  checkAggregatorRepost,
  companyRoleDedupKey,
  findBlacklistEntry,
  loadAggregatorDomains,
  loadBlacklist,
  loadDedupSnapshot,
  loadReApplyWindows,
  matchesSeenCompanyRole,
  normalizeUrlForDedup,
  recordRequisition,
  requisitionIdsForDedup,
  resolveDedupIncludeLocation,
  scanHistoryPolicy,
} from './scan.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { isAggregatorUrl } from './url-key.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { recordDroppedTitle } from './lib/eval/_dropped-titles.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { normalizeJobsPipe, normalizeJobDataLake, normalizeFoundRole, rawRowCount } from './lib/mcp-adapters.mjs';

const USAGE = 'Usage: node ingest-mcp-jobs.mjs --run <run-id> [--dry-run]\n       node ingest-mcp-jobs.mjs --confirm <aggregator-url> <employer-url> [--dry-run]\n       node ingest-mcp-jobs.mjs --stale <aggregator-url> [--dry-run]';
const KNOWN_FLAGS = ['--run', '--confirm', '--stale', '--dry-run', '--help', '-h'];

const ADAPTERS = {
  jobspipe: normalizeJobsPipe,
  jobdatalake: normalizeJobDataLake,
  foundrole: normalizeFoundRole,
};

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Server label safe to echo in `errors` (raw file content is untrusted). */
function safeServer(name) {
  const s = String(name ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]{1,40}$/.test(s) ? s : 'unknown';
}

/** {server, queryId} implied by `{server}-{query_id}.json`. */
function fromFilename(file) {
  const stem = file.replace(/\.json$/i, '');
  const i = stem.indexOf('-');
  return i === -1
    ? { server: stem, queryId: '' }
    : { server: stem.slice(0, i), queryId: stem.slice(i + 1) };
}

function readPortalsConfig() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (err) {
    throw new Error(`failed to parse ${PORTALS_PATH}: ${err.message}`);
  }
}

/**
 * Read + normalize every data/mcp-raw/{run}/*.json. Never throws on a bad file.
 * @returns {{jobs: object[], errors: {server: string, reason: string}[], files: number, serverFiles: Map<string, number>}}
 */
export function loadRun(runDir) {
  const jobs = [];
  const errors = [];
  const serverFiles = new Map();   // safe server label -> file count (incl. errored files)
  const files = readdirSync(runDir).filter((f) => /\.json$/i.test(f)).sort();
  for (const file of files) {
    const hint = fromFilename(file);
    const countFile = (srv) => serverFiles.set(safeServer(srv), (serverFiles.get(safeServer(srv)) ?? 0) + 1);
    let text;
    try {
      text = readFileSync(path.join(runDir, file), 'utf-8');
    } catch {
      countFile(hint.server);
      errors.push({ server: safeServer(hint.server), reason: 'unreadable' });
      continue;
    }
    if (!text.trim()) {
      countFile(hint.server);
      errors.push({ server: safeServer(hint.server), reason: 'empty' });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      countFile(hint.server);
      errors.push({ server: safeServer(hint.server), reason: 'malformed-json' });
      continue;
    }
    const envelopeServer = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.server === 'string' && raw.server.trim()
      ? raw.server.trim().toLowerCase()
      : '';
    const server = envelopeServer || hint.server.toLowerCase();
    countFile(server);
    const adapter = Object.hasOwn(ADAPTERS, server) ? ADAPTERS[server] : null;
    if (!adapter) {
      errors.push({ server: safeServer(server), reason: 'unknown-server' });
      continue;
    }
    const queryId = (raw && typeof raw === 'object' && typeof raw.query_id === 'string' && raw.query_id.trim())
      ? raw.query_id.trim()
      : hint.queryId;
    const normalized = adapter(raw, queryId);
    if (normalized.length === 0) {
      errors.push({ server, reason: rawRowCount(raw) === 0 ? 'empty' : 'no-valid-rows' });
      continue;
    }
    jobs.push(...normalized);
  }
  return { jobs, errors, files: files.length, serverFiles };
}

function postedAtMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Filter + dedup + build writer-ready offers. Pure apart from reading the dedup sources.
 * @returns {{summary: object, live: object[], unconfirmed: object[]}}
 */
export function plan(jobs, config, { today }) {
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const blacklist = loadBlacklist();
  const cooldownFilter = buildCooldownFilter(loadReApplyWindows(), today);
  const aggregatorDomains = loadAggregatorDomains();
  const canonicalize = buildCompanyCanonicalizer(config.company_aliases);
  const includeLocation = resolveDedupIncludeLocation(config);
  const snap = loadDedupSnapshot(scanHistoryPolicy(config), canonicalize, { includeLocation });
  const seenRequisitions = snap.seenCompanyRoleRequisitions ?? new Map();
  const locatedRequisitions = snap.locatedRequisitionsByBase ?? new Map();

  const isAggregator = (j) => j.aggregator === true
    || !j.company
    || isAggregatorUrl(j.url)
    || checkAggregatorRepost({ url: j.url }, aggregatorDomains) !== null;

  // Employer-direct postings first, so an aggregator copy of the same job is absorbed
  // into them whichever server listed it first.
  const ordered = jobs.map((j) => ({ job: j, aggregator: isAggregator(j) }))
    .sort((a, b) => Number(a.aggregator) - Number(b.aggregator));

  const perServer = new Map();
  const bump = (job, key) => {
    const srv = String(job.source ?? '').replace(/^mcp-/, '') || 'unknown';
    const e = perServer.get(srv) ?? { seen: 0, added: 0, unconfirmed: 0, dupes_existing: 0 };
    e[key]++;
    perServer.set(srv, e);
  };
  for (const j of jobs) bump(j, 'seen');
  const summary = { seen: jobs.length, filtered: { title: 0, location: 0, blacklist: 0, cooldown: 0 }, dupes: 0, added: 0, unconfirmed: 0 };
  const runByUrl = new Map();
  const runByKey = new Map();
  // Aggregator rows by company+role, kept apart from runByKey and NEVER fed into
  // snap.seenCompanyRoles: it only credits aggregator-vs-aggregator duplicates, so a
  // later employer-direct row is still added normally.
  const aggByKey = new Map();
  const entries = [];

  const credit = (entry, source) => {
    if (source !== entry.job.source) entry.alsoSeen.add(source);
  };

  for (const { job, aggregator } of ordered) {
    if (blacklist.size > 0 && findBlacklistEntry(blacklist, job.company, job.url)) { summary.filtered.blacklist++; continue; }
    if (!titleFilter(job.title)) { summary.filtered.title++; (summary.droppedTitles ??= []).push(job); continue; }
    if (!locationFilter(job.location, job.url, job.title)) { summary.filtered.location++; continue; }

    const dedupUrl = normalizeUrlForDedup(job.url);
    const baseKey = companyRoleDedupKey(job.company, job.title, canonicalize);
    const key = includeLocation ? companyRoleDedupKey(job.company, job.title, canonicalize, job.location) : baseKey;
    const requisition = requisitionIdsForDedup({ url: job.url, text: job.title });

    // 1. Already ingested earlier in this run (any source): credit it, count a dupe.
    const sameUrl = runByUrl.get(dedupUrl);
    const sameRole = job.company ? (runByKey.get(key) || (aggregator ? aggByKey.get(key) : undefined)) : undefined;
    if (sameUrl || sameRole) { credit(sameUrl || sameRole, job.source); summary.dupes++; continue; }
    // 2. Seen in a previous run / the tracker. Employer-direct rows are compared by
    // URL and company+role; an aggregator copy is compared by URL AND absorbed into a
    // known company+role (a confirmed employer posting already exists).
    if (snap.seen.has(dedupUrl)) { summary.dupes++; bump(job, 'dupes_existing'); continue; }
    if (job.company && matchesSeenCompanyRole({ key, baseKey, seen: snap.seenCompanyRoles, requisitions: seenRequisitions, locatedRequisitions }, requisition)) {
      summary.dupes++;
      bump(job, 'dupes_existing');
      continue;
    }
    if (cooldownFilter(job).skip) { summary.filtered.cooldown++; continue; }

    const entry = { job, aggregator, alsoSeen: new Set() };
    entries.push(entry);
    runByUrl.set(dedupUrl, entry);
    if (!aggregator && job.company) {
      runByKey.set(key, entry);
      snap.seenCompanyRoles.add(key);
      recordRequisition(seenRequisitions, key, requisition);
    }
    if (aggregator && job.company) aggByKey.set(key, entry);
    snap.seen.add(dedupUrl);
    if (aggregator) { summary.unconfirmed++; bump(job, 'unconfirmed'); } else { summary.added++; bump(job, 'added'); }
  }

  const toOffer = ({ job, aggregator, alsoSeen }) => {
    const also = [...alsoSeen];
    const note = [
      aggregator ? 'unconfirmed: aggregator listing, locate at employer' : '',
      `${job.source} q:${job.query_id || '-'}`,
      also.length ? `also seen: ${also.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return {
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      source: job.source,
      postedAt: postedAtMs(job.posted_at),
      queryId: job.query_id,
      sourceSignals: job.source_signals,
      alsoSeen: also,
      unconfirmed: aggregator,
      note,
    };
  };
  return {
    summary,
    perServer,
    live: entries.filter((e) => !e.aggregator).map(toOffer),
    unconfirmed: entries.filter((e) => e.aggregator).map(toOffer),
  };
}

const INGEST_TSV_HEADER = 'timestamp\trun_id\tserver\tfiles\tseen\tadded\tdupes_existing\tunconfirmed\terror_reason\n';

/**
 * Append the per-server ingest outcome to data/eval/mcp-ingest.tsv (read by the P1
 * eval probe): one row per server seen in the run dir, plus one error row (with
 * its reason) per errored/empty file. Never throws: a log failure must not fail ingest.
 */
async function recordIngestRows({ runId, serverFiles, errors, perServer }) {
  if (process.env.CAREER_OPS_NO_EVAL_LOG === '1') return;
  try {
    const file = path.join(getCareerOpsRoot(), 'data', 'eval', 'mcp-ingest.tsv');
    const ts = new Date().toISOString();
    const rows = [];
    for (const srv of [...serverFiles.keys()].sort()) {
      const c = perServer.get(srv) ?? { seen: 0, added: 0, unconfirmed: 0, dupes_existing: 0 };
      rows.push([ts, runId, srv, serverFiles.get(srv), c.seen, c.added, c.dupes_existing, c.unconfirmed, '']);
    }
    for (const e of errors) rows.push([ts, runId, e.server, 1, 0, 0, 0, 0, e.reason]);
    if (!rows.length) return;
    await withPipelineLock(file, () => {
      mkdirSync(path.dirname(file), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, INGEST_TSV_HEADER);
      appendFileSync(file, rows.map((r) => r.join('\t')).join('\n') + '\n');
    });
  } catch { /* advisory log only */ }
}

export async function ingestRun({ runId, dryRun = false }) {
  const runDir = path.join(getCareerOpsRoot(), 'data', 'mcp-raw', runId);
  // A run whose MCP tasks never wrote raw files (no MCP agent, quiet run) is not an
  // error: report an empty ingest with a `no-raw-dir` note and write nothing.
  const hasRaw = existsSync(runDir) && statSync(runDir).isDirectory()
    && readdirSync(runDir).some((f) => /\.json$/i.test(f));
  if (!hasRaw) {
    return {
      seen: 0, filtered: { title: 0, location: 0, blacklist: 0, cooldown: 0 },
      dupes: 0, added: 0, unconfirmed: 0, errors: [{ server: 'none', reason: 'no-raw-dir' }],
    };
  }
  const config = readPortalsConfig();
  const { jobs, errors, files, serverFiles } = loadRun(runDir);
  const date = localToday();
  const { summary, live, unconfirmed, perServer } = plan(jobs, config, { today: date });

  const droppedTitles = summary.droppedTitles ?? [];
  delete summary.droppedTitles;   // not part of the CLI's JSON summary

  if (!dryRun) {
    for (const j of droppedTitles) {
      await recordDroppedTitle({ root: getCareerOpsRoot(), title: j.title, company: j.company, portal: j.source, url: j.url, date });
    }
    await recordIngestRows({ runId, serverFiles, errors, perServer });
    if (live.length > 0) await appendToScanHistory(live, date, 'added');
    if (unconfirmed.length > 0) await appendToScanHistory(unconfirmed, date, 'unconfirmed');
    if (live.length + unconfirmed.length > 0) await appendToPipeline([...live, ...unconfirmed]);
    await withPipelineLock(SCAN_RUNS_PATH, () => appendScanRunSummary({
      timestamp: new Date().toISOString(),
      // Quiet queries (all files empty) are valid; only unreadable/malformed/unusable files fail a run.
      status: files > 0 && errors.length === files && errors.some((e) => e.reason !== 'empty') ? 'failed' : 'completed',
      companies: 0,
      boards: 0,
      found: summary.seen,
      filteredTitle: summary.filtered.title,
      filteredTier: 0,
      filteredLocation: summary.filtered.location,
      filteredPostingAge: 0,
      filteredSalary: 0,
      filteredContent: 0,
      filteredCooldown: summary.filtered.cooldown,
      dupes: summary.dupes,
      newAdded: summary.added + summary.unconfirmed,
      errors: errors.length,
      filteredBlacklist: summary.filtered.blacklist,
    }));
  }
  return { ...summary, errors };
}

// --- deterministic [?] resolution (replaces hand-editing data/pipeline.md) ---------------

const UNCONFIRMED_ROW_RE = /^(\s*-\s*)\[\?\]\s*(\S+)(.*)$/;
const PROCESSED_HEADER_RE = /^##\s+(Processed|Procesadas)\s*$/i;

/** Portal (`mcp-foundrole`, ...) the history first recorded for a URL; '' when unknown. */
function historyPortalFor(url) {
  const want = normalizeUrlForDedup(url);
  try {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split(/\r?\n/)) {
      const c = line.split('\t');
      if (c[0] && normalizeUrlForDedup(c[0]) === want && c[2]) return c[2];
    }
  } catch { /* no history yet */ }
  return '';
}

function findUnconfirmed(lines, url) {
  const want = normalizeUrlForDedup(url);
  for (let i = 0; i < lines.length; i++) {
    const m = UNCONFIRMED_ROW_RE.exec(lines[i]);
    if (m && normalizeUrlForDedup(m[2]) === want) return { index: i, match: m };
  }
  return null;
}

function rowParts(m) {
  const parts = `${m[2]}${m[3]}`.split(' | ').map((p) => p.trim());
  return { url: parts[0], company: parts[1] ?? '', title: parts[2] ?? '', rest: parts.slice(3) };
}

/**
 * Resolve one `- [?]` aggregator row in data/pipeline.md.
 *  mode 'confirm': rewrite to `- [ ]` on the employer URL (provenance note keeps the
 *                  aggregator URL) + scan-history row for the employer URL, status `added`.
 *  mode 'stale':   move the row to Processed as a struck-through line + scan-history
 *                  row for the aggregator URL, status `skipped_expired`.
 * Locked + atomic like every other pipeline writer. Throws {notFound:true} when the URL
 * has no `[?]` row.
 */
export async function resolveUnconfirmed({ mode, url, employerUrl, dryRun = false, pipelinePath = PIPELINE_PATH }) {
  let result;
  await withPipelineLock(pipelinePath, async () => {
    const text = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const hit = findUnconfirmed(lines, url);
    if (!hit) throw Object.assign(new Error(`no [?] row for ${url} in ${pipelinePath}`), { notFound: true });
    const row = rowParts(hit.match);
    if (mode === 'confirm') {
      const rest = row.rest.filter((p) => !/^note:/i.test(p));
      rest.push(`note: via ${sanitizeMarkdownField(url)}; confirmed at employer`);
      lines[hit.index] = `${hit.match[1]}[ ] ${[sanitizePipelineUrl(employerUrl), row.company, row.title, ...rest].join(' | ')}`;
      result = { action: 'confirm', url, employer_url: employerUrl, company: row.company, title: row.title };
    } else {
      lines.splice(hit.index, 1);
      const struck = `- [x] ~~${[row.url, row.company, row.title].filter(Boolean).join(' | ')}~~ — not found at employer (mcp ingest)`;
      const procIdx = lines.findIndex((l) => PROCESSED_HEADER_RE.test(l));
      if (procIdx === -1) {
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push('', '## Processed', '', struck, '');
      } else {
        let end = lines.findIndex((l, i) => i > procIdx && /^##\s/.test(l));
        if (end === -1) end = lines.length;
        let at = end;
        while (at - 1 > procIdx && lines[at - 1] === '') at--;
        lines.splice(at, 0, struck);
      }
      result = { action: 'stale', url, company: row.company, title: row.title };
    }
    if (!dryRun) atomicWriteFile(pipelinePath, lines.join(eol));
  });
  result.dry_run = dryRun;
  if (!dryRun) {
    const date = localToday();
    if (mode === 'confirm') {
      await appendToScanHistory([{
        url: employerUrl, title: result.title, company: result.company,
        source: historyPortalFor(url) || 'mcp-confirm', historyFlags: ['confirmed_from:aggregator'],
      }], date, 'added');
    } else {
      await appendToScanHistory([{
        url, title: result.title, company: result.company,
        source: historyPortalFor(url) || 'mcp-confirm', historyFlags: ['note:not_found_at_employer'],
      }], date, 'skipped_expired');
    }
  }
  return result;
}

async function resolveMain(args) {
  const dryRun = hasFlag(args, '--dry-run');
  let mode;
  let url;
  let employerUrl;
  if (hasFlag(args, '--confirm')) {
    mode = 'confirm';
    url = flagValue(args, '--confirm');
    const i = args.indexOf('--confirm');
    employerUrl = args[i + 2];
    if (!url || !employerUrl || employerUrl.startsWith('-') || !/^https?:\/\//i.test(employerUrl)) {
      console.error(`Error: --confirm needs <aggregator-url> <employer-url> (employer URL must be http(s)).\n${USAGE}`);
      return 1;
    }
    if (isAggregatorUrl(employerUrl)) {
      console.error(`Error: ${employerUrl} is an aggregator URL; --confirm needs the employer's own careers/ATS URL.`);
      return 1;
    }
  } else {
    mode = 'stale';
    url = flagValue(args, '--stale');
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    console.error(`Error: a http(s) URL is required.\n${USAGE}`);
    return 1;
  }
  try {
    console.log(JSON.stringify(await resolveUnconfirmed({ mode, url, employerUrl, dryRun }), null, 2));
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--run', '--confirm', '--stale'], requireOperand: true });
  if (hasFlag(args, '--confirm') || hasFlag(args, '--stale')) return resolveMain(args);
  const runId = flagValue(args, '--run');
  if (!hasFlag(args, '--run') || !runId || !RUN_ID_RE.test(runId)) {
    console.error(`Error: --run <run-id> is required (letters, digits, . _ -).\n${USAGE}`);
    return 1;
  }
  try {
    const result = await ingestRun({ runId, dryRun: hasFlag(args, '--dry-run') });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
