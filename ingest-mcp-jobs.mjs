#!/usr/bin/env node
// ingest-mcp-jobs.mjs - deterministic ingester for job postings the AGENT fetched from
// MCP job-search servers (JobsPipe, JobDataLake, FoundRole).
//
//   node ingest-mcp-jobs.mjs --run <run-id> [--dry-run]
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
//   reason: empty | malformed-json | no-valid-rows | unknown-server | unreadable
// Per-file problems never fail the run (exit 0): the other servers still ingest and the
// problem is listed in `errors` so the scorecard shows that source as error/empty.
// Exit 1 only on usage errors (missing --run, no such run directory).
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

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import {
  PORTALS_PATH,
  SCAN_RUNS_PATH,
  appendScanRunSummary,
  appendToPipeline,
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
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { normalizeJobsPipe, normalizeJobDataLake, normalizeFoundRole, rawRowCount } from './lib/mcp-adapters.mjs';

const USAGE = 'Usage: node ingest-mcp-jobs.mjs --run <run-id> [--dry-run]';
const KNOWN_FLAGS = ['--run', '--dry-run', '--help', '-h'];

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
 * @returns {{jobs: object[], errors: {server: string, reason: string}[], files: number}}
 */
export function loadRun(runDir) {
  const jobs = [];
  const errors = [];
  const files = readdirSync(runDir).filter((f) => /\.json$/i.test(f)).sort();
  for (const file of files) {
    const hint = fromFilename(file);
    let text;
    try {
      text = readFileSync(path.join(runDir, file), 'utf-8');
    } catch {
      errors.push({ server: safeServer(hint.server), reason: 'unreadable' });
      continue;
    }
    if (!text.trim()) {
      errors.push({ server: safeServer(hint.server), reason: 'empty' });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      errors.push({ server: safeServer(hint.server), reason: 'malformed-json' });
      continue;
    }
    const envelopeServer = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.server === 'string' && raw.server.trim()
      ? raw.server.trim().toLowerCase()
      : '';
    const server = envelopeServer || hint.server.toLowerCase();
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
  return { jobs, errors, files: files.length };
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

  const summary = { seen: jobs.length, filtered: { title: 0, location: 0, blacklist: 0, cooldown: 0 }, dupes: 0, added: 0, unconfirmed: 0 };
  const runByUrl = new Map();
  const runByKey = new Map();
  const entries = [];

  const credit = (entry, source) => {
    if (source !== entry.job.source) entry.alsoSeen.add(source);
  };

  for (const { job, aggregator } of ordered) {
    if (blacklist.size > 0 && findBlacklistEntry(blacklist, job.company, job.url)) { summary.filtered.blacklist++; continue; }
    if (!titleFilter(job.title)) { summary.filtered.title++; continue; }
    if (!locationFilter(job.location, job.url, job.title)) { summary.filtered.location++; continue; }

    const dedupUrl = normalizeUrlForDedup(job.url);
    const baseKey = companyRoleDedupKey(job.company, job.title, canonicalize);
    const key = includeLocation ? companyRoleDedupKey(job.company, job.title, canonicalize, job.location) : baseKey;
    const requisition = requisitionIdsForDedup({ url: job.url, text: job.title });

    // 1. Already ingested earlier in this run (any source): credit it, count a dupe.
    const sameUrl = runByUrl.get(dedupUrl);
    const sameRole = job.company ? runByKey.get(key) : undefined;
    if (sameUrl || sameRole) { credit(sameUrl || sameRole, job.source); summary.dupes++; continue; }
    // 2. Seen in a previous run / the tracker. Employer-direct rows are compared by
    // URL and company+role; an aggregator copy is compared by URL AND absorbed into a
    // known company+role (a confirmed employer posting already exists).
    if (snap.seen.has(dedupUrl)) { summary.dupes++; continue; }
    if (job.company && matchesSeenCompanyRole({ key, baseKey, seen: snap.seenCompanyRoles, requisitions: seenRequisitions, locatedRequisitions }, requisition)) {
      summary.dupes++;
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
    snap.seen.add(dedupUrl);
    if (aggregator) summary.unconfirmed++; else summary.added++;
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
      alsoSeen: also,
      unconfirmed: aggregator,
      note,
    };
  };
  return {
    summary,
    live: entries.filter((e) => !e.aggregator).map(toOffer),
    unconfirmed: entries.filter((e) => e.aggregator).map(toOffer),
  };
}

export async function ingestRun({ runId, dryRun = false }) {
  const runDir = path.join(getCareerOpsRoot(), 'data', 'mcp-raw', runId);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw Object.assign(new Error(`no such run directory: ${runDir}`), { usage: true });
  }
  const config = readPortalsConfig();
  const { jobs, errors, files } = loadRun(runDir);
  const date = localToday();
  const { summary, live, unconfirmed } = plan(jobs, config, { today: date });

  if (!dryRun) {
    if (live.length > 0) await appendToScanHistory(live, date, 'added');
    if (unconfirmed.length > 0) await appendToScanHistory(unconfirmed, date, 'unconfirmed');
    if (live.length + unconfirmed.length > 0) await appendToPipeline([...live, ...unconfirmed]);
    await withPipelineLock(SCAN_RUNS_PATH, () => appendScanRunSummary({
      timestamp: new Date().toISOString(),
      status: files > 0 && errors.length === files ? 'failed' : 'completed',
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

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--run'], requireOperand: true });
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
