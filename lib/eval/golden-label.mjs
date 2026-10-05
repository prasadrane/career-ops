/**
 * golden-label.mjs — writes/updates ONE line per report# in data/eval/golden-user.jsonl (the user's
 * frozen corrections, read by the P4 probe). Reached only through `node eval-pipeline.mjs label ...`,
 * an explicit user action; probes never write it.
 *
 * Line shape: {"report":"064","archetype":"...","score":4.1,"label_source":"user-correction","note":"..."}
 * Validation: report 1-4 digits (stored zero-padded to 3), score finite in [1,5], archetype non-empty,
 * a reports/{###}-*.md file must exist unless force. Atomic write (temp file + rename); an existing
 * line for the same report number is replaced in place, other lines (incl. unparseable ones) are kept.
 * Not a probe: eval-pipeline.mjs lists it in NON_PROBE_FILES so discovery skips it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readReports } from './_data.mjs';

export const LABEL_SOURCE = 'user-correction';
const NOTE_MAX = 500;

/** Throws Error(message) on invalid input; returns {file, entry, updated}. */
export function labelGolden({ root, report, score, archetype, note = '', force = false }) {
  const rep = String(report ?? '').trim();
  if (!/^\d{1,4}$/.test(rep)) throw new Error(`report number must be 1-4 digits, got "${rep}"`);
  const s = Number(String(score ?? '').trim());
  if (String(score ?? '').trim() === '' || !Number.isFinite(s) || s < 1 || s > 5) {
    throw new Error(`--score must be a number between 1 and 5, got "${score ?? ''}"`);
  }
  const arch = String(archetype ?? '').replace(/\s+/g, ' ').trim();
  if (!arch) throw new Error('--archetype must not be empty');
  const num = rep.padStart(3, '0');
  if (!force && !readReports(root).some((r) => Number(r.num) === Number(rep))) {
    throw new Error(`no report file found for ${num} under reports/ (use --force to label anyway)`);
  }

  const entry = {
    report: num,
    archetype: arch,
    score: s,
    label_source: LABEL_SOURCE,
    note: String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX),
  };

  const dir = join(root, 'data', 'eval');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'golden-user.jsonl');
  const existing = existsSync(file) ? readFileSync(file, 'utf-8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()) : [];
  let updated = false;
  const out = existing.map((line) => {
    try {
      const o = JSON.parse(line);
      if (o && Number(o.report) === Number(rep)) { updated = true; return JSON.stringify(entry); }
    } catch { /* keep unparseable line untouched */ }
    return line;
  });
  if (!updated) out.push(JSON.stringify(entry));

  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${out.join('\n')}\n`);
  renameSync(tmp, file);
  return { file, entry, updated };
}
