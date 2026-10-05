// lib/mcp-adapters.mjs - pure per-server normalizers for MCP job-search results.
//
// MCP servers are only callable from the agent session, never from Node. The
// agent saves each server's raw JSON to data/mcp-raw/{run-id}/{server}-{query_id}.json
// and ingest-mcp-jobs.mjs reads it through these adapters.
//
// RAW ENVELOPE (what the agent saves):
//   { "server": "jobspipe" | "jobdatalake" | "foundrole",
//     "query_id": "<id from portals.yml mcp_sources.queries>",
//     "rows": [ ... ] }          // rows may also sit under `results` or `data`;
//                                // a bare top-level array is accepted too.
//
// TRUST: row text is untrusted data. Adapters copy ONLY the NormalizedJob
// fields below (never descriptions, never unknown keys), never throw on a
// malformed row (it is skipped), and never interpret text as instructions.
//
// NormalizedJob:
//   { title, url, company, location, posted_at (YYYY-MM-DD or ''),
//     source: 'mcp-jobspipe' | 'mcp-jobdatalake' | 'mcp-foundrole',
//     query_id, source_id (opaque server id), aggregator (bool),
//     source_signals: { ghost_score?: number, last_verified?: string } }
//
// A row is dropped when it has no usable title or no http(s) URL. Missing
// optional fields become ''. The adapter does NOT decide "aggregator" from the
// URL host (the ingester does, via url-key.mjs / data-static); only FoundRole
// is aggregator:true unconditionally.
//
// FIELD-ALIAS TABLE (first present, non-empty value wins). Field names are not
// fully documented by the vendors, hence the aliases; add new spellings here.
//   JobsPipe   title: title|job_title|jobTitle
//              company: company|company_name|companyName|employer|employer_name
//              url: url|apply_url|applyUrl|source_url|job_url
//              location: location|job_location|city
//              posted_at: posted_at|date_posted|posted_date|postedAt|posted
//              source_id: id|job_id|jobId
//              ghost_score: ghost_score|ghostScore   last_verified: last_verified|last_verified_at|lastVerified
//   JobDataLake title: title|job_title
//              company: company|company_name|employer
//              url: apply_url|url|job_url|source_url
//              location: location|job_location|city
//              posted_at: posted_at|date_posted|posted_date|postedAt
//              source_id: job_handle|id|job_id
//   FoundRole  title: title|job_title    company: company|company_name|employer
//              url: url|apply_url|job_url|link     (query string kept intact)
//              location: location|job_location|city
//              posted_at: posted_at|date_posted|posted_date|postedAt
//              source_id: "id|resultItemId" (both are needed later for jobs_details)

/** @typedef {{title:string,url:string,company:string,location:string,posted_at:string,source:'mcp-jobspipe'|'mcp-jobdatalake'|'mcp-foundrole',query_id:string,source_id:string,aggregator:boolean,source_signals:{ghost_score?:number,last_verified?:string}}} NormalizedJob */

const ROW_KEYS = ['rows', 'results', 'data'];

function rowsOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  for (const key of ROW_KEYS) if (Array.isArray(raw[key])) return raw[key];
  return [];
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** First alias whose value is a non-empty string/number, as a trimmed string. */
function pick(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function pickCompany(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (isPlainObject(v) && typeof v.name === 'string' && v.name.trim()) return v.name.trim();
  }
  return '';
}

function pickLocation(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const parts = v.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
      if (parts.length) return parts.join(', ');
    }
    if (isPlainObject(v)) {
      const parts = [v.city, v.state, v.region, v.country]
        .filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
      if (parts.length) return parts.join(', ');
    }
  }
  return '';
}

/** http(s) URL kept byte-for-byte (query string and fragment intact), or ''. */
function pickUrl(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!/^https?:\/\//i.test(s)) continue;
    try { new URL(s); } catch { continue; }
    return s;
  }
  return '';
}

