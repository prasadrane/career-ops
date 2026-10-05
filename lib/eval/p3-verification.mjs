/**
 * p3-verification.mjs — P3 (liveness / dedup) probe: how much of the inbox is actually verified?
 *
 *   verifiedPct        pipeline.md rows marked `[ ]`/`[x]` (employer-confirmed path)
 *   unconfirmedPct     rows marked `[?]` (aggregator, unconfirmed) or `[!]` (JD unavailable)
 *   aggregatorOnlyPct  pipeline rows on a known aggregator URL with no employer sighting
 *                      (an `also_seen:<portal>` token whose portal is not an `mcp-*` source
 *                      counts as an employer sighting; MCP-only corroboration does not)
 *   repostRate         % of company+title keys re-listed under 2+ URLs on 2+ dates
 *   mcpLivenessAgreement  {n, agree}: MCP-supplied prediction at ingest (ghost-flagged ->
 *                      "dead", else "live") vs the later outcome recorded in the tracker
 *                      (Discarded/expired/not-found-at-employer -> dead; "active" -> live)
 *
 * Verdict is driven by unconfirmedPct (lower is better; inverted for verdict()):
 *   > 30% unconfirmed -> warn, > 60% -> fail, fewer than SAMPLE_FLOOR pipeline rows -> insufficient-data.
 * Sub-metrics below SAMPLE_FLOOR print `(n too small)`. Read-only; structures in `detail`.
 */

import { SAMPLE_FLOOR, verdict } from './verdict.mjs';
import { isAggregatorUrl } from '../../url-key.mjs';
import { readScanHistory, readPipeline, readTracker, flagList, inWindow } from './_data.mjs';

export const UNCONFIRMED_WARN_ABOVE = 0.30;   // > 30% of pipeline rows unconfirmed -> warn
export const UNCONFIRMED_FAIL_ABOVE = 0.60;   // > 60% -> fail
export const AGREEMENT_WARN_BELOW = 0.60;     // MCP liveness hints right < 60% of the time -> finding

const DEAD_RE = /\b(expired|closed|no longer|not found at employer|404|410)\b/i;
const LIVE_RE = /\b(?:liveness:?\s*)?(active|verified live|still open)\b/i;
const pct = (num, den) => Math.round((num / den) * 100);

function employerSighting(row) {
  return flagList(row).some((f) => f.startsWith('also_seen:') && !f.slice('also_seen:'.length).startsWith('mcp-'));
}

export default async function probe({ root, since }) {
  const pipeline = readPipeline(root);
  const history = readScanHistory(root).filter((h) => inWindow(h.first_seen, since));
  const tracker = readTracker(root);

  const total = pipeline.length;
  const unconfirmed = pipeline.filter((p) => p.marker === '?' || p.marker === '!').length;
  const verified = pipeline.filter((p) => p.marker === ' ' || p.marker === 'x').length;

  const histByUrl = new Map();
  for (const h of history) if (h.urlKey && !histByUrl.has(h.urlKey)) histByUrl.set(h.urlKey, h);
  const aggregatorOnly = pipeline.filter((p) => isAggregatorUrl(p.url) && !employerSighting(histByUrl.get(p.urlKey) ?? {})).length;
  const ghostFlagged = pipeline.filter((p) => flagList(histByUrl.get(p.urlKey) ?? {}).some((f) => /ghost/i.test(f))).length;

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
    const predicted = flagList(h).some((f) => /ghost/i.test(f)) ? 'dead' : 'live';
    agreeN++;
    if (predicted === outcome) agree++;
  }
  const agreementTooSmall = agreeN < SAMPLE_FLOOR;

  const findings = [];
  if (total < SAMPLE_FLOOR) findings.push(`pipeline too small for a verdict (${total} rows, need ${SAMPLE_FLOOR})`);
  else findings.push(`${unconfirmed} of ${total} pipeline rows unconfirmed (${pct(unconfirmed, total)}%); ${aggregatorOnly} aggregator-only`);
  if (ghostFlagged) findings.push(`${ghostFlagged} pipeline row(s) carry a ghost flag from ingest`);
  if (agreementTooSmall) findings.push(`MCP liveness agreement (n too small): ${agreeN} later-verified row(s), need ${SAMPLE_FLOOR}`);
  else if (agree / agreeN < AGREEMENT_WARN_BELOW) {
    findings.push(`MCP liveness agreement low: ${agree}/${agreeN} ghost/last_verified hints matched later liveness; treat MCP freshness as unreliable`);
  }

  return {
    phase: 'p3',
    verdict: verdict({
      value: total ? 1 - unconfirmed / total : NaN,
      n: total,
      warnBelow: 1 - UNCONFIRMED_WARN_ABOVE,
      failBelow: 1 - UNCONFIRMED_FAIL_ABOVE,
    }),
    metrics: {
      pipelineRows: total,
      verifiedPct: total ? pct(verified, total) : '(n too small)',
      unconfirmedPct: total ? pct(unconfirmed, total) : '(n too small)',
      aggregatorOnlyPct: total ? pct(aggregatorOnly, total) : '(n too small)',
      repostRate: keys.size < SAMPLE_FLOOR ? '(n too small)' : pct(reposted, keys.size),
      mcpAgreement: agreementTooSmall ? '(n too small)' : pct(agree, agreeN),
    },
    findings,
    detail: {
      ghostFlagged,
      mcpLivenessAgreement: {
        n: agreeN,
        agree,
        verdict: agreementTooSmall ? 'insufficient-data'
          : agree / agreeN >= AGREEMENT_WARN_BELOW ? 'pass' : 'warn',
      },
    },
  };
}
