# Kitbash RFCs

Spec-level changes — KSF fields, artifact schemas, adapter conformance rules, trust model — go through RFCs, not directly to PRs against `spec/`. This is how compiler and language ecosystems keep their formats stable enough to build on.

## Process

1. Copy [`0000-template.md`](0000-template.md) to `rfcs/0000-my-feature.md`.
2. Open a PR. Discussion happens on the PR.
3. On acceptance, the RFC gets the next number and merges with status `accepted`. Rejected RFCs merge too, with status `rejected` and the reasoning — a documented "no" saves the next person the same detour.
4. Implementation PRs reference the RFC.

Small fixes (typos, clarifications that don't change meaning) skip this process.

## Accepted

| RFC | Title | Status |
|---|---|---|
| [0001](0001-ksf.md) | Kitbash Skill Format (KSF) | accepted (draft spec) |
| [0002](0002-ksf-1.0-stabilization.md) | KSF 1.0 stabilization | proposed |