/** ISO date (YYYY-MM-DD) from an ISO-ish string or epoch seconds/ms; '' if unparseable. */
function pickDate(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    let ms = NaN;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) ms = v < 1e11 ? v * 1000 : v;
    else if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      ms = Date.parse(s);
    }
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return '';
}

function pickNumber(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function build(raw, queryId, { source, aggregator, aliases, sourceId, signals }) {
  const qid = typeof queryId === 'string' && queryId.trim()
    ? queryId.trim()
    : (isPlainObject(raw) && typeof raw.query_id === 'string' ? raw.query_id.trim() : '');
  const jobs = [];
  for (const row of rowsOf(raw)) {
    try {
      if (!isPlainObject(row)) continue;
      const title = pick(row, aliases.title);
      const url = pickUrl(row, aliases.url);
      if (!title || !url) continue;
      jobs.push({
        title,
        url,
        company: pickCompany(row, aliases.company),
        location: pickLocation(row, aliases.location),
        posted_at: pickDate(row, aliases.posted_at),
        source,
        query_id: qid,
        source_id: sourceId(row),
        aggregator,
        source_signals: signals ? signals(row) : {},
      });
    } catch {
      // A row that defeats every guard above is still just a bad row.
    }
  }
  return jobs;
}

const COMMON = {
  company: ['company', 'company_name', 'companyName', 'employer', 'employer_name'],
  location: ['location', 'job_location', 'city'],
  posted_at: ['posted_at', 'date_posted', 'posted_date', 'postedAt', 'posted'],
};

/** @returns {NormalizedJob[]} */
export function normalizeJobsPipe(raw, queryId) {
  return build(raw, queryId, {
    source: 'mcp-jobspipe',
    aggregator: false,
    aliases: {
      title: ['title', 'job_title', 'jobTitle'],
      url: ['url', 'apply_url', 'applyUrl', 'source_url', 'job_url'],
      ...COMMON,
    },
    sourceId: (row) => pick(row, ['id', 'job_id', 'jobId']),
    signals: (row) => {
      const out = {};
      const ghost = pickNumber(row, ['ghost_score', 'ghostScore']);
      if (ghost !== undefined) out.ghost_score = ghost;
      const verified = pick(row, ['last_verified', 'last_verified_at', 'lastVerified']);
      if (verified) out.last_verified = verified;
      return out;
    },
  });
}

/** @returns {NormalizedJob[]} */
export function normalizeJobDataLake(raw, queryId) {
  return build(raw, queryId, {
    source: 'mcp-jobdatalake',
    aggregator: false,
    aliases: {
      title: ['title', 'job_title'],
      url: ['apply_url', 'url', 'job_url', 'source_url'],
      ...COMMON,
    },
    sourceId: (row) => pick(row, ['job_handle', 'id', 'job_id']),
  });
}

/**
 * FoundRole `jobs_search` rows. `id` and `resultItemId` are both required by
 * `jobs_details`, so source_id keeps them as "id|resultItemId". Always
 * aggregator:true: results stay UNCONFIRMED until jobs_details yields an
 * employer apply URL (AGENTS.md aggregator rule).
 * @returns {NormalizedJob[]}
 */
export function normalizeFoundRole(raw, queryId) {
  return build(raw, queryId, {
    source: 'mcp-foundrole',
    aggregator: true,
    aliases: {
      title: ['title', 'job_title'],
      url: ['url', 'apply_url', 'job_url', 'link'],
      ...COMMON,
    },
    sourceId: (row) => {
      const id = pick(row, ['id']);
      const item = pick(row, ['resultItemId', 'result_item_id']);
      return id && item ? `${id}|${item}` : (id || item);
    },
  });
}

/** Number of raw rows in an envelope (valid or not) - lets callers tell "empty" from "all rows invalid". */
export function rawRowCount(raw) {
  return rowsOf(raw).length;
}
