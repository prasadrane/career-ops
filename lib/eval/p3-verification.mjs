/**
 * p3-verification.mjs — P3 (liveness / dedup) probe: how much of the inbox is confirmed, and is there any
 * real liveness evidence behind it?
 *
 * Pipeline metrics are computed over the `## Pending` section of pipeline.md ONLY (processed rows are history):
 *   employerDirectPct  pending rows marked `[ ]`/`[x]` (employer-direct path). This is NOT verification:
 *                      a `[ ]` row has not been liveness-checked just because it is not an aggregator row.
 *   unconfirmedPct     pending rows marked `[?]` (aggregator, unconfirmed) or `[!]` (JD unavailable)
 *   aggregatorOnlyPct  pending rows on a known aggregator URL with no employer sighting
 *                      (an `also_seen:<portal>` token whose portal is not an `mcp-*` source
 *                      counts as an employer sighting; MCP-only corroboration does not)
 *   repostRate         % of company+title keys re-listed under 2+ URLs on 2+ dates
 *   livenessEvidence   count of REAL posting-liveness signals: tracker notes/status carrying a liveness outcome
 *                      (check-liveness `liveness: active`, expired/closed/not-found-at-employer) and processed
 *                      pipeline rows WITH a report link (`#NNN`). portal-health.tsv rows are NOT counted: every
 *                      scan writes one per board, so they prove board reachability, not posting liveness (kept
 *                      in `detail.livenessEvidence.boardReachability` only)
 *   mcpLivenessAgreement  {n, agree}: MCP-supplied hint stored at ingest in scan-history `trust_flags`
 *                      (`ghost:<score>` with score >= GHOST_DEAD_AT, or a bare `ghost` -> "dead";
 *                      `last_verified:<date>` -> "live"; rows with neither are skipped) vs the later outcome
 *                      recorded in the tracker (Discarded/expired/not-found-at-employer -> dead; "active" -> live)
 *
 * Verdict is driven by unconfirmedPct (lower is better; inverted for verdict()):
 *   > 30% unconfirmed -> warn, > 60% -> fail, fewer than SAMPLE_FLOOR pending rows -> insufficient-data.
 *   NO liveness evidence at all -> insufficient-data regardless (the findings say why): an unverified inbox
 *   must not read as `pass`.
 * Sub-metrics below SAMPLE_FLOOR print `(n too small)`. Read-only; structures in `detail`.
 *
 * Signal limits (honest): the ghost/last_verified tokens are written by ingest-mcp-jobs.mjs (scan.mjs
 * formatScanHistoryRow); portal-health.tsv is per company/board, not per posting, so it is reported as
 * board reachability only and never lifts the no-evidence gate.
 */

import { SAMPLE_FLOOR, verdict } from './verdict.mjs';
import { isAggregatorUrl } from '../../url-key.mjs';
import { readScanHistory, readPipeline, readTracker, readPortalHealth, flagList, inWindow } from './_data.mjs';

export const UNCONFIRMED_WARN_ABOVE = 0.30;   // > 30% of pending rows unconfirmed -> warn
export const UNCONFIRMED_FAIL_ABOVE = 0.60;   // > 60% -> fail
export const AGREEMENT_WARN_BELOW = 0.60;     // MCP liveness hints right < 60% of the time -> finding
export const GHOST_DEAD_AT = 50;              // `ghost:<score>` at/above this (0-100; 0-1 scores are scaled) reads as dead

const DEAD_RE = /(?<![$\d])\b(expired|closed|no longer (?:available|accepting)|not found at employer|404|410)\b/i;
const LIVE_RE = /liveness:\s*(?:active|live)\b|verified live|still open/i;
const pct = (num, den) => Math.round((num / den) * 100);

function employerSighting(row) {
  return flagList(row).some((f) => f.startsWith('also_seen:') && !f.slice('also_seen:'.length).startsWith('mcp-'));
}

/** `ghost:<score>` (score >= GHOST_DEAD_AT) or a bare `ghost` flag. */
function ghostDead(flags) {
  return flags.some((f) => {
    if (/^ghost$/i.test(f)) return true;
    const m = /^ghost:(\d+(?:\.\d+)?)$/i.exec(f);
    if (!m) return false;
    const n = Number(m[1]);
    return (n <= 1 ? n * 100 : n) >= GHOST_DEAD_AT;
  });
}
const hasLastVerified = (flags) => flags.some((f) => /^last_verified(?::.*)?$/i.test(f));

