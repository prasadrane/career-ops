import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkResumeFormat, loadLock } from '../verify-resume-format.mjs';

const canonical = readFileSync(new URL('../documents/resume-format/Prasad_Rane_Resume_Source.tex', import.meta.url), 'utf8');
const lock = loadLock();
const rules = (tex) => checkResumeFormat(tex, { lock }).map((e) => e.rule);

test('canonical file passes its own lock', () => {
  assert.deepEqual(checkResumeFormat(canonical, { lock }), []);
});

test('comment-only and header edits do not trip the preamble lock', () => {
  const edited = canonical.replace('% PRASAD RANE', '% Tailored for Acme (Req 1)\n% PRASAD RANE');
  assert.deepEqual(rules(edited), []);
});

test('shrinking font or margins is a preamble error', () => {
  assert.ok(rules(canonical.replace('\\fontsize{10pt}{13pt}\\selectfont\n\n{\\centering', '\\fontsize{9pt}{11.5pt}\\selectfont\n\n{\\centering')).includes('preamble'));
  assert.ok(rules(canonical.replace('left=0.4in', 'left=0.5in')).includes('preamble'));
});

test('switching font package is a preamble error', () => {
  assert.ok(rules(canonical.replace('[scaled=0.95]{helvet}', '{mathptmx}')).includes('preamble'));
});

test('missing bold metrics, long skill label and extra bullets are flagged', () => {
  const noBold = canonical.replace(/\\textbf\{([^}]*)\}/g, (m, t, off) => (off > canonical.indexOf('PROFESSIONAL EXPERIENCE') ? t : m));
  assert.ok(rules(noBold).includes('bold'));
  assert.ok(rules(canonical.replace('{Cloud \\& Data}', '{Cloud \\& Infrastructure}')).includes('skill-label'));
  const extra = canonical.replace('\\item Cut manual paper-check', '\\item a\n\\item b\n\\item c\n\\item Cut manual paper-check');
  assert.ok(rules(extra).includes('bullets'));
});

test('contact line with both relocation and remote is flagged; either alone passes', () => {
  assert.ok(rules(canonical.replace('(open to CA relocation)', '(open to California relocation and US remote)')).includes('contact'));
  assert.ok(!rules(canonical.replace('(open to CA relocation)', '(open to US remote)')).includes('contact'));
  assert.ok(!rules(canonical).includes('contact'));
});

test('dropping or reordering sections is flagged; Projects stays optional', () => {
  assert.ok(rules(canonical.replace(/\\resumesection\{TECHNICAL SKILLS\}/, '\\resumesection{SKILLS}')).includes('sections'));
  const noProjects = canonical.replace(/\\resumesection\{SELECTED PROJECTS\}[\s\S]*?\\end\{itemize\}\n/, '');
  assert.ok(!rules(noProjects).includes('sections'));
});
