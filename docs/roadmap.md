# Roadmap

Principle: infrastructure first, virality second, marketplace last. A store of untested prompts is a liability; every stage below earns the next.

## v0.1 — the compiler exists (weeks 1–6)

The single sharpest claim, working: **write once, run everywhere.** A deliberately thin slice — trying to ship compiler + registry + lore + pipelines in v0 is how projects die with nothing finished. One skill through one compiler into three agents, done incredibly well.

- ✅ KSF spec draft (`spec/SPEC.md`) + JSON schema, versioned.
- ✅ CLI: `init`, `install` (gh: / file: sources only), `remove`, `list`, `compile`, `doctor` — working, e2e-tested in CI.
- ✅ Adapters: `claude-code`, `cursor`, and the `agentsmd` floor (which also covers Codex and everything else that reads AGENTS.md).
- ✅ Budget + standing enforcement at compile; visible degradation warnings; `--strict`.
- **One** first-party skill, dogfooded on this repo: `prereview` (no learn mode yet).
- npm publish.
- Exit criterion: a stranger installs a skill from a GitHub URL into a Cursor + Claude Code team repo in under two minutes.

Deferred out of v0.1 on purpose: more adapters, more skills, index, evals tier 2+, lore. The compiler creates users; everything else needs users first.

## v0.2 — trust and transparency (weeks 6–10)

- `kitbash.lock` with directory content hashes; reproducible installs.
- Dependency resolution: skill-to-skill `[dependencies]`, transitive closure pinned in the lockfile, cycle detection.
- `kitbash update` with instruction-level diff review; `kitbash diff <skill> <v1> <v2>` for instruction/permission/budget diffs between any two versions.
- `kitbash lint`: schema, context budgets (measured against compiled output), dead references, injection heuristics.
- `kitbash audit`: scan *installed* skills — permission drift since install, unsigned sources, injection heuristics. `npm audit` for skills.
- `kitbash preview <skill>`: the playground — render exactly what each adapter will emit, with per-agent token counts, before installing.
- `kitbash explain <skill> <adapter>`: why a compilation degraded — which required capability the adapter lacks, what got rewritten.
- Permissions manifest compiled to Claude Code permission rules; advisory elsewhere, honestly labeled.
- Remaining launch adapters: `copilot`, `codex` (native prompts beyond the AGENTS.md floor).
- Second and third first-party skills: `excavate`, `plan`.
- Exit criterion: no code path exists where a skill's instructions change on disk without a human seeing a diff.

## v0.3 — proof (weeks 10–16)

- Eval tiers 1–2 in `kitbash test`; behavioral evals (tier 3) on `claude -p` first, other headless CLIs as available.
- Gates: `kitbash gate run <skill>` with deterministic exit codes; pre-push + GitHub Actions recipes.
- `verify` and `triage` skills ship (they need the eval/gate machinery).
- Artifacts v1: `plan@1`, `findings@1`, `verify@1` schemas frozen.
- Exit criterion: prereview's eval suite runs in this repo's CI and blocks regressions to the skill itself.

## v0.4 — distribution (weeks 16–24)

- Community index (registry repo, Homebrew-tap model): `kitbash install prereview` short names, `kitbash search`.
- `kitbash publish` (validates, tags, points the index).
- Loadouts: `kitbash install loadout:oss-maintainer`.
- Remaining adapters: `gemini-cli`, `windsurf`, `opencode`, `cline`, `aider`.
- Docs site with the skill catalog + measured eval results per skill.
- Skill badges, measurement-only: eval pass rate, compiled token cost, auto-derived compatibility matrix, signed status. No star ratings — measurement over popularity, by design.
- **Launch moment.** The demo is one command turning a bare repo into a four-assistant, team-standard setup. Ponytail proved a single good skill can pull 75k stars; ours ride on infrastructure others can build on, which is the durable version of that story.

## v0.5 — memory (months 6–9)

- Lore layer: `kitbash lore build` (mining PRs/history into proposed entries), curation flow, per-skill lore queries within budget.
- `prereview --learn`, `onboard`, `migrate` ship (all lore-dependent).
- Pipelines v1: declared graphs, `kitbash run ship`.

## v1.0 — the standard (months 9–15)

- KSF spec 1.0 freeze + conformance test suite for third-party adapters.
- Signing (sigstore) + index review tiers: community / audited / verified.
- Org/private indexes for teams; monorepo scoping.
- Governance: spec changes via public RFC; core team ≥ 3 maintainers not from one employer.

## Adoption strategy, stated plainly

1. **Wedge:** `prereview` — the skill with the clearest measurable payoff (fewer human review comments), portable to every teammate's assistant on day one.
2. **Moat:** evals + lockfile trust — the parts prompt packs structurally cannot bolt on, and platforms won't build cross-vendor.
3. **Flywheel:** every team's lore makes their skills better → skills feed lore back → switching cost is your own project's accumulated intelligence, which you can nonetheless export at any time (it's markdown in your repo — the moat is value, not lock-in).

## Risks, honestly

- **Platforms converge on a shared format** (AGENTS.md++). Mitigation: be the reference implementation and compiler for it; we win faster in that world.
- **Behavioral evals cost real money.** Mitigation: tiered testing; tier 3 opt-in and cached; fixture repos kept small.
- **Injection lint gives false confidence.** Mitigation: label it heuristic everywhere; the trust story leans on hashes + human diff review, not the scanner.
- **Scope creep toward agent framework.** Mitigation: non-goals list in design.md is load-bearing; adapters stay thin.
