# Working on instruction-evals

- Regression cases live in `evals/cases.jsonl`, one JSON object per line with four string fields: `id`, `protects` (the file and section the case guards), `prompt`, and `pass` (the criterion the judge grades against).
- `run.ts` tests the committed ref, `HEAD` by default, in a throwaway git worktree. An edit you have not committed is not tested: commit it first, or pass `--ref <commit>`.
- To rerun specific cases: `bun run.ts --only <id>[,<id>...]`.
- A run exits 1 when any case fails or errors. Results land in `evals/results/<timestamp>-<sha>.jsonl`.
- When a case fails after a change, fix the instructions the case protects. Never loosen a `pass` criterion to make a run go green.
