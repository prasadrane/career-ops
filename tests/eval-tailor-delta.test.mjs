import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import probe from '../lib/eval/p5-tailor-delta.mjs';

const SINCE = new Date('2026-08-01T00:00:00Z');
const mkRoot = () => mkdtempSync(join(tmpdir(), 'eval-p5-'));
const w = (root, rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };

// 10 JD keywords. base cv.md covers 7 (70%).
const KW = ['Python', 'Kubernetes', 'Terraform', 'PostgreSQL', 'Kafka', 'Airflow', 'Docker', 'Rust', 'Go', 'Spark'];
const CV_MD = [
  '# Jane Doe', '', '## Experience', '',
  '### Acme — Berlin', '**Engineer**', '2020-2024', '',
  '- Built Python services on Kubernetes', '- Wrote Terraform modules', '- Tuned PostgreSQL clusters',
  '- Ran Kafka pipelines', '- Scheduled Airflow DAGs', '- Packaged Docker images', '',
].join('\n');

const core = '<p>Built Python services on Kubernetes</p><p>Wrote Terraform modules</p><p>Tuned PostgreSQL clusters</p><p>Ran Kafka pipelines</p><p>Packaged Docker images</p>';
const TAILORED_60 = core;                                    // 6/10 = 60 (Airflow lowered, nothing gained)
const TAILORED_EQ = core + '<p>Scheduled Airflow DAGs</p>';  // 7/10 = 70
const TAILORED_UP = TAILORED_EQ + '<p>Rust</p><p>Go</p><p>Spark</p>'; // 10/10

function many(root, n, html) {
  w(root, 'cv.md', CV_MD);
  const rows = ['# report\tpdf\thtml\tformat\tdate\tkind'];
  for (let i = 1; i <= n; i++) {
    const slug = `co${i}`;
    const num = String(i).padStart(3, '0');
    w(root, `reports/${num}-${slug}-2026-09-01.md`,
      `# Evaluation: ${slug}\n\n**Score:** 4.2/5\n\n## Keywords extracted\n${KW.join(', ')}\n\n## Job Description (archived verbatim)\nWe need ${KW.join(' ')}.\n`);
    w(root, `output/cv-jane-${slug}.html`, `<html><body>${html}</body></html>`);
    rows.push(`${num}\toutput/cv-jane-${slug}.pdf\toutput/cv-jane-${slug}.html\tletter\t2026-09-${String(i).padStart(2, '0')}\tcv`);
  }
  w(root, 'data/pdf-index.tsv', rows.join('\n') + '\n');
}

test('empty root -> insufficient-data, no throw', async () => {
  const root = mkRoot();
  try {
    const r = await probe({ root, since: SINCE });
    assert.equal(r.phase, 'p5');
    assert.equal(r.verdict, 'insufficient-data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fewer than 5 tailored artifacts -> insufficient-data', async () => {
  const root = mkRoot();
  try {
    many(root, 3, TAILORED_60);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.verdict, 'insufficient-data');
    assert.equal(r.metrics.artifacts, 3);
    assert.equal(r.metrics.coverageDelta, '(n too small)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tailored 60% vs base 70% -> fail, lists lowering keyword (Airflow) and its cv.md bullet', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_60);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.artifacts, 5);
    assert.equal(r.metrics.baseCoverage, 70);
    assert.equal(r.metrics.tailoredCoverage, 60);
    assert.equal(r.metrics.coverageDelta, -10);
    assert.equal(r.verdict, 'fail');
    const lowered = r.detail.artifacts.flatMap((a) => a.lowered);
    assert.ok(lowered.some((l) => l.keyword === 'Airflow' && /Airflow DAGs/.test(l.bullet)));
    assert.ok(r.findings.some((f) => /Airflow/.test(f)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tailored covering more than base by >=2pp -> pass', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_UP);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.coverageDelta, 30);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.metrics.factViolations, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('delta between 0 and 2 -> warn', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_EQ);
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.coverageDelta, 0);
    assert.equal(r.verdict, 'warn');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invented metric in tailored HTML -> factViolations > 0 -> fail even with good coverage', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_UP + '<p>Cut latency by 97% across 4200 services</p>');
    const r = await probe({ root, since: SINCE });
    assert.ok(r.metrics.factViolations > 0);
    assert.equal(r.verdict, 'fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('payload JSON beside the HTML is checked; missing payloads count as unverified, never pass', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_UP);
    w(root, 'output/cv-jane-co1.json', JSON.stringify({ experience: [{ company: 'Acme', role: 'VP of Engineering', dates: '2020-2024' }] }));
    const r = await probe({ root, since: SINCE });
    assert.equal(typeof r.metrics.titleDrift, 'number');
    assert.equal(r.detail.unverified, 4);
    assert.ok(r.findings.some((f) => /unverified/i.test(f)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('falls back to output/cv-*.html matched by report slug when there is no pdf-index', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_UP);
    rmSync(join(root, 'data', 'pdf-index.tsv'));
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.artifacts, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact whose report has no keywords is skipped, not counted', async () => {
  const root = mkRoot();
  try {
    many(root, 5, TAILORED_UP);
    w(root, 'reports/001-co1-2026-09-01.md', '# Evaluation\n\n**Score:** 4.2/5\n');
    const r = await probe({ root, since: SINCE });
    assert.equal(r.metrics.artifacts, 4);
    assert.equal(r.verdict, 'insufficient-data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
