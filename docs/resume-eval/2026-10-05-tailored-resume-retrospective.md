# Tailored resume retrospective, 2026-10-05

Scope: 52 tailored resumes (20 in `career-ops/output/`, 32 in `Prasad-Rane-Profile/profiles/prasad-rane/tailored/`), each with `.tex` and `.pdf`; 19 also have `.docx`. Measured by `scratchpad/audit.py` (preamble, fonts, margins, sizes, section list, bold count, PDF page count, DOCX fonts). Raw numbers: `audit.json` (same folder).

## Reference formats

| | User source `Prasad_Rane_Senior_SWE_Resume.tex` | "Canonical" `documents/resume-format/Prasad_Rane_Resume_Source.tex` (adopted 2026-10-04 20:31) | Generated (18 of the 20 career-ops files) |
|---|---|---|---|
| Font | mathptmx (Times) | helvet (Helvetica) | helvet |
| Body size | 10.5/13 | 10/13 | **9.0/11.5** |
| Margins L/R/T/B | 0.40/0.40/0.4/0.4 | 0.55/0.55/0.45/0.4 | **0.5/0.5/0.35/0.35** |
| Section headings | 12.5pt black | 11.5pt navy | 10.5pt navy |
| Role header | Title \| Company | Company \| Title | Company \| Title |
| Bold metrics in bullets | ~15 per CV | required by rule 5 | **0** |
| Selected Projects | yes | n/a | **dropped (18 of 20)** |
| Skills rows | inline `Label: values` | hanging 1.15in label box | hanging 1.15in label box |

All 32 `Prasad-Rane-Profile` tailored files match the user source (mathptmx, 10.5/13, 0.4in margins, 15 bold metrics). All 18 bulk-generated career-ops files (Anthropic through WorkOS, written 2026-10-05 14:33) do not match either reference. NetDocuments and Experian are older and use helvet 10/13 with bold metrics and projects.

## Findings

1. **Two competing "sources of truth".** The user's real `.tex` is Times. `modes/_custom.md` rule 5 points at a Helvetica file adopted 2026-10-04 20:31, seven hours after the user's source was last saved. The rule's description ("sans font", "0.55in margins") encodes the Helvetica variant, so an agent that follows the rule faithfully still produces a layout the user did not ask for.
2. **Generators did not copy the preamble; they regenerated it.** Rule 5 says "never change the preamble, macros, or layout". Generated files differ from the canonical file in margins (0.55/0.45 to 0.5/0.35), body size (10 to 9), section size (11.5 to 10.5), role-header size, header comment, and `\sep` spacing. Output was written by an LLM from a described layout, not by substituting slot text into the file.
3. **Overflow was handled by shrinking, the exact thing the rule forbids.** Rule 5: "trim bullets rather than shrink spacing or fonts". Generated resumes carry 12 to 14 bullets each, which does not fit at 10pt, so fonts dropped to 9pt (LangChain 8.5pt) and margins to 0.35in. Result: dense small text that reads as poor quality.
4. **Rule 5 requires bold metrics but no check enforces it.** 17 of 19 generated resumes have zero `\textbf` in the body, so the signature look (scannable numbers) is gone. Rule 1 (Google XYZ) pushed bullets into long sentences with `approximately` and parenthetical stacks, which also costs space.
5. **Visible layout defect.** `\skillrow` uses a fixed 1.15in label box; "Cloud & Infrastructure" and "Diagnostics & Audit" overflow it and collide with the value text in the PDF ("Cloud & InfrastructureAWS ECS...").
6. **Projects section silently dropped** (18 of 20), while the user source has it and the DOCX for Experian keeps it. No rule lists required sections.
7. **DOCX converter is not driven by the TEX.** `scripts/tex-to-docx.py` hardcodes Arial, 9.5pt bullets, 0.55/0.45 margins, a 0.2in indent, and navy headings. It regex-matches specific `\fontsize{19.5pt}` strings for the name and title, so any other size falls back to defaults. Effects: DOCX is Arial where the PDF is Helvetica (close) or Times (the 32 profile resumes, not covered here); body size ignores the TEX (8.5 to 10pt in TEX, always 9.5pt in DOCX); no hanging-indent skill labels; no real bullets or list structure (a typed "•" glyph, which also appears as a mojibake character in some viewers); page count is not verified. Bullet counts and text do match the TEX in all 19 files, so the inconsistency is formatting only.
8. **No evaluation gate.** Nothing compared the result to the source; the only check was "compiles to 1 page" (52 of 52 pass, which is why the problem was not caught).

## Root causes

- Process: generation is free-form LLM output with a prose description of the format, not a template with typed slots.
- Spec: the canonical file was copied from an earlier variant and rule 5 duplicates its details in prose, so they drift independently.
- Constraint conflict: a 1-page limit plus 12 to 14 bullets plus XYZ verbosity can only be satisfied by shrinking, and shrinking was not hard-blocked.
- Tooling: DOCX is a second hand-written layout, not derived from the PDF layout.
- Eval: the pass criterion (compiles, 1 page) is orthogonal to the property the user cares about (matches source).

## Fixes (proposed, not applied)

1. **Pick one source and pin it.** Decide whether the Times file (user source) or the Helvetica file is canonical; copy it verbatim to `documents/resume-format/` and delete the other from the rule's wording. Store a SHA-256 of the preamble (everything before `\begin{document}`).
2. **Slot-fill, don't regenerate.** Use `extract-latex-content.mjs` / `patch-latex-content.mjs` (already in the repo, used by `modes/latex-tex.md`) so only bullet and skill text can change; the preamble is physically untouched. Needs a layout family for the `\roleHeader`/`\skillrow` macros, or a small adapter.
3. **Format-lock checker (the eval).** New `verify-resume-format.mjs`: fail if the preamble hash differs from the canonical file, section list differs, bullets-per-role exceed a cap, body bold count is 0, or the PDF is not 1 page; warn on skill-label width overflow. Run it after every compile and in `test-all.mjs` over `output/**/Prasad_Rane_Resume.tex`.
4. **Overflow policy.** Hard cap: roles 6/3/1/1 bullets (matches the user source), 2 projects, then trim. No font or margin change allowed; the checker enforces it.
5. **Skill label fix.** Widen the label box to fit the longest label, or switch to the inline `\textbf{Label}: values` form used by the user source.
6. **DOCX from the same slots.** Make `tex-to-docx.py` read font family, sizes, margins and section order from the TEX preamble (or from the pinned canonical file), emit Word list bullets, keep Projects, and verify page count by converting the DOCX to PDF where possible (no LibreOffice or Word automation is installed here, so page count is currently unverified).
7. **Close the loop.** After each batch, append metrics to `data/resume-eval.tsv` (company, hash match, font, body size, margins, bold count, pages) and review failures before sending; add a regression row whenever the user reports a visual problem.

## Open questions for the user

- Which source is canonical: the Times file (`Prasad_Rane_Senior_SWE_Resume.tex`) or the Helvetica file adopted 2026-10-04?
- Should the 18 bulk-generated resumes be regenerated once the lock is in place?
