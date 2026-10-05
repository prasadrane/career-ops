/**
 * proposals.mjs — suggest-only improvement items derived from the scorecard (`eval-pipeline.mjs --propose`).
 *
 * buildProposals(phases)  pure: phase results -> [{phase, id, text, metric, evidence}]; every item cites
 *                         the metric it comes from and one line of evidence. Phases without detail
 *                         (insufficient-data, probe missing) yield nothing.
 * writeProposals(root, phases, generated)
 *                         writes ONLY {root}/data/eval/proposals.md (overwritten each run) and returns its path.
 *
 * Advisory by construction: nothing here edits portals.yml, config/profile.yml, modes/*, cv.md or any
 * scoring rule — the user reads the file and applies what they agree with.
 */

import { mkdirSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const MAX_PER_KIND = 5;

/** @returns {{phase:string, id:string, text:string, metric:string, evidence:string}[]} */
export function buildProposals(phases) {
  const items = [];
  const byPhase = new Map((Array.isArray(phases) ? phases : []).map((p) => [p?.phase, p]));

  const p1 = byPhase.get('p1');
  for (const s of p1?.detail?.sources ?? []) {
    if (s.addedLast3Runs === 0 && s.everSeen > 0) {
      items.push({
        phase: 'p1', id: `source-${s.id}`,
        text: `source ${s.id}: 0 adds in last 3 runs -> consider disabling (or narrowing its queries)`,
        metric: 'p1 sources[].addedLast3Runs = 0',
        evidence: `${s.id}: seen ${s.seen ?? '?'}, added ${s.added ?? '?'} in window, ${s.everSeen} ever`,
      });
    }
  }

  const p2 = byPhase.get('p2');
  for (const r of (p2?.detail?.recallSample ?? []).slice(0, MAX_PER_KIND)) {
    const m = /^shares (.+?) with "(.*)"$/.exec(r.reason ?? '');
    const kw = m ? m[1].split(',')[0].trim() : '';
    items.push({
      phase: 'p2', id: `title-${r.title}`,
      text: `dropped near-miss title "${r.title}" resembles an applied/high-scored role${kw ? ` -> consider adding keyword "${kw}" to title_filter.positive` : ' -> review title_filter'}`,
      metric: 'p2 recallSample',
      evidence: `${r.title} @ ${r.company || '?'}: ${r.reason ?? 'similar to an applied role'}`,
    });
  }

  const p4 = byPhase.get('p4');
  for (const m of (p4?.detail?.mismatches ?? []).slice(0, MAX_PER_KIND)) {
    items.push({
      phase: 'p4', id: `archetype-${m.report}`,
      text: `report ${m.report}: archetype disagrees with your label -> review how modes/_profile.md describes "${m.labeled}" vs "${m.current || '(none)'}"`,
      metric: `p4 archetypeAgreement = ${p4.metrics?.archetypeAgreement}`,
      evidence: `report ${m.report}: you labelled "${m.labeled}", report says "${m.current || '(none)'}"`,
    });
  }

  const p5 = byPhase.get('p5');
  let lowered = 0;
  for (const a of p5?.detail?.artifacts ?? []) {
    for (const l of a.lowered ?? []) {
      if (lowered++ >= MAX_PER_KIND) break;
      items.push({
        phase: 'p5', id: `bullet-${a.report}-${l.keyword}`,
        text: `tailored CV for report ${a.report} lowered coverage of "${l.keyword}" -> keep the cv.md bullet "${l.bullet || '(not located)'}" in the tailored CV`,
        metric: `p5 coverageDelta = ${p5.metrics?.coverageDelta}`,
        evidence: `report ${a.report}: "${l.keyword}" present in cv.md, missing from tailored HTML`,
      });
    }
  }
  return items;
}

export function renderProposals(items, generated) {
  const lines = [
    '# Pipeline eval proposals',
    '',
    `Generated ${generated}. Suggest-only: nothing was changed. Apply what you agree with yourself`,
    '(portals.yml, config/profile.yml, modes/_profile.md); scoring rules are never touched by this tool.',
    '',
  ];
  if (!items.length) {
    lines.push('No proposals: the current scorecard has no source, title, scoring or tailoring evidence worth acting on.');
  } else {
    for (const i of items) {
      lines.push(`- [${i.phase}] ${i.text}`, `  - metric: ${i.metric}`, `  - evidence: ${i.evidence}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function writeProposals(root, phases, generated = new Date().toISOString()) {
  const dir = join(root, 'data', 'eval');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proposals.md');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, renderProposals(buildProposals(phases), generated));
  renameSync(tmp, file);
  return file;
}
