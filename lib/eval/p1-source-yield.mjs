/**
 * p1-source-yield.mjs — P1 (sources) probe: which discovery sources actually yield?
 *
 * Per source (= `portal` column of scan-history.tsv: greenhouse, lever, mcp-jobspipe, ...):
 *   seen / added (status added|unconfirmed) in the window, applied / interviews
 *   (tracker rows joined back by normalized URL), errorRate (run-ledger tasks that
 *   mention the source), lastSuccessDays, and `addedLast3Runs`.
 * Connector inventory: portals.yml `mcp_sources.enabled` vs sources that ever
 * produced a history row.
 *
 * Verdict (advisory):
 *   fail  — an enabled source errored in every one of >= ERROR_RUNS_FLOOR ledger tasks
 *   warn  — a source added 0 over the last 3 scan runs, or an enabled connector has
 *           zero rows ever ("configured but unused")
 *   pass  — otherwise; insufficient-data when there is no history and no connector
 *
 * Read-only. Full structures are in `detail`; `metrics` stays scalar for the scorecard.
 */

import { SAMPLE_FLOOR } from './verdict.mjs';
import {
  readScanHistory, readTracker, readPortals, readScanRuns, readPortalHealth, readRunLedgers, inWindow,
} from './_data.mjs';

export const LAST_RUNS = 3;              // "last 3 scan runs" window for the zero-yield warning
export const ERROR_RUNS_FLOOR = 3;       // errors in "every run" need at least this many runs to count
const YIELD_STATUSES = new Set(['added', 'unconfirmed']);
const APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'hired']);
const INTERVIEWED = new Set(['interview', 'offer', 'hired']);
const ERROR_RE = /fail|error|dead|timeout/i;
const DAY_MS = 86_400_000;

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
    return {
      id,
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
    if (s.errorRate === 1 && s.ledgerRuns >= ERROR_RUNS_FLOOR) {
      fail = true;
      findings.push(`${s.id}: errored in every one of ${s.ledgerRuns} ledger runs`);
    }
    if (s.addedLast3Runs === 0 && s.everSeen > 0) {
      warn = true;
      findings.push(`${s.id}: added 0 over the last ${LAST_RUNS} scan runs (${runDates.join(', ')})`);
    }
  }
  for (const c of unused) {
    warn = true;
    findings.push(`mcp-${c}: configured but unused (enabled in portals.yml mcp_sources, zero history rows ever)`);
  }
  if (deadBoards.length) findings.push(`dead boards (last ${LAST_RUNS} health checks not reachable): ${deadBoards.join(', ')}`);

  const hasData = history.length > 0 || connectorsConfigured.length > 0;
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
    detail: { sources, connectorsConfigured, connectorsUsed, deadBoards },
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
