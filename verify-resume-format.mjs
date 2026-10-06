#!/usr/bin/env node
/**
 * verify-resume-format.mjs — mechanical format gate for tailored LaTeX resumes.
 *
 * Why it exists: on 2026-10-05 a retrospective of 52 tailored resumes
 * (docs/resume-eval/2026-10-05-tailored-resume-retrospective.md) found 18 had
 * silently shrunk the body font to 9pt, cut margins to 0.35in, lost every bold
 * metric and the Projects section, and overflowed skill labels. "Compiles to
 * 1 page" was the only check, so all of them passed. This compares each resume
 * with the pinned canonical file (documents/resume-format/).
 *
 * ERRORS (exit 1)
 *   preamble     preamble (documentclass..begin{document} + first font line)
 *                differs from format-lock.json's sha256. Comments/blank lines
 *                ignored. Catches any font, margin, size, macro or colour change.
 *   sections     section titles not in the allowed order/set.
 *   bullets      more than the cap per role (first role 7, others 3) or
 *                projects (3 each) — overflow is fixed by trimming, never shrinking.
 *   bold         fewer than 5 \textbf metrics in the experience section.
 *   skill-label  a \skillrow label wider than the 1.15in label box (~16 chars).
 *   pages        PDF beside the .tex is not exactly 1 page (needs pdfinfo; skipped if absent).
 *   docx         .docx beside the .tex has a different font family, or different
 *                bullet count, than the .tex (needs python-docx; skipped if absent).
 *
 * Usage: node verify-resume-format.mjs <resume.tex...> [--lock path] [--json]
 *        node verify-resume-format.mjs --update-lock   (re-pin after editing the canonical file)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const FORMAT_DIR = join(ROOT, 'documents', 'resume-format');
const CANONICAL = join(FORMAT_DIR, 'Prasad_Rane_Resume_Source.tex');
const LOCK = join(FORMAT_DIR, 'format-lock.json');

const SECTION_ORDER = [
  'PROFESSIONAL SUMMARY',
  'TECHNICAL SKILLS',
  'PROFESSIONAL EXPERIENCE',
  'SELECTED PROJECTS',
  'EDUCATION & CERTIFICATION',
];
const OPTIONAL_SECTIONS = new Set(['SELECTED PROJECTS']);
const MAX_BULLETS_FIRST_ROLE = 7;
const MAX_BULLETS_OTHER_ROLE = 3;
const MAX_BULLETS_PROJECT = 3;
const MIN_BOLD = 5;
const MAX_SKILL_LABEL = 16;

const FONT_FAMILY = { helvet: 'Arial', mathptmx: 'Times New Roman' };

/** Preamble text with comments and blank lines removed, whitespace collapsed. */
export function normalizedPreamble(tex) {
  const start = tex.indexOf('\\documentclass');
  const marker = '\\begin{document}';
  const end = tex.indexOf(marker);
  if (start < 0 || end < 0) return null;
  const after = tex.slice(end + marker.length).split('\n').find((l) => l.trim()) ?? '';
  return (tex.slice(start, end) + marker + '\n' + after)
    .split('\n')
    .map((l) => l.replace(/(^|[^\\])%.*$/, '$1').trim())
    .filter(Boolean)
    .join('\n');
}

export function preambleHash(tex) {
  const n = normalizedPreamble(tex);
  return n ? createHash('sha256').update(n).digest('hex') : null;
}

function unescape(s) {
  return s.replace(/\\&/g, '&').replace(/\\textbar\{\}/g, '|').trim();
}

