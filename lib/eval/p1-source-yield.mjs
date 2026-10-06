/**
 * p1-source-yield.mjs — P1 (sources) probe: which discovery sources actually yield?
 *
 * Per source (= `portal` column of scan-history.tsv: greenhouse, lever, mcp-jobspipe, ...):
 *   seen / added (status added|unconfirmed) in the window, applied / interviews
 *   (tracker rows joined back by normalized URL), errorRate (run-ledger tasks that
 *   mention the source), lastSuccessDays, and `addedLast3Runs`.
 * MCP ingest outcome: ingest-mcp-jobs.mjs appends one row per server per run (and an error row per errored/empty
 * file) to data/eval/mcp-ingest.tsv. An enabled server whose LATEST ingest run has an error row or saw nothing is
 * `error`/`empty` regardless of ledger history (covers a standalone mcp-sources run with no ledger). `dupes_existing`
 * counts rows the server returned that were already known (ATS overlap).
 * Connector inventory: portals.yml `mcp_sources.enabled` vs sources that ever
 * produced a history row.
 *
 * Verdict (advisory):
 *   fail  — an enabled source errored in every one of >= ERROR_RUNS_FLOOR ledger tasks
 *   fail  — also: an enabled server's latest ingest run errored AND it never ingested successfully before
 *   warn  — a source added 0 over the last 3 scan runs, an enabled connector has
 *           zero rows ever ("configured but unused"), or its latest ingest run errored / came back empty
 *   pass  — otherwise; insufficient-data when there is no history and no connector
 *
 * Signal limits (honest): per-source errorRate exists only for mcp-* sources and is inferred from
 * run-ledger task text (stage/title/command) mentioning the server name; non-MCP sources have
 * errorRate null. Tracker rows join to a source only via a URL column or the linked report's
 * `**URL:**` header. "Last 3 runs" = history rows dated on the last 3 distinct scan-runs dates.
 *
 * Read-only. Full structures are in `detail`; `metrics` stays scalar for the scorecard.
 */

import { SAMPLE_FLOOR } from './verdict.mjs';
import {
  readScanHistory, readTracker, readPortals, readScanRuns, readPortalHealth, readRunLedgers, readMcpIngest, inWindow,
} from './_data.mjs';

export const LAST_RUNS = 3;              // "last 3 scan runs" window for the zero-yield warning
export const ERROR_RUNS_FLOOR = 3;       // errors in "every run" need at least this many runs to count
const YIELD_STATUSES = new Set(['added', 'unconfirmed']);
const APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'hired']);
const INTERVIEWED = new Set(['interview', 'offer', 'hired']);
const ERROR_RE = /fail|error|dead|timeout/i;
const DAY_MS = 86_400_000;
const HARD_INGEST_ERRORS = new Set(['malformed-json', 'unreadable', 'no-valid-rows', 'unknown-server']);
const num = (v) => Number(v) || 0;

/**
 * mcp-ingest.tsv rows -> Map<server, {state, runId, files, seen, added, unconfirmed, dupesExisting,
 * dupesExistingRecent, errorReasons, priorSuccess}>. Latest run = the run_id of the newest row for that server.
 */