export default async function probe({ root, since }) {
  const pipeline = readPipeline(root);
  const pending = pipeline.filter((p) => p.section === 'pending');
  const history = readScanHistory(root).filter((h) => inWindow(h.first_seen, since));
  const tracker = readTracker(root);
  const health = readPortalHealth(root).filter((h) => inWindow(h.timestamp, since));

  const total = pending.length;
  const unconfirmed = pending.filter((p) => p.marker === '?' || p.marker === '!').length;
  const employerDirect = total - unconfirmed;

  const histByUrl = new Map();
  for (const h of history) if (h.urlKey && !histByUrl.has(h.urlKey)) histByUrl.set(h.urlKey, h);
  const aggregatorOnly = pending.filter((p) => isAggregatorUrl(p.url) && !employerSighting(histByUrl.get(p.urlKey) ?? {})).length;
  const ghostFlagged = pending.filter((p) => ghostDead(flagList(histByUrl.get(p.urlKey) ?? {}))).length;

  // real liveness evidence
  const processedWithReport = pipeline.filter((p) => p.section === 'processed' && p.marker === 'x' && /#\d+|reports\//.test(p.text)).length;
  const trackerOutcomes = tracker.filter((t) => DEAD_RE.test(`${t.status} ${t.notes}`) || LIVE_RE.test(String(t.notes))).length;
  const livenessEvidence = processedWithReport + trackerOutcomes;

  // repost rate: company+title identity listed under 2+ distinct URLs on 2+ distinct dates
  const keys = new Map();
  for (const h of history) {
    if (!h.title) continue;
    const k = `${h.company}|${h.title}`.toLowerCase();
    const e = keys.get(k) ?? { urls: new Set(), dates: new Set() };
    e.urls.add(h.urlKey || h.url);
    e.dates.add(String(h.first_seen).slice(0, 10));
    keys.set(k, e);
  }
  const reposted = [...keys.values()].filter((e) => e.urls.size >= 2 && e.dates.size >= 2).length;

  // MCP liveness agreement
  const trackerByUrl = new Map();
  for (const t of tracker) if (t.urlKey && !trackerByUrl.has(t.urlKey)) trackerByUrl.set(t.urlKey, t);
  let agreeN = 0;
  let agree = 0;
  for (const h of history.filter((r) => r.portal.startsWith('mcp-'))) {
    const t = trackerByUrl.get(h.urlKey);
    if (!t) continue;
    const text = `${t.status} ${t.notes}`;
    const outcome = DEAD_RE.test(text) ? 'dead' : LIVE_RE.test(String(t.notes)) ? 'live' : null;
    if (!outcome) continue;
    const flags = flagList(h);
    const signal = ghostDead(flags) ? 'dead' : hasLastVerified(flags) ? 'live' : null;
    if (!signal) continue;                 // no usable ghost / last_verified hint on this row: nothing to agree with
    agreeN++;
    if (signal === outcome) agree++;
  }
  const agreementTooSmall = agreeN < SAMPLE_FLOOR;

  const findings = [];
  if (livenessEvidence === 0) {
    findings.push('no liveness evidence yet (no check-liveness outcomes in tracker notes, no processed pipeline rows with a report link; board reachability alone does not count): inbox verification cannot be judged');
  }
  if (total < SAMPLE_FLOOR) findings.push(`pending inbox too small for a verdict (${total} rows, need ${SAMPLE_FLOOR})`);
  else findings.push(`${unconfirmed} of ${total} pending rows unconfirmed (${pct(unconfirmed, total)}%); ${aggregatorOnly} aggregator-only`);
  if (ghostFlagged) findings.push(`${ghostFlagged} pending row(s) carry a high ghost score from ingest`);
  if (agreementTooSmall) findings.push(`MCP liveness agreement (n too small): ${agreeN} later-verified row(s), need ${SAMPLE_FLOOR}`);
  else if (agree / agreeN < AGREEMENT_WARN_BELOW) {
    findings.push(`MCP liveness agreement low: ${agree}/${agreeN} ghost/last_verified hints matched later liveness; treat MCP freshness as unreliable`);
  }

  const base = verdict({
    value: total ? 1 - unconfirmed / total : NaN,
    n: total,
    warnBelow: 1 - UNCONFIRMED_WARN_ABOVE,
    failBelow: 1 - UNCONFIRMED_FAIL_ABOVE,
  });

  return {
    phase: 'p3',
    verdict: livenessEvidence === 0 ? 'insufficient-data' : base,
    metrics: {
      pipelineRows: total,
      employerDirectPct: total < SAMPLE_FLOOR ? '(n too small)' : pct(employerDirect, total),
      unconfirmedPct: total < SAMPLE_FLOOR ? '(n too small)' : pct(unconfirmed, total),
      aggregatorOnlyPct: total < SAMPLE_FLOOR ? '(n too small)' : pct(aggregatorOnly, total),
      repostRate: keys.size < SAMPLE_FLOOR ? '(n too small)' : pct(reposted, keys.size),
      mcpAgreement: agreementTooSmall ? '(n too small)' : pct(agree, agreeN),
      livenessEvidence,
    },
    findings,
    detail: {
      ghostFlagged,
      livenessEvidence: { processedWithReport, trackerOutcomes, boardReachability: health.length /* board reachability, not posting liveness */ },
      mcpLivenessAgreement: {
        n: agreeN,
        agree,
        verdict: agreementTooSmall ? 'insufficient-data'
          : agree / agreeN >= AGREEMENT_WARN_BELOW ? 'pass' : 'warn',
      },
    },
  };
}
