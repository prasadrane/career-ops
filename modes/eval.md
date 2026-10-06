# Mode: eval — Is the pipeline itself working?

Run the deterministic pipeline scorecard and present it. Where `calibrate` asks "do the scores predict MY outcomes?", `eval` asks the same question one level up, per phase: sources, search filter, liveness/dedup, scoring, tailoring, outcomes.

> **Non-negotiables:**
> - **Advisory only.** This mode NEVER edits scoring rules, thresholds, `modes/_shared.md`, `portals.yml`, `config/profile.yml`, `modes/_profile.md`, or `cv.md`. It reports evidence; the user decides what to change. The only files the scripts write are under `data/eval/` (`runs.tsv`, `proposals.md`, `golden-user.jsonl`).
> - **Deterministic.** Every number comes from `eval-pipeline.mjs` (local parsing, no network, no LLM math). Do not recompute, round differently, or "improve" any figure it prints.
> - **Honest floors.** If a rate prints as `(n too small)`, present it that way. Never turn a 2-of-3 anecdote into a percentage.
> - **No auto-tuning.** Nothing here feeds back into evaluations automatically. A proposal is text for the user to read, not a change.

## Pipeline

1. Print the scorecard:
   ```bash
   node eval-pipeline.mjs --summary
   ```
   Use `--phase p1..p6` to focus on one phase and `--since 30d` to change the window. Each run appends a snapshot to `data/eval/runs.tsv` (add `--no-record` for a dry look).
2. Run `node eval-pipeline.mjs --json` when you need the structured detail behind a verdict (per-source yield, dropped-title sample, per-artifact coverage). Never paraphrase the JSON in place of the scorecard.
3. Present, in this order:
   - **The scorecard VERBATIM**, as the script prints it, including the `overall:` line (the worst phase).
   - **One line per phase** explaining its verdict in plain words, from the `findings` the script printed:

     | Phase | What the verdict answers |
     |---|---|
     | p1 sources | Are boards and MCP connectors healthy and yielding new postings? |
     | p2 search filter | Does the title filter keep the right titles and drop the wrong ones? |
     | p3 liveness/dedup | Are postings real and open, or unconfirmed/aggregator-only/reposted? (`insufficient-data` until real liveness evidence exists) |
     | p4 scoring | Do reports still agree with the user's own frozen labels (`golden-user.jsonl`)? |
     | p5 tailoring | Do tailored CVs pass the fact gate and cover the JD at least as well as `cv.md`? |
     | p6 outcomes | Are there enough resolved outcomes to say anything (usually `insufficient-data` early on)? |

   - A phase marked `insufficient-data` is a statement about missing data, not a pass. Say which input is missing.
4. Offer the two follow-ups, never run them unasked:
   - **Proposals:** `node eval-pipeline.mjs --propose` also writes `data/eval/proposals.md` (suggest-only items, each citing its metric and evidence, e.g. "source X: 0 adds in last 3 runs -> consider disabling"). Read the file with the user; they apply any change themselves.
   - **Label a report** to build the p4 reference set: `node eval-pipeline.mjs label <report#> --score X --archetype Y [--note ..]`. This stores the user's own correction in `data/eval/golden-user.jsonl`; it refuses when no `reports/{###}-*.md` exists unless `--force`. Only record a label the user states.
5. For a `fail` phase, offer to walk through the specific evidence (for example the lowered-coverage bullets for p5, the mismatched archetypes for p4). That reading is a conversation, not an automatic fix.

## What this mode must never do

- Suggest editing `modes/_shared.md` or any scoring rule on the strength of one scorecard. If asked "so should we change the scoring?", the honest answer is that global scoring stays as is; the evidence supports adjusting the user's own sources, title keywords and apply threshold, which is their call.
- Disable a source, edit `portals.yml` or add title keywords itself. Proposals are suggestions.
- Treat a scorecard as proof of quality: p2 recall and p4 agreement are samples with stated floors.

`verify-pipeline.mjs` warns when `data/eval/runs.tsv` exists and its newest row is more than 14 days old; re-running this mode clears the warning.