function ingestByServer(rows) {
  const byServer = new Map();
  for (const r of rows) {
    if (!r.server) continue;
    if (!byServer.has(r.server)) byServer.set(r.server, []);
    byServer.get(r.server).push(r);
  }
  const out = new Map();
  for (const [server, list] of byServer) {
    const runs = [];
    for (const r of list) if (!runs.includes(r.run_id)) runs.push(r.run_id);   // file order = chronological
    const latestId = runs[runs.length - 1];
    const latest = list.filter((r) => r.run_id === latestId);
    const errorReasons = latest.map((r) => r.error_reason).filter(Boolean);
    const seen = latest.filter((r) => !r.error_reason).reduce((a, r) => a + num(r.seen), 0);
    const recent = new Set(runs.slice(-LAST_RUNS));
    const state = errorReasons.some((e) => HARD_INGEST_ERRORS.has(e)) ? 'error' : seen === 0 ? 'empty' : 'ok';
    out.set(server, {
      state, runId: latestId,
      files: latest.filter((r) => !r.error_reason).reduce((a, r) => a + num(r.files), 0),
      seen,
      added: latest.reduce((a, r) => a + num(r.added), 0),
      unconfirmed: latest.reduce((a, r) => a + num(r.unconfirmed), 0),
      dupesExisting: latest.reduce((a, r) => a + num(r.dupes_existing), 0),
      dupesExistingRecent: list.filter((r) => recent.has(r.run_id)).reduce((a, r) => a + num(r.dupes_existing), 0),
      errorReasons,
      priorSuccess: list.some((r) => r.run_id !== latestId && !r.error_reason && num(r.seen) > 0),
    });
  }
  return out;
}

const dayOf = (s) => String(s ?? '').slice(0, 10);

/** Last N distinct scan-run dates (YYYY-MM-DD), newest last; fewer than N -> []. */
function lastRunDates(scanRuns, n = LAST_RUNS) {
  const dates = [...new Set(scanRuns.map((r) => dayOf(r.timestamp)).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)))].sort();
  return dates.length >= n ? dates.slice(-n) : [];
}

