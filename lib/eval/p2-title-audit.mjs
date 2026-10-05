/**
 * p2-title-audit.mjs — P2 (search filter) probe: is title_filter / are the queries pulling the right roles?
 *
 *   precision  = kept titles that scored >= 3.5 / kept titles that were evaluated
 *                (history rows passing the CURRENT title_filter, joined to tracker rows by
 *                normalized URL; percent; "(n too small)" below SAMPLE_FLOOR evaluated)
 *   recallSample = titles the filter DROPPED that share >= 2 keywords with a title the user
 *                Applied to or scored >= 4.0. Evidence for the user to review, never an
 *                instruction: the probe is read-only and never edits portals.yml.
 *   perQuery   = per history `query_id`: seen / added / evaluated / applied.
 *
 * Dropped titles come ONLY from data/eval/dropped-titles.tsv, the bounded near-miss log
 * scan.mjs and ingest-mcp-jobs.mjs append to (lib/eval/_dropped-titles.mjs: titles the
 * filter dropped that share >= 1 keyword with the profile target roles). scan-history holds
 * kept postings only, so re-running the filter over it could never find a false negative.
 * No log file (or no rows) -> recall is `insufficient-data`; precision is still computed.
 *
 * Verdict is precision only; the recall sample is a finding. Full structures in `detail`.
 */

import { SAMPLE_FLOOR, verdict } from './verdict.mjs';
import { buildTitleFilter } from '../../title-keywords.mjs';
import { readScanHistory, readTracker, readPortals, readDroppedTitles, inWindow } from './_data.mjs';
import { keywords } from './_dropped-titles.mjs';

export const GOOD_SCORE = 3.5;            // an evaluated kept title "worked" at this score or above
export const STRONG_SCORE = 4.0;          // tracker rows at/above this seed the recall keyword set
export const PRECISION_WARN_BELOW = 0.4;  // < 40% of evaluated kept titles scored well -> warn
export const PRECISION_FAIL_BELOW = 0.2;  // < 20% -> fail
export const MIN_SHARED_KEYWORDS = 2;
export const RECALL_SAMPLE_MAX = 20;

const KEPT_STATUSES = new Set(['added', 'unconfirmed']);
const APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'hired']);
export { keywords };

export default async function probe({ root, since }) {
  const history = readScanHistory(root).filter((h) => inWindow(h.first_seen, since));
  const tracker = readTracker(root);
  const filter = buildTitleFilter(readPortals(root).title_filter);

  const trackerByUrl = new Map();
  for (const t of tracker) if (t.urlKey && !trackerByUrl.has(t.urlKey)) trackerByUrl.set(t.urlKey, t);
  const isApplied = (t) => APPLIED.has(String(t.status ?? '').trim().toLowerCase());

  // --- precision ---
  const kept = history.filter((h) => KEPT_STATUSES.has(h.status) && filter(h.title));
  const evaluated = kept.map((h) => trackerByUrl.get(h.urlKey)).filter((t) => t && Number.isFinite(t.scoreNum));
  const good = evaluated.filter((t) => t.scoreNum >= GOOD_SCORE).length;
  const precisionRatio = evaluated.length ? good / evaluated.length : NaN;
  const tooSmall = evaluated.length < SAMPLE_FLOOR;

  // --- recall sample ---
  const refs = tracker
    .filter((t) => isApplied(t) || (Number.isFinite(t.scoreNum) && t.scoreNum >= STRONG_SCORE))
    .map((t) => ({ role: t.role, kw: keywords(t.role) }))
    .filter((r) => r.kw.size >= MIN_SHARED_KEYWORDS);
  const dropped = readDroppedTitles(root).filter((d) => inWindow(d.date, since));
  const seenDropped = new Set();
  const recallSample = [];
  for (const d of dropped) {
    const key = `${d.title}|${d.company}`.toLowerCase();
    if (seenDropped.has(key)) continue;
    seenDropped.add(key);
    const kw = keywords(d.title);
    let best = null;
    for (const r of refs) {
      const shared = [...kw].filter((k) => r.kw.has(k));
      if (shared.length >= MIN_SHARED_KEYWORDS && (!best || shared.length > best.shared.length)) best = { shared, role: r.role };
    }
    if (best) {
      recallSample.push({ title: d.title, company: d.company, reason: `shares ${best.shared.join(', ')} with "${best.role}"` });
      if (recallSample.length >= RECALL_SAMPLE_MAX) break;
    }
  }
  const recallInsufficient = dropped.length === 0;

  // --- per query ---
  const queries = new Map();
  for (const h of history) {
    const q = queries.get(h.query_id) ?? { query_id: h.query_id, seen: 0, added: 0, evaluated: 0, applied: 0 };
    q.seen++;
    if (KEPT_STATUSES.has(h.status)) q.added++;
    const t = trackerByUrl.get(h.urlKey);
    if (t) {
      if (Number.isFinite(t.scoreNum)) q.evaluated++;
      if (isApplied(t)) q.applied++;
    }
    queries.set(h.query_id, q);
  }
  const perQuery = [...queries.values()].sort((a, b) => a.query_id.localeCompare(b.query_id));

  const findings = [];
  if (tooSmall) findings.push(`precision (n too small): ${evaluated.length} evaluated kept titles, need ${SAMPLE_FLOOR}`);
  else findings.push(`precision ${Math.round(precisionRatio * 100)}% (${good}/${evaluated.length} kept titles scored >= ${GOOD_SCORE})`);
  if (recallInsufficient) findings.push('recall insufficient-data: no dropped near-miss titles logged yet (data/eval/dropped-titles.tsv)');
  if (recallSample.length) {
    findings.push(`${recallSample.length} dropped title(s) resemble roles you applied to or scored >= ${STRONG_SCORE}; review (nothing was changed):`);
    for (const s of recallSample.slice(0, 5)) findings.push(`  "${s.title}" @ ${s.company || '?'} - ${s.reason}`);
  }

  return {
    phase: 'p2',
    verdict: verdict({ value: precisionRatio, n: evaluated.length, warnBelow: PRECISION_WARN_BELOW, failBelow: PRECISION_FAIL_BELOW }),
    metrics: {
      precision: tooSmall ? '(n too small)' : Math.round(precisionRatio * 100),
      evaluated: evaluated.length,
      kept: kept.length,
      recallSample: recallInsufficient ? 'insufficient-data' : recallSample.length,
      droppedLogged: dropped.length,
      queries: perQuery.filter((q) => q.query_id).length,
    },
    findings,
    detail: { recallSample, perQuery },
  };
}
