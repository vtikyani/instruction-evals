# instruction-evals

Regression tests for the instructions you give an AI coding agent (`CLAUDE.md`, rules files, skills).

Every time an agent gets something wrong, you add a rule to its instructions. Later edits quietly break older rules, and you only find out when the old mistake comes back. This catches that: each case is a past lesson written as a question plus a pass criterion. The runner checks out a given commit in a throwaway git worktree, asks a fresh Claude Code session the question there (so it sees only the instructions at that commit), and has a second, cheaper model grade the answer against the criterion.

## How a run works

1. `git worktree add` at the ref you name (`HEAD` by default). Uncommitted edits are not tested.
2. The cases file and past results are deleted from that worktree, so the answering model can't read the criteria.
3. Each case runs `claude -p` in the worktree with read-only tools (`Read`, `Grep`, `Glob`), no MCP servers, and no saved session.
4. A judge model grades the answer against `pass` with a JSON schema, returning `pass` and a one-sentence reason.
5. Results are written to `evals/results/<timestamp>-<sha>.jsonl` with the answer, verdict, reason, cost, and time per case. The process exits 1 on any fail or error, so it can gate CI or a pre-merge hook.

## Setup

Requirements: [Bun](https://bun.sh) and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), logged in.

Add `evals/cases.jsonl` to the repo whose instructions you want to test, one case per line:

```json
{"id": "add-case", "protects": "CLAUDE.md#cases format", "prompt": "How do I add a new regression case?", "pass": "Says to add one JSON line to evals/cases.jsonl with the fields id, protects, prompt, and pass."}
```

`protects` names the file and section the case guards, so a failure points at what to fix.

## Run

```bash
bun run.ts --repo ~/code/my-agent                 # all cases at HEAD
bun run.ts --repo ~/code/my-agent --ref abc1234   # a past commit, to find where a rule broke
bun run.ts --only add-case,rerun-one              # selected cases
bun run.ts --sparse docs,skills                   # large repo: root files plus these dirs only
bun run.ts --model sonnet --judge-model haiku     # defaults: claude-opus-5-5 answers, haiku judges
```

Other flags: `--cases <file>` (default `evals/cases.jsonl` in the repo), `--out <dir>`, `--concurrency N` (default 4), `--keep` (leave the worktree in your temp dir for inspection).

This repo tests itself: `CLAUDE.md` holds the rules for working on it and `evals/cases.jsonl` checks that an agent follows them. Run `bun run.ts` from the repo root.

## Writing good cases

- Ask the question the way it came up when the agent got it wrong, not as a quiz about the rule.
- Put the key fact in `pass` and keep the wording loose; the judge is told to be strict on facts and lenient on phrasing.
- When a case fails, fix the instructions. Loosening `pass` to get a green run defeats the point.

## License

MIT
