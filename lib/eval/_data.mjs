/**
 * _data.mjs — shared, read-only data readers for the eval probes (lib/eval/p*-*.mjs).
 * Leading underscore: eval-pipeline.mjs does not discover this as a probe.
 *
 * Every reader is safe on a missing/empty/malformed file (returns [] or {}) so a
 * probe never throws for lack of data; none of them writes anything.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import * as yaml from 'js-yaml';
import { parseTrackerRow, resolveColumns, isSeparatorRow, isHeaderRow } from '../../tracker-parse.mjs';
import { resolveTrackerPath } from '../../path-resolver.mjs';
import normalizeUrl from '../../url-key.mjs';

export const SCAN_HISTORY_COLUMNS = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'location',
  'fingerprint', 'posted_at', 'trust_score', 'trust_flags', 'normalized_company', 'query_id'];

function readText(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf-8').replace(/^\uFEFF/, '') : ''; } catch { return ''; }
}

/** Generic TSV -> rows by header NAME (header = first line). Missing cells are ''. */
export function readTsv(path) {
  const lines = readText(path).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

/**
 * scan-history.tsv -> rows by NAME. The file may have no header (scan.mjs writes
 * none) and rows of 6..13 columns (older rows lack trailing columns): positional
 * names from SCAN_HISTORY_COLUMNS, missing cells ''. A leading header line is skipped.
 * Each row also carries `urlKey` (normalized URL).
 */
export function readScanHistory(root) {
  const lines = readText(join(root, 'data', 'scan-history.tsv')).split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    const cells = line.split('\t');
    if (cells[0] === 'url' && cells[1] === 'first_seen') continue;
    const row = Object.fromEntries(SCAN_HISTORY_COLUMNS.map((c, i) => [c, (cells[i] ?? '').trim()]));
    if (!row.status) row.status = 'added';
    row.urlKey = normalizeUrl(row.url);
    rows.push(row);
  }
  return rows;
}

/** trust_flags column -> string[] (comma separated, e.g. `also_seen:greenhouse,ghost`). */
export function flagList(row) {
  return String(row?.trust_flags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const REPORT_URL_RE = /^\*\*URL:\*\*\s*(\S+)/m;

/**
 * Tracker rows (parseTrackerRow shape) plus `scoreNum` and `urlKey`
 * (tracker url column, else the linked report's **URL:** header).
 */
export function readTracker(root) {
  let path;
  try { path = resolveTrackerPath(root); } catch { return []; }
  const text = readText(path);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const bases = [dirname(path), root];
  const rows = [];
  for (const line of lines) {
    if (isSeparatorRow(line) || isHeaderRow(line)) continue;
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    row.scoreNum = Number.parseFloat(String(row.score).split('/')[0]);
    let url = row.url && /^https?:/i.test(row.url) ? row.url : '';
    if (!url) {
      const m = /\]\(([^)]+)\)/.exec(row.report ?? '');
      if (m) {
        for (const b of bases) {
          const u = REPORT_URL_RE.exec(readText(resolve(b, m[1])));
          if (u) { url = u[1]; break; }
        }
      }
    }
    row.urlKey = normalizeUrl(url);
    rows.push(row);
  }
  return rows;
}

/** pipeline.md -> [{marker: ' '|'x'|'?'|'!', url, urlKey, text}] */
export function readPipeline(root) {
  const rows = [];
  for (const line of readText(join(root, 'data', 'pipeline.md')).split(/\r?\n/)) {
    const m = /^\s*-\s*\[([ xX?!])\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const text = m[2];
    const url = (/https?:\/\/\S+/.exec(text) ?? [''])[0];
    rows.push({ marker: m[1].toLowerCase(), url, urlKey: normalizeUrl(url), text });
  }
  return rows;
}

/** portals.yml -> object ({} when missing or invalid). */
export function readPortals(root) {
  try {
    const doc = yaml.load(readText(process.env.CAREER_OPS_PORTALS || join(root, 'portals.yml')));
    return doc && typeof doc === 'object' ? doc : {};
  } catch { return {}; }
}

/** data/scan-runs.tsv rows by name, oldest first. */
export function readScanRuns(root) {
  return readTsv(join(root, 'data', 'scan-runs.tsv'));
}

/** data/portal-health.tsv rows (`timestamp company status`). */
export function readPortalHealth(root) {
  return readTsv(join(root, 'data', 'portal-health.tsv'));
}

/** data/runs/<run>/tasks.tsv -> rows by name, each with `run` (directory name). */
export function readRunLedgers(root) {
  const dir = join(root, 'data', 'runs');
  let names = [];
  try { names = existsSync(dir) ? readdirSync(dir).sort() : []; } catch { return []; }
  return names.flatMap((run) => readTsv(join(dir, run, 'tasks.tsv')).map((r) => ({ run, ...r })));
}

/** True when `dateStr` is on/after `since` (a Date); undated rows are kept. */
export function inWindow(dateStr, since) {
  const t = Date.parse(String(dateStr ?? ''));
  return !since || Number.isNaN(t) || t >= since.getTime();
}

/** data/eval/dropped-titles.tsv (no header: date, portal, company, title, url) -> rows; [] when missing. */
export function readDroppedTitles(root) {
  return readText(join(root, 'data', 'eval', 'dropped-titles.tsv')).split(/\r?\n/).filter(Boolean).map((l) => {
    const [date = '', portal = '', company = '', title = '', url = ''] = l.split('\t');
    return { date, portal, company, title, url };
  }).filter((r) => r.title && r.date !== 'date');
}

/** data/eval/golden-user.jsonl -> [{report, archetype, score, label_source, note}]; bad lines skipped, [] when missing. */
export function readGoldenUser(root) {
  const out = [];
  for (const line of readText(join(root, 'data', 'eval', 'golden-user.jsonl')).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && /^\d{1,4}$/.test(String(o.report ?? ''))) out.push(o);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * reports/{###}-*.md -> [{num: '064', file, path, score: number|null, archetype: string}]
 * from the header (`**Score:** 4.1/5`, `**Archetype:** ...`); [] when no reports dir.
 */
export function readReports(root) {
  const dir = join(root, 'reports');
  let names = [];
  try { names = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+-.*\.md$/i.test(f)).sort() : []; } catch { return []; }
  return names.map((file) => {
    const path = join(dir, file);
    const text = readText(path);
    const sm = /^\*\*Score:\*\*\s*([\d.]+)/m.exec(text);
    const am = /^\*\*Archetype:\*\*[ \t]*(.+)$/m.exec(text);
    return {
      num: /^(\d+)-/.exec(file)[1].padStart(3, '0'),
      file,
      path,
      score: sm ? Number.parseFloat(sm[1]) : null,
      archetype: am ? am[1].trim() : '',
    };
  });
}

/** Full text of a file ('' when missing). */
export function readTextFile(path) { return readText(path); }
