/**
 * p5-tailor-delta.mjs — P5 (tailoring) probe: does the tailored CV follow the rules AND fit the JD better than cv.md?
 *
 * Artifacts: the latest MAX_ARTIFACTS tailored CV HTML files. Located via data/pdf-index.tsv
 * (`report pdf html format date kind`, written by generate-pdf.mjs; kind cv or empty), newest date first;
 * fallback when there is no index: output/cv-*.html (newest mtime first) matched to a report whose
 * company slug (reports/{###}-{slug}-{date}.md) appears in the file name. Each needs its report's
 * `## Keywords extracted` section (keyword-match.mjs) — an artifact without keywords is skipped.
 *
 * Per artifact:
 *   fact check     verify-cv-facts.mjs verifyFacts() vs cv.md + article-digest.md  -> factViolations
 *                  (invented metrics + unsupported facts + forbidden phrases). A throw -> unverified.
 *   title/structure only when the render payload JSON sits beside the HTML (`<same name>.json`, the file
 *                  pdf mode builds before rendering; normally it lives in /tmp, so this is often absent).
 *                  Runs cv-title-check.mjs checkTitles (mismatches -> titleDrift) and verify-cv-structure.mjs verifyStructure
 *                  (order + descriptor warnings -> ruleHits). No payload / verifier error -> unverified,
 *                  NEVER counted as a pass.
 *   coverage       keyword-match analyzeCoverage() of the report's keywords against cv.md (base) and the
 *                  tailored HTML text; coverageDelta = tailored - base in percentage points.
 *                  `lowered` lists keywords the tailored CV lost vs base, with the cv.md bullet that had them.
 *
 * Verdict: any factViolations > 0 -> fail (a hard rule, even below the sample floor); fewer than
 * SAMPLE_FLOOR scored artifacts -> insufficient-data; mean coverageDelta < 0 -> fail; < WARN_BELOW_PP -> warn;
 * else pass. Read-only: the verifiers are imported (exported pure functions, no child processes); nothing is written.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, isAbsolute, basename } from 'path';
import { SAMPLE_FLOOR } from './verdict.mjs';
import { readReports, readTextFile } from './_data.mjs';
import { analyzeCoverage, extractKeywords, htmlToText } from '../../keyword-match.mjs';
import { verifyFacts } from '../../verify-cv-facts.mjs';
import { verifyStructure } from '../../verify-cv-structure.mjs';
import { checkTitles, parseCvExperience, parseTailoredExperience } from '../../cv-title-check.mjs';

export const MAX_ARTIFACTS = 10;
export const COVERAGE_DELTA_WARN_BELOW_PP = 2;   // mean delta < 2pp (but >= 0) -> warn

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (x) => Math.round(x * 10) / 10;

function resolveIn(root, p) { return isAbsolute(p) ? p : join(root, p); }

/** [{report: Number, html: abs path, date}] newest first, max MAX_ARTIFACTS*3 candidates (some get skipped). */
function locateArtifacts(root, reports) {
  const found = [];
  const text = readTextFile(join(root, 'data', 'pdf-index.tsv'));
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [report, , html, , date = '', kind = ''] = line.split('\t').map((s) => s.trim());
    if (!/^\d+$/.test(report ?? '') || !html || (kind && kind !== 'cv')) continue;
    const path = resolveIn(root, html);
    if (existsSync(path)) found.push({ report: Number(report), html: path, date });
  }
  if (found.length) return found.sort((a, b) => b.date.localeCompare(a.date));

  const outDir = join(root, 'output');
  let names = [];
  try { names = existsSync(outDir) ? readdirSync(outDir).filter((f) => /^cv-.*\.html$/i.test(f)) : []; } catch { return []; }
  const slugOf = (file) => file.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/i, '').toLowerCase();
  for (const f of names) {
    const path = join(outDir, f);
    const rep = reports
      .filter((r) => slugOf(r.file) && basename(f).toLowerCase().includes(slugOf(r.file)))
      .sort((a, b) => slugOf(b.file).length - slugOf(a.file).length)[0];
    if (!rep) continue;
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { /* keep 0 */ }
    found.push({ report: Number(rep.num), html: path, date: new Date(mtime).toISOString() });
  }
  return found.sort((a, b) => b.date.localeCompare(a.date));
}

function payloadChecks(cvText, htmlPath) {
  const payloadPath = htmlPath.replace(/.html?$/i, '.json');
  if (!existsSync(payloadPath)) return { verified: false, reason: 'no payload JSON beside the HTML' };
  try {
    const payload = JSON.parse(readTextFile(payloadPath));
    const titles = checkTitles(parseCvExperience(cvText), parseTailoredExperience(payload));
    const ruleHits = titles.mismatches.map((m) => `title: ${m.company}: cv.md "${m.cvTitle}" vs tailored "${m.tailoredTitle}"`);
    const st = verifyStructure(payload, cvText);
    if (st.verdict === 'unverified') return { verified: false, reason: 'cv.md structure not parseable by verify-cv-structure' };
    for (const v of [...st.orderViolations, ...st.descriptorViolations]) ruleHits.push(`structure: ${v}`);
    return { verified: true, titleDrift: titles.mismatches.length, ruleHits };
  } catch (err) {
    return { verified: false, reason: `verifier failed: ${err.message}` };
  }
}

