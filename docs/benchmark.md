# modsym benchmark note (12 paired tasks)

Small internal A/B check, not a marketing claim. Do not cite as
"reduces tokens by X%" — the evidence does not support that.

## Setup

- 12 small TypeScript bug-fix tasks (10 requiring API inspection across
  zod, date-fns, axios, commander, zustand, pino, hono, openai, jotai,
  AI SDK; 2 negative controls where inspection was unnecessary).
- Each task run twice in isolated dirs from the same installed state:
  control (ordinary tools only, never told about `modsym`) vs treatment
  (same task plus one sentence: "`modsym` is available on PATH …
  if useful").
- Same model/settings per pair; order randomized per task.
- Recorded per run: correctness (`tsc` + content checks), package-
  inspection shell calls, stdout bytes from inspection, `modsym` adoption.

## Results

- Correctness: control 12/12, treatment 12/12. Blind re-judging found
  final fixes byte-identical per pair (each task had one natural fix),
  so quality was tied throughout.
- Adoption: treatment used `modsym` on 10/12 runs (all 10 positives),
  correctly ignoring it on both negatives. Early use in all 10.
- Inspection calls: control median 0, mean 2.3; treatment median 3.0,
  mean 3.5. No median reduction — 7 controls solved with zero
  inspection from `tsc` hints and prior knowledge, while treatments
  probed `modsym` 2–8 times anyway.
- Inspection bytes: control median 0 B, mean ~4.8 kB; treatment median
  ~1.8 kB, mean ~1.7 kB (~63% mean reduction, driven by outliers).
- Pairwise (fewer calls wins, same correctness): `modsym` better on 3
  (zod 13→6 calls / 21.9→2.7 kB; hono 8→2 / 25.4→0.9 kB; date-fns
  4→3 / 7.6→0.8 kB), tie on 2 negatives, control cheaper on 7
  (typically 0 vs 2–8 added `modsym` probes, ~1–3.5 kB overhead each).

## Reading

- On export-heavy declarations (deep barrels, subpath middleware,
  locale entrypoints) `modsym` replaced a multi-call `rg`/`cat` walk
  with one small JSON answer.
- On trivial cases (`tsc` already says "did you mean `baseURL`?",
  single-file `index.d.ts`, locally mirrored patterns) controls needed
  no inspection, so `modsym` only added calls.
- No correctness harm observed; no `modsym`-plus-full-manual double
  work observed. Failed `modsym` probes (non-bare symbols correctly
  abstained) were the main overhead source.

Full per-task transcripts and counts are retained with the internal
report; this file records the headline with negatives preserved.
