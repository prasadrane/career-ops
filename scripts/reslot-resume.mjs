#!/usr/bin/env node
/**
 * reslot-resume.mjs — rebuild a tailored resume .tex on the pinned canonical
 * layout, keeping only the tailored TEXT of the old file.
 *
 * Why: the 2026-10-05 retrospective found generated resumes rewrote the preamble
 * and shrank fonts to fit. Here the preamble, macros, Projects and Education are
 * copied verbatim from documents/resume-format/Prasad_Rane_Resume_Source.tex;
 * only title, contact line, summary, skill rows and experience bullets come from
 * the old file. No new facts are written: the only text edits are
 *   - bolding metric tokens (numbers, %, x-to-y ranges) inside bullets
 *   - shortening skill labels longer than 16 chars
 *   - dropping trailing bullets to meet the caps (first role 7, others 3)
 * To fit one page it falls back in order: drop Projects, then drop the last
 * bullet of the first role, repeatedly (never changes font, margins, spacing).
 *
 * Usage: node scripts/reslot-resume.mjs <old.tex> [--out new.tex]   (default: overwrite)
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANON = readFileSync(join(ROOT, 'documents/resume-format/Prasad_Rane_Resume_Source.tex'), 'utf8').replace(/\r\n/g, '\n');

function braced(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}
function args(s, i, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const b = braced(s, i);
    if (!b) return null;
    out.push(b.text); i = b.end;
  }
  return { args: out, end: i };
}

export function parseOld(tex) {
  const body = tex.split('\\begin{document}')[1];
  const title = /PRASAD RANE\}\\par\s*\\vspace\{[^}]*\}\s*\{\\fontsize\{[\d.]+pt\}\{[\d.]+pt\}\\bfseries\\selectfont\s*([\s\S]*?)\}\\par/.exec(body)?.[1].trim();
  const contact = /\{\\color\{muted\}\\fontsize\{[\d.]+pt\}\{[\d.]+pt\}\\selectfont\s*([\s\S]*?)\\par\}/.exec(body)?.[1].trim();
  const sec = (name) => {
    const re = new RegExp('\\\\resumesection\\{' + name + '[^}]*\\}');
    const m = re.exec(body);
    if (!m) return '';
    const rest = body.slice(m.index + m[0].length);
    const next = rest.search(/\\resumesection\{/);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };
  const summary = sec('PROFESSIONAL SUMMARY').replace(/\s+/g, ' ');
  const skills = [];
  for (const m of sec('TECHNICAL SKILLS').matchAll(/\\skillrow/g)) {
    const a = args(sec('TECHNICAL SKILLS'), m.index + '\\skillrow'.length, 2);
    if (a) skills.push(a.args.map((x) => x.trim()));
  }
  const exp = sec('PROFESSIONAL EXPERIENCE');
  const roles = [];
  const parts = exp.split('\\roleHeader').slice(1);
  for (const p of parts) {
    const a = args(p, 0, 4);
    const items = [...p.slice(a.end).matchAll(/\\item\s+([\s\S]*?)(?=\\item\s|\\end\{itemize\})/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    roles.push({ header: a.args.map((x) => x.trim()), items });
  }
  return { title, contact, summary, skills, roles };
}

const METRIC = [
  /\d[\d,]*(?:\.\d+)?\+?\\%\+?/g,
  /\d[\d,]*\+?\s?txn\/day/g,
  /\d+s to under \d+s/g,
  /(?:approximately |about |roughly )?\d+ seconds to under \d+ seconds/g,
  /(?:approximately |about )?\d+ (?:monthly )?business(?:-user)? changes/g,
  /hours to minutes/g,
  /(?:one week|1 week|about one week) to same-day/g,
  /(?:more than )?\d+ REST calls to (?:one|1)(?: GraphQL request)?/g,
  /(?:in |within )?(?:six|6) months/g,
];

export function boldMetrics(text) {
  // Skip regions that already sit inside \textbf{...}.
  const spans = [];
  const re = /\\textbf\{/g; let m;
  while ((m = re.exec(text))) {
    const b = braced(text, m.index + 7);
    if (b) spans.push([m.index, b.end]);
  }
  const inside = (i) => spans.some(([s, e]) => i >= s && i < e);
  const hits = [];
  for (const rx of METRIC) {
    rx.lastIndex = 0;
    while ((m = rx.exec(text))) if (!inside(m.index)) hits.push([m.index, m.index + m[0].length]);
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h[0] < last[1]) last[1] = Math.max(last[1], h[1]); else merged.push([...h]);
  }
  let out = ''; let pos = 0;
  for (const [s, e] of merged) { out += text.slice(pos, s) + '\\textbf{' + text.slice(s, e) + '}'; pos = e; }
  return out + text.slice(pos);
}

export function shortLabel(label) {
  const plain = (l) => l.replace(/\\&/g, '&');
  let l = label;
  if (plain(l).length <= 16) return l;
  l = l.replace('Infrastructure', 'Infra').replace('Developer', 'Dev').replace(/ Engineering/, ' Eng').replace(/ Systems$/, '');
  if (plain(l).length <= 16) return l;
  const first = l.split(' \\& ')[0];
  if (plain(first).length <= 16) return first;
  return first.split(' ').slice(0, 2).join(' ');
}

function build(old, { projects, dropFirst }) {
  const head = CANON.split('\\begin{document}')[0];
  const comment = `%----------------------------------------------------------------------------------------\n% PRASAD RANE - ${old.title.replace(/\\textbar\{\}/g, '|').toUpperCase()} RESUME\n% Rebuilt on the pinned canonical layout (documents/resume-format). 1-page, ATS-friendly.\n% Compile: pdflatex Prasad_Rane_Resume.tex\n%----------------------------------------------------------------------------------------\n\n`;
  const pre = comment + head.slice(head.indexOf('\\documentclass'));
  const fontLine = '\\begin{document}\n\\fontsize{10pt}{13pt}\\selectfont\n\n';
  const header = `{\\centering\n{\\fontsize{19.5pt}{21.5pt}\\bfseries\\selectfont PRASAD RANE}\\par\n\\vspace{2pt}\n{\\fontsize{10.5pt}{12.5pt}\\bfseries\\selectfont ${old.title}}\\par\n\\vspace{2pt}\n{\\color{muted}\\fontsize{10pt}{11pt}\\selectfont\n${old.contact}\\par}\n}\n\n`;
  const skills = old.skills.map(([l, v]) => `\\skillrow{${shortLabel(l)}}{${v}}`).join('\n');
  const roles = old.roles.map((r, i) => {
    const cap = i === 0 ? 7 : 3;
    let items = r.items.slice(0, cap);
    if (i === 0 && dropFirst) items = items.slice(0, Math.max(1, items.length - dropFirst));
    if (i === old.roles.length - 1 && old.roles.length > 3) items = []; // earliest role: header-only, as in canonical
    const h = `\\roleHeader{${r.header.join('}{')}}`;
    const list = items.length ? `\n\\begin{itemize}\n${items.map((t) => '\\item ' + boldMetrics(t)).join('\n')}\n\\end{itemize}` : '';
    return h + list;
  }).join('\n\\vspace{4pt}\n');
  const tail = CANON.slice(CANON.indexOf('\\resumesection{SELECTED PROJECTS}'));
  const eduOnly = tail.slice(tail.indexOf('\\resumesection{EDUCATION'));
  return pre + fontLine + header
    + `\\resumesection{PROFESSIONAL SUMMARY}\n${boldMetrics(old.summary)}\n\n`
    + `\\resumesection{TECHNICAL SKILLS}\n${skills}\n\n`
    + `\\resumesection{PROFESSIONAL EXPERIENCE}\n${roles}\n\n`
    + (projects ? tail : eduOnly);
}

function pages(texPath) {
  const dir = dirname(texPath);
  const r = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', basename(texPath)], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const p = spawnSync('pdfinfo', [texPath.replace(/\.tex$/, '.pdf')], { encoding: 'utf8' });
  return Number(/^Pages:\s+(\d+)/m.exec(p.stdout)?.[1]);
}

function main(argv) {
  const src = argv.find((a) => !a.startsWith('--'));
  if (!src) { console.error('Usage: node scripts/reslot-resume.mjs <old.tex> [--out new.tex]'); return 2; }
  const oi = argv.indexOf('--out');
  const out = oi >= 0 ? argv[oi + 1] : src;
  const old = parseOld(readFileSync(src, 'utf8'));
  const attempts = [
    { projects: true, dropFirst: 0 }, { projects: false, dropFirst: 0 },
    { projects: false, dropFirst: 1 }, { projects: false, dropFirst: 2 }, { projects: false, dropFirst: 3 },
  ];
  for (const a of attempts) {
    writeFileSync(out, build(old, a));
    const n = pages(out);
    if (n === 1) { console.log(`OK ${out} projects=${a.projects} droppedFirstRoleBullets=${a.dropFirst}`); return 0; }
  }
  console.error(`FAIL ${out}: does not fit one page after fallbacks`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('reslot-resume.mjs')) process.exit(main(process.argv.slice(2)));
