/**
 * _dropped-titles.mjs — bounded near-miss log for the P2 recall probe.
 *
 * scan.mjs and ingest-mcp-jobs.mjs only COUNT titles rejected by title_filter, so nothing
 * could ever show a false negative. recordDroppedTitle() appends the interesting ones —
 * dropped titles that share >= 1 keyword with the user's profile target roles — to
 *   <dataRoot>/data/eval/dropped-titles.tsv   (date \t portal \t company \t title \t url, no header)
 * which lib/eval/p2-title-audit.mjs reads. Callers invoke it only on the title-drop branch
 * (an optional `titleFilter` predicate is honoured as a double check).
 *
 * Bounded: above MAX_LINES the file is trimmed to the newest KEEP_LINES. Deduped on
 * normalized url + title against the last KEEP_LINES rows. Serialized with the same lock
 * idiom as portal-health.tsv. NEVER throws: a failure is reported on stderr and scanning
 * continues. CAREER_OPS_NO_EVAL_LOG=1 disables it.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { withPortalHealthLock } from '../../portal-health-lock.mjs';
import { resolveProfileKeywords } from '../../providers/_profile-keywords.mjs';
import normalizeUrl from '../../url-key.mjs';

export const MAX_LINES = 3000;
export const KEEP_LINES = 2000;
export const DROPPED_TITLES_REL = join('data', 'eval', 'dropped-titles.tsv');

// Seniority / generic words carry no role signal: sharing them must not count as overlap.
const STOP = new Set(['the', 'and', 'for', 'of', 'to', 'in', 'at', 'a', 'an', 'with', 'remote', 'senior', 'sr', 'jr',
  'junior', 'lead', 'staff', 'principal', 'head', 'director', 'manager', 'engineer', 'engineering', 'ii', 'iii', 'iv', 'i']);

export function keywords(title) {
  return new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length >= 2 && !STOP.has(t)));
}

const profileCache = new Map();
function profileKeywordSet(root, given) {
  if (Array.isArray(given)) return keywords(given.join(' '));
  if (!profileCache.has(root)) {
    const p = process.env.CAREER_OPS_PROFILE || join(root, 'config', 'profile.yml');
    profileCache.set(root, keywords(resolveProfileKeywords(p).join(' ')));
  }
  return profileCache.get(root);
}

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const dedupKey = (url, title) => `${normalizeUrl(url) || clean(url)}|${clean(title).toLowerCase()}`;

/**
 * @param {{root:string,title:string,company?:string,portal?:string,url?:string,date?:string}} entry
 * @param {{profileKeywords?:string[], titleFilter?:(t:string)=>boolean}} [opts]
 * @returns {Promise<boolean>} true when a row was appended
 */
export async function recordDroppedTitle(entry, { profileKeywords, titleFilter } = {}) {
  try {
    if (process.env.CAREER_OPS_NO_EVAL_LOG === '1') return false;
    const { root, title } = entry ?? {};
    if (!root || !title) return false;
    if (typeof titleFilter === 'function' && titleFilter(title)) return false;   // kept, not dropped
    const profile = profileKeywordSet(root, profileKeywords);
    if (![...keywords(title)].some((k) => profile.has(k))) return false;

    const file = join(root, DROPPED_TITLES_REL);
    mkdirSync(dirname(file), { recursive: true });
    // Same sanitizer scan-history uses (formula-prefix guard); lazy import avoids a cycle with scan.mjs.
    const { sanitizeTsvField } = await import('../../scan.mjs');
    const cell = (v) => sanitizeTsvField(clean(v));
    const date = clean(entry.date) || new Date().toISOString().slice(0, 10);
    const row = [date, cell(entry.portal), cell(entry.company), cell(entry.title), clean(entry.url)].join('\t');

    return await withPortalHealthLock(file, async () => {
      const lines = existsSync(file) ? readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean) : [];
      const key = dedupKey(entry.url, entry.title);
      for (const l of lines.slice(-KEEP_LINES)) {
        const c = l.split('\t');
        if (dedupKey(c[4], c[3]) === key) return false;
      }
      if (lines.length + 1 > MAX_LINES) {
        const kept = [...lines.slice(-(KEEP_LINES - 1)), row];
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, kept.join('\n') + '\n', 'utf-8');
        renameSync(tmp, file);
      } else {
        appendFileSync(file, row + '\n', 'utf-8');
      }
      return true;
    });
  } catch (err) {
    console.error(`eval-log: could not record dropped title (${err?.message ?? err}); continuing`);
    return false;
  }
}
