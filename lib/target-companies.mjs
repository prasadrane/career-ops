/**
 * target-companies.mjs — loader/helpers for the user-layer target list
 * (data/target-companies.yml: `companies: [{name, tier, location}]`).
 *
 * Pure except for loadTargets' file read. Order is preserved (the file lists
 * `dotnet` before `general`; position inside a tier is the user's priority).
 */
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { normalizeCompany } from '../tracker-utils.mjs';

/** FoundRole `companies[]` accepts at most this many names per call. */
export const CHUNK_SIZE = 20;

/**
 * Official names behind a display name: "ByteDance / TikTok" and
 * "Block (Square)" both name two searchable companies. First entry is the
 * primary name.
 * @param {string} name
 * @returns {string[]}
 */
export function splitSearchNames(name) {
  const out = [];
  for (const part of String(name).split('/')) {
    const m = part.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    for (const piece of m ? [m[1], m[2]] : [part]) {
      const t = piece.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.length ? out : [String(name).trim()];
}

const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param {string} path
 * @returns {{name:string, tier:string, location:string, slug:string, searchNames:string[]}[]}
 */
export function loadTargets(path) {
  const doc = yaml.load(readFileSync(path, 'utf-8'));
  const list = Array.isArray(doc?.companies) ? doc.companies : [];
  const out = [];
  for (const raw of list) {
    const e = typeof raw === 'string' ? { name: raw } : raw;
    if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
    const name = e.name.trim();
    out.push({
      name,
      tier: typeof e.tier === 'string' ? e.tier : 'general',
      location: typeof e.location === 'string' ? e.location : '',
      slug: slugOf(name),
      searchNames: splitSearchNames(name),
    });
  }
  return out;
}

/**
 * Chunks of company NAMES for MCP company filters: one name per company (the
 * primary, `searchNames[0]`), at most `size` per chunk. Aliases stay available
 * via `target.searchNames` for a second pass over companies that returned
 * nothing under their primary name.
 * @returns {string[][]}
 */
export function chunk(targets, size = CHUNK_SIZE) {
  const n = Math.max(1, size | 0);
  const seen = new Set();
  const names = [];
  for (const t of targets) {
    const name = t.searchNames?.[0] ?? t.name;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  const out = [];
  for (let i = 0; i < names.length; i += n) out.push(names.slice(i, i + n));
  return out;
}

/** Normalized key set for a target: display name plus every official name. */
export function targetKeys(t) {
  return [t.name, ...(t.searchNames || [])].map(normalizeCompany).filter(Boolean);
}

/**
 * Which route actually watches each target.
 * @param {{targets:object[], resolvedBoards?:string[], mcpSeen?:string[], customSites?:string[]}} p
 * @returns {{name:string, route:'ats'|'mcp'|'custom-site-unscanned'|'no-results'}[]}
 */
export function coverage({ targets, resolvedBoards = [], mcpSeen = [], customSites = [] }) {
  const keys = (xs) => new Set(xs.map(normalizeCompany).filter(Boolean));
  const ats = keys(resolvedBoards);
  const mcp = keys(mcpSeen);
  const custom = keys(customSites);
  return targets.map((t) => {
    const ks = targetKeys(t);
    const has = (set) => ks.some((k) => set.has(k));
    const route = has(ats) ? 'ats' : has(mcp) ? 'mcp' : has(custom) ? 'custom-site-unscanned' : 'no-results';
    return { name: t.name, route };
  });
}