export default async function probe({ root, since, now = new Date() }) {
  const history = readScanHistory(root);
  const portals = readPortals(root);
  const scanRuns = readScanRuns(root);
  const tracker = readTracker(root);
  const ledgers = readRunLedgers(root);
  const deadBoards = deadBoardsFrom(readPortalHealth(root));
  const ingest = ingestByServer(readMcpIngest(root));

  const enabledMcp = (Array.isArray(portals?.mcp_sources?.enabled) ? portals.mcp_sources.enabled : [])
    .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase());
  const runDates = lastRunDates(scanRuns);

  // url -> portal (first sighting wins) for joining tracker rows back to a source.
  const portalByUrl = new Map();
  for (const h of history) if (h.urlKey && !portalByUrl.has(h.urlKey)) portalByUrl.set(h.urlKey, h.portal);

  const ids = new Set(history.map((h) => h.portal).filter(Boolean));
  for (const m of enabledMcp) ids.add(`mcp-${m}`);

  const sources = [...ids].sort().map((id) => {
    const all = history.filter((h) => h.portal === id);
    const win = all.filter((h) => inWindow(h.first_seen, since));
    const added = win.filter((h) => YIELD_STATUSES.has(h.status));
    const joined = tracker.filter((t) => t.urlKey && portalByUrl.get(t.urlKey) === id);
    const status = (t) => String(t.status ?? '').trim().toLowerCase();
    const lastYield = all.filter((h) => YIELD_STATUSES.has(h.status))
      .map((h) => Date.parse(h.first_seen)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const bare = id.replace(/^mcp-/, '');
    const mine = id.startsWith('mcp-')
      ? ledgers.filter((l) => `${l.stage} ${l.title} ${l.command}`.toLowerCase().includes(bare))
      : [];
    const failed = mine.filter((l) => ERROR_RE.test(l.status ?? '')).length;
    const ing = id.startsWith('mcp-') ? ingest.get(bare) : undefined;
    return {
      id,
      ingest: ing ?? null,
      state: ing && ing.state !== 'ok' ? ing.state : null,
      seen: win.length,
      added: added.length,
      applied: joined.filter((t) => APPLIED.has(status(t))).length,
      interviews: joined.filter((t) => INTERVIEWED.has(status(t))).length,
      errorRate: mine.length ? failed / mine.length : null,
      ledgerRuns: mine.length,
      lastSuccessDays: lastYield === undefined ? null : Math.max(0, Math.floor((now.getTime() - lastYield) / DAY_MS)),
      addedLast3Runs: runDates.length
        ? all.filter((h) => YIELD_STATUSES.has(h.status) && runDates.includes(dayOf(h.first_seen))).length
        : null,
      everSeen: all.length,
    };
  });

  const connectorsConfigured = [...new Set(enabledMcp)].sort();
  const connectorsUsed = connectorsConfigured.filter((c) => history.some((h) => h.portal === `mcp-${c}`));
  const unused = connectorsConfigured.filter((c) => !connectorsUsed.includes(c));

  const findings = [];
  let fail = false;
  let warn = false;
  for (const s of sources) {
    if (enabledMcp.includes(s.id.replace(/^mcp-/, '')) && s.id.startsWith('mcp-') && s.errorRate === 1 && s.ledgerRuns >= ERROR_RUNS_FLOOR) {
      fail = true;
      findings.push(`${s.id}: errored in every one of ${s.ledgerRuns} ledger runs`);
    }
    if (s.addedLast3Runs === 0 && s.everSeen > 0) {
      warn = true;
      findings.push(`${s.id}: added 0 over the last ${LAST_RUNS} scan runs (${runDates.join(', ')})`);
    }
    if (s.ingest && enabledMcp.includes(s.id.replace(/^mcp-/, ''))) {
      if (s.ingest.state !== 'ok') {
        const hardFail = s.ingest.state === 'error' && !s.ingest.priorSuccess;
        if (hardFail) fail = true; else warn = true;
        findings.push(`${s.id}: latest ingest run ${s.ingest.runId} is ${s.ingest.state}${s.ingest.errorReasons.length ? ` (${[...new Set(s.ingest.errorReasons)].join(', ')})` : ' (saw no rows)'}${hardFail ? ' and it never ingested successfully before' : ''}`);
      }
      if (s.ingest.dupesExistingRecent > 0) {
        findings.push(`${s.id}: overlaps existing ATS coverage (${s.ingest.dupesExistingRecent} row(s) already known over the last ${LAST_RUNS} ingest runs)`);
      }
    }
  }
  for (const c of unused) {
    warn = true;
    findings.push(`mcp-${c}: configured but unused (enabled in portals.yml mcp_sources, zero history rows ever)`);
  }
  if (deadBoards.length) findings.push(`dead boards (last ${LAST_RUNS} health checks not reachable): ${deadBoards.join(', ')}`);

  const hasData = history.length > 0 || connectorsConfigured.length > 0 || ingest.size > 0;
  const verdict = !hasData ? 'insufficient-data' : fail ? 'fail' : warn ? 'warn' : 'pass';
  if (!hasData) findings.push('no scan history and no enabled MCP sources');
  else if (!runDates.length) findings.push(`fewer than ${LAST_RUNS} scan runs recorded: zero-yield check skipped`);
  const totalApplied = sources.reduce((a, s) => a + s.applied, 0);
  if (totalApplied < SAMPLE_FLOOR) findings.push(`applied/interview yield per source (n too small: ${totalApplied} applied)`);

  return {
    phase: 'p1',
    verdict,
    metrics: {
      sources: sources.length,
      connectorsConfigured: connectorsConfigured.length,
      connectorsUsed: connectorsUsed.length,
      deadBoards: deadBoards.length,
      seen: sources.reduce((a, s) => a + s.seen, 0),
      added: sources.reduce((a, s) => a + s.added, 0),
    },
    findings,
    detail: { sources, connectorsConfigured, connectorsUsed, deadBoards, mcpIngest: Object.fromEntries(ingest) },
  };
}

/** Companies whose last LAST_RUNS portal-health rows were all neither reachable nor empty. */
function deadBoardsFrom(health) {
  const byCo = new Map();
  for (const h of health) {
    if (!h.company) continue;
    if (!byCo.has(h.company)) byCo.set(h.company, []);
    byCo.get(h.company).push(h.status);
  }
  return [...byCo].filter(([, st]) => st.length >= LAST_RUNS
    && st.slice(-LAST_RUNS).every((s) => s !== 'reachable' && s !== 'empty')).map(([c]) => c).sort();
}
