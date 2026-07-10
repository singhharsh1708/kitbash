Review the current diff against this team's conventions and invariants before it ships. Invoke with /prereview before opening a PR, or run as a pre-push gate.

## Procedure

1. Collect the diff under review: staged changes if any, otherwise the branch diff against the default branch. Review **only** lines in the diff.
2. If a plan artifact exists at {{artifact.plan}}, read it: the review must check the diff against the plan's stated intent and flag unexplained divergence.
3. First pass — correctness only: bugs, unhandled failure paths, concurrency hazards, security issues. For each finding, construct the concrete failure scenario (inputs/state → wrong outcome). Discard findings without one.
4. Second pass — team standards. Check the diff against each entry in:

{{lore.conventions}}

{{lore.invariants}}

   A convention finding MUST cite the convention id. Never report a style opinion that lacks a lore citation.
5. Write findings to `.kitbash/artifacts/findings.json` (`findings@1` schema), most severe first: `file`, `line`, `severity` (high/medium/low), `summary` (one sentence), `scenario`, `convention` (id or null).
6. Report to the user: one line per finding — `path:line severity: defect. fix.` No praise, no summaries of what the code does, no findings outside the diff.

## Gate mode

When run as a gate, exit nonzero if any finding has severity high. The verdict comes from the artifact contents, not prose.

## Boundaries

- Do not fix anything unless explicitly asked; report only.
- If the diff exceeds what you can review honestly, review file-by-file and state which files got a shallower pass.
- If there are no lore conventions yet, say so once and proceed with the correctness pass only.