function pdfPages(pdf) {
  const r = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = /^Pages:\s+(\d+)/m.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

function docxFacts(docx) {
  const code = [
    'import sys,docx',
    'd=docx.Document(sys.argv[1])',
    'f={r.font.name for p in d.paragraphs for r in p.runs if r.font.name}',
    'f.add(d.styles["Normal"].font.name)',
    'b=sum(1 for p in d.paragraphs if p.style.name.startswith("List") or p.text.startswith("\\u2022"))',
    'print(sorted(x for x in f if x)[0] if f else "", b, sep="|")',
  ].join('\n');
  const r = spawnSync('python', ['-c', code, docx], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const [font, bullets] = r.stdout.trim().split('|');
  return { font, bullets: Number(bullets) };
}

export function checkResumeFormat(rawTex, { lock, texPath } = {}) {
  const tex = rawTex.replace(/^\s*%.*$/gm, ''); // ignore commented-out lines
  const errors = [];
  const add = (rule, msg) => errors.push({ rule, msg });

  // preamble
  const hash = preambleHash(tex);
  if (!hash) add('preamble', 'no \\documentclass..\\begin{document} found');
  else if (lock && hash !== lock.preambleSha256) {
    const pkg = /\\usepackage(?:\[[^\]]*\])?\{(helvet|mathptmx|lmodern)\}/.exec(tex)?.[1] ?? 'default';
    const fs = /\\begin\{document\}\s*\\fontsize\{([\d.]+)pt\}/.exec(tex)?.[1] ?? '?';
    const g = /left=([\d.]+)in[\s\S]*?top=([\d.]+)in/.exec(tex);
    add('preamble', `preamble differs from pinned canonical (font=${pkg}, body=${fs}pt, margins=${g ? g[1] + '/' + g[2] : '?'}in). Copy the preamble verbatim; trim bullets instead of changing layout.`);
  }

  const body = tex.split('\\begin{document}')[1] ?? '';

  // sections
  const sections = [...body.matchAll(/\\resumesection\{([^}]*(?:\\&[^}]*)*)\}/g)].map((m) => unescape(m[1]).replace(/CERTIFICATIONS$/, 'CERTIFICATION'));
  const expected = SECTION_ORDER.filter((s) => !OPTIONAL_SECTIONS.has(s) || sections.includes(s));
  if (sections.join('|') !== expected.join('|')) {
    add('sections', `sections [${sections.join(' | ')}] do not match required order [${SECTION_ORDER.join(' | ')}] (Selected Projects optional)`);
  }

  // bullets per block
  const expStart = body.indexOf('PROFESSIONAL EXPERIENCE');
  const projStart = body.indexOf('SELECTED PROJECTS');
  const eduStart = body.search(/\\resumesection\{EDUCATION/);
  const expEnd = projStart > expStart ? projStart : eduStart;
  const exp = body.slice(expStart, expEnd > expStart ? expEnd : undefined);
  const roles = exp.split('\\roleHeader').slice(1);
  roles.forEach((r, i) => {
    const n = (r.match(/\\item\b/g) ?? []).length;
    const cap = i === 0 ? MAX_BULLETS_FIRST_ROLE : MAX_BULLETS_OTHER_ROLE;
    if (n > cap) add('bullets', `role ${i + 1} has ${n} bullets (cap ${cap})`);
  });
  if (projStart > 0) {
    const proj = body.slice(projStart, eduStart > projStart ? eduStart : undefined);
    proj.split('\\projectHeader').slice(1).forEach((p, i) => {
      const n = (p.match(/\\item\b/g) ?? []).length;
      if (n > MAX_BULLETS_PROJECT) add('bullets', `project ${i + 1} has ${n} bullets (cap ${MAX_BULLETS_PROJECT})`);
    });
  }

  // bold metrics
  const bold = (exp.match(/\\textbf\{/g) ?? []).length;
  if (bold < MIN_BOLD) add('bold', `only ${bold} \\textbf metrics in experience (min ${MIN_BOLD}); bold the number inside each bullet`);

  // skill labels
  for (const m of body.matchAll(/\\skillrow\{([^}]*(?:\\&[^}]*)*)\}/g)) {
    const label = unescape(m[1]);
    if (label.length > MAX_SKILL_LABEL) add('skill-label', `skill label "${label}" is ${label.length} chars (max ${MAX_SKILL_LABEL}); it overflows the 1.15in box`);
  }

  // artifacts beside the .tex
  if (texPath) {
    const pdf = texPath.replace(/\.tex$/, '.pdf');
    if (existsSync(pdf)) {
      const pages = pdfPages(pdf);
      if (pages !== null && pages !== 1) add('pages', `PDF has ${pages} pages (must be 1)`);
    }
    const docx = texPath.replace(/\.tex$/, '.docx');
    if (existsSync(docx)) {
      const facts = docxFacts(docx);
      const pkg = /\\usepackage(?:\[[^\]]*\])?\{(helvet|mathptmx)\}/.exec(tex)?.[1];
      if (facts && pkg && facts.font !== FONT_FAMILY[pkg]) add('docx', `DOCX font "${facts.font}" != expected "${FONT_FAMILY[pkg]}" for ${pkg}`);
      const items = (tex.match(/\\item\b/g) ?? []).length;
      if (facts && facts.bullets !== items) add('docx', `DOCX has ${facts.bullets} bullets, TEX has ${items}`);
    }
  }
  return errors;
}

export function loadLock(path = LOCK) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function main(argv) {
  if (argv.includes('--update-lock')) {
    const tex = readFileSync(CANONICAL, 'utf8');
    const lock = { canonical: 'Prasad_Rane_Resume_Source.tex', preambleSha256: preambleHash(tex) };
    writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
    console.log(`Pinned ${lock.preambleSha256}`);
    return 0;
  }
  const json = argv.includes('--json');
  const li = argv.indexOf('--lock');
  const lock = loadLock(li >= 0 ? argv[li + 1] : LOCK);
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--lock');
  if (!files.length) { console.error('Usage: node verify-resume-format.mjs <resume.tex...> [--json]'); return 2; }
  if (!lock) { console.error(`No ${LOCK}; run --update-lock first`); return 2; }
  let failed = 0;
  const out = [];
  for (const f of files) {
    const errors = checkResumeFormat(readFileSync(f, 'utf8'), { lock, texPath: f });
    out.push({ file: f, errors });
    if (errors.length) failed++;
    if (!json) {
      console.log(errors.length ? `FAIL ${f}` : `OK   ${f}`);
      for (const e of errors) console.log(`  [${e.rule}] ${e.msg}`);
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else console.log(`\n${files.length - failed}/${files.length} pass`);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