function bulletsFor(cvText, keyword) {
  const k = keyword.toLowerCase();
  const line = cvText.split(/\r?\n/).find((l) => l.toLowerCase().includes(k));
  return line ? line.replace(/^[\s*-]+/, '').trim().slice(0, 140) : '';
}

export default async function probe({ root }) {
  const reports = readReports(root);
  const reportByNum = new Map(reports.map((r) => [Number(r.num), r]));
  const cvPath = join(root, 'cv.md');
  const cvText = readTextFile(cvPath);
  const findings = [];

  const candidates = locateArtifacts(root, reports);
  const scored = [];
  let skipped = 0;
  for (const c of candidates) {
    if (scored.length >= MAX_ARTIFACTS) break;
    const rep = reportByNum.get(c.report);
    const keywords = rep ? extractKeywords(readTextFile(rep.path)) : [];
    if (!rep || !keywords.length || !cvText) { skipped++; continue; }
    const html = readTextFile(c.html);
    if (!html) { skipped++; continue; }

    let factViolations = 0;
    let factVerified = true;
    try {
      const fv = verifyFacts(html, {
        sourcePaths: [cvPath, join(root, 'article-digest.md')],
        configPath: join(root, 'config', 'cv-facts.json'),
        cwd: root,
      });
      factViolations = fv.invented.length + fv.unsupportedFacts.length + fv.forbidden.length;
      if (factViolations) {
        findings.push(`report ${rep.num}: ${factViolations} fact violation(s): ${[...fv.invented, ...fv.unsupportedFacts.map((u) => u.value), ...fv.forbidden].slice(0, 4).join('; ')}`);
      }
    } catch (err) {
      factVerified = false;
      findings.push(`report ${rep.num}: fact check could not run (${err.message}); counted unverified`);
    }

    const pc = payloadChecks(cvText, c.html);
    const tailoredText = htmlToText(html);
    const base = analyzeCoverage(keywords, cvText);
    const tail = analyzeCoverage(keywords, tailoredText);
    const lowered = base.present.filter((k) => !tail.present.includes(k))
      .map((keyword) => ({ keyword, bullet: bulletsFor(cvText, keyword) }));
    scored.push({
      report: rep.num, html: c.html, baseCoverage: base.coveragePct, tailoredCoverage: tail.coveragePct,
      coverageDelta: tail.coveragePct - base.coveragePct, lowered,
      factViolations, factVerified, payload: pc,
    });
  }

  const n = scored.length;
  const factViolations = scored.reduce((a, s) => a + s.factViolations, 0);
  const titleDrift = scored.reduce((a, s) => a + (s.payload.verified ? s.payload.titleDrift : 0), 0);
  const unverified = scored.filter((s) => !s.payload.verified || !s.factVerified).length;
  const ruleHits = scored.flatMap((s) => (s.payload.verified ? s.payload.ruleHits.map((h) => `${s.report}: ${h}`) : []));
  const tooSmall = n < SAMPLE_FLOOR;
  const meanDelta = n ? mean(scored.map((s) => s.coverageDelta)) : NaN;

  let v;
  if (factViolations > 0) v = 'fail';
  else if (tooSmall) v = 'insufficient-data';
  else if (meanDelta < 0) v = 'fail';
  else if (meanDelta < COVERAGE_DELTA_WARN_BELOW_PP) v = 'warn';
  else v = 'pass';

  if (n === 0) findings.push('no tailored CV artifacts with report keywords found (data/pdf-index.tsv or output/cv-*.html)');
  else if (tooSmall) findings.push(`coverage delta (n too small): ${n} tailored artifact(s), need ${SAMPLE_FLOOR}`);
  else findings.push(`mean JD keyword coverage delta ${round1(meanDelta)}pp over ${n} tailored CVs (base ${round1(mean(scored.map((s) => s.baseCoverage)))}% -> tailored ${round1(mean(scored.map((s) => s.tailoredCoverage)))}%)`);
  for (const s of scored.filter((x) => x.lowered.length).slice(0, 5)) {
    findings.push(`report ${s.report}: tailoring lowered coverage on ${s.lowered.map((l) => l.keyword).join(', ')}`);
  }
  if (unverified) findings.push(`${unverified} artifact(s) not fully verified (no payload JSON beside the HTML, or a verifier could not run); title/structure checks counted unverified, not passed`);
  if (skipped) findings.push(`${skipped} artifact(s) skipped (report missing or no keyword section)`);

  return {
    phase: 'p5',
    verdict: v,
    metrics: {
      artifacts: n,
      factViolations,
      titleDrift,
      baseCoverage: tooSmall ? '(n too small)' : round1(mean(scored.map((s) => s.baseCoverage))),
      tailoredCoverage: tooSmall ? '(n too small)' : round1(mean(scored.map((s) => s.tailoredCoverage))),
      coverageDelta: tooSmall ? '(n too small)' : round1(meanDelta),
      ruleHits: ruleHits.length,
    },
    findings,
    detail: { artifacts: scored, ruleHits, unverified, skipped },
  };
}
