# Flagship skills catalog

First-party skills, dogfooded on this repo before release. Each exists because it moves a real lever — fewer review cycles, faster onboarding, fewer bugs — not because a model *can* do it. Selection rule: if a frontier model already does it well from a bare prompt, it's not a skill; skills earn their place through project grounding (lore), enforcement (gates), or composition (artifacts).

Pipeline they form:

```
/excavate ──▶ lore ◀────────────┐
                ▲               │
/plan ──plan@1──▶ (implement) ──▶ /verify ──verify@1──▶ /prereview ──findings@1──▶ /release
                                                    ▲
/triage ◀── CI failures ────────────────────────────┘
```

---

## 1. prereview — the review gate that knows your team

**Purpose.** Run your team's *actual* review standards against a diff before it ships — standards mined from what reviewers on this repo really flag, not a generic checklist.

**Problem it solves.** Review cycles are the #1 latency in team development. Most review comments are the same twelve things per team, repeated forever. Generic AI review misses them because it doesn't know *this team's* twelve things.

**Example usage.**
```
/prereview                      # review working diff
kitbash gate run prereview      # pre-push hook / CI, deterministic exit code
/prereview --learn              # mine merged PR threads, propose convention entries
```

**Internal workflow.** (1) Load conventions and invariants from lore. (2) Diff-scoped review pass: correctness, then team conventions with citation to the lore entry. (3) Emit `findings@1`; in gate mode, fail on `severity >= high`. (4) `--learn` mode: cluster past PR review comments, propose new lore convention entries as a reviewable PR.

**Commands.** `/prereview [ref]`, `--learn`, `--fix` (apply low-risk findings), gate mode via CLI.

**Configuration.** `fail_on = "high"`, `max_findings = 20`, `learn.min_recurrence = 3`.

**Prompt template (core).**
```
Review only the diff. For each finding: file:line, severity, one-sentence defect,
concrete failure scenario. Check team conventions below; cite the convention id
for any violation. Do not praise. Do not comment on code outside the diff.
Conventions: {{lore.conventions}}  Invariants: {{lore.invariants}}
```

**Success criteria.** Measured drop in human review comments per PR after 4 weeks; behavioral eval catches ≥ 90% of seeded defects in fixture repos; false-positive rate < 20% (findings dismissed by humans).

**Failure cases.** Empty lore → degrades to generic review (warns, links `--learn`). Noisy learn-mode proposals → human curation is the boundary; proposals arrive as PRs. Diff too large → chunks by file, states coverage honestly.

**Extensibility.** Convention packs per ecosystem (rust, react); custom finding sinks (GitHub PR comments, SARIF for code scanning).

---

## 2. excavate — the code archaeologist

**Purpose.** Answer "why is this code like this?" with evidence: the commit, PR discussion, and issue that made it so — and record the answer durably.

**Problem it solves.** The most expensive question in a mature codebase. The answer exists — scattered across git blame, closed PRs, dead Slack threads. Every developer re-excavates it; nobody writes it down.

**Example usage.**
```
/excavate why does src/sync/queue.ts debounce writes by 800ms?
/excavate what has touched the billing retry logic this year, and why?
```

**Internal workflow.** (1) Locate the code; walk `git log -L` / blame across renames. (2) Pull the PRs behind decisive commits (`gh pr view`), extract review discussion. (3) Follow linked issues. (4) Synthesize a cited answer: *decision, forces, evidence links*. (5) Offer to file it as a lore `decisions/` entry — the answer is never excavated twice.

**Commands.** `/excavate <question>`, `--depth <n>` (commits to walk), `--record` (skip the prompt, file the lore entry).

**Configuration.** `sources = ["git", "github"]` (gitlab adapter later), `auto_record = false`.

**Prompt template (core).**
```
Question: {{question}}. Evidence gathered: {{commits}} {{pr_threads}} {{issues}}.
Answer with: the decision, the forces that drove it, what would break if reversed.
Every claim cites a commit or PR. If evidence is insufficient, say what's missing —
do not invent history.
```

**Success criteria.** Answers carry ≥ 1 citation per claim; behavioral eval on repos with known history answers seeded questions correctly; lore grows monotonically with use.

**Failure cases.** Squash-merged repos with gutted history → degrades to "code says X, history unavailable," flagged clearly. Private tracker links it can't reach → lists them as unfollowed leads rather than guessing.

**Extensibility.** Source adapters (GitLab, Linear, Jira); team-chat importers where APIs allow.

---

## 3. triage — the CI failure investigator

**Purpose.** Turn a red CI run into a classified verdict — *flake / environment / real regression* — with the evidence, and either a retry, a quarantine PR, or a bisected culprit.

**Problem it solves.** CI babysitting is pure context-switching tax. Distinguishing flake from regression is rote evidence-gathering that agents do well and humans hate.

**Example usage.**
```
/triage                       # latest failing run on current branch
/triage 18423 --bisect        # specific run, bisect if real
```

**Internal workflow.** (1) Fetch failing run logs (`gh run view --log-failed`). (2) Extract the decisive error, not the last 500 lines. (3) Cross-reference: does the failure touch files this diff touched? has this test failed on main recently (flake history)? (4) Classify with confidence. (5) Real → reproduce locally, optionally bisect; flake → link history, optionally open quarantine PR; env → identify the drifted dependency/runner.

**Commands.** `/triage [run-id]`, `--bisect`, `--quarantine`, gate mode for merge queues.

**Configuration.** `ci = "github-actions"` (adapters: circle, buildkite), `flake_window = "30d"`, `quarantine_label = "flaky-test"`.

**Prompt template (core).**
```
Failing run: {{log_excerpt}}. Diff under test: {{diff_summary}}.
Recent failures of same tests on main: {{flake_history}}.
Classify: flake | environment | regression. State the single decisive log line.
If regression: name the most likely culprit file in this diff and why.
```

**Success criteria.** Classification accuracy ≥ 85% on a labeled fixture set of real CI failures; median time-to-verdict under 2 minutes; zero silent retries of real failures.

**Failure cases.** Log access denied → asks for `gh` auth once, degrades to paste-your-log. Genuinely novel infra failures → says "unknown," never force-fits a class. Bisect on flaky test → detects instability first (runs test 3× at HEAD).

**Extensibility.** CI adapters; flake-history export to dashboards; auto-file issues with the evidence bundle.

---

## 4. plan — issue to implementation plan, with receipts

**Purpose.** Turn an issue/feature request into a file-level implementation plan — touchpoints, risks, test plan — as a `plan@1` artifact that downstream skills consume.

**Problem it solves.** Agents (and juniors) fail mostly at *scoping*, not syntax: touching the wrong layer, missing the second caller, no test plan. A reviewed plan catches this before any code exists — the cheapest possible review cycle.

**Example usage.**
```
/plan #247
/plan "add rate limiting to public API"
```

**Internal workflow.** (1) Read issue thread + linked context. (2) Map the affected subsystem via lore `map.md` + targeted search. (3) Draft: files to touch and why, files deliberately *not* touched, ordered steps, risks with mitigations, test plan, rollback story. (4) Emit `plan@1`; human approves or edits; the artifact then grounds implementation and gives `/verify` and `/prereview` their contract.

**Commands.** `/plan <issue|description>`, `--revise` (update after feedback), `--estimate` (complexity classes, not fake hours).

**Configuration.** `require_test_plan = true`, `require_rollback = "for:migrations"`.

**Prompt template (core).**
```
Task: {{issue}}. Subsystem map: {{lore.map}}. Conventions: {{lore.conventions}}.
Produce plan@1: per file — path, change intent, why this file. List files you
considered and rejected. Risks ranked by blast radius. Test plan naming real
test files. If the task is underspecified, list the questions instead of guessing.
```

**Success criteria.** Plans reviewed-and-approved without edits ≥ 60% of the time after tuning; implementations that follow an approved plan show measurably fewer prereview findings.

**Failure cases.** Underspecified issue → outputs questions, refuses to fake certainty. Stale lore map → plan cites it; wrongness surfaces at review and drives a map fix (self-correcting loop).

**Extensibility.** Tracker adapters (GitHub, Linear, Jira); plan templates per change class (migration, feature, hotfix).

---

## 5. verify — proof the change actually works

**Purpose.** Drive the changed behavior end-to-end — run the app, hit the endpoint, click the flow — and record evidence as `verify@1`. Tests passing is not the bar; *observed behavior* is.

**Problem it solves.** The classic agent failure: "all tests pass" on a change that doesn't work. Type-checks and unit tests are proxies; nobody watches the agent actually exercise the feature.

**Example usage.**
```
/verify                        # verify working diff against its plan@1
kitbash gate run verify        # block push until verified
```

**Internal workflow.** (1) Read `plan@1` (or infer scope from diff). (2) Determine the runtime surface: server endpoint, CLI invocation, UI flow. (3) Launch the app per project run config, drive the flow, capture evidence (responses, exit codes, screenshots where supported). (4) Compare against the plan's stated intent. (5) Emit `verify@1` with pass/fail per flow + evidence paths.

**Commands.** `/verify [--flow <name>]`, gate mode.

**Configuration.** `run = "npm run dev"`, `ready_when = "http://localhost:3000/healthz"`, per-flow drivers.

**Prompt template (core).**
```
Change intent: {{plan.intent}}. Diff: {{diff_summary}}.
Drive the affected flow in the running app. Record: command/request sent,
observed response, expected response, verdict. A test suite result is
supporting evidence, never the verdict itself.
```

**Success criteria.** Behavioral eval: seeded "tests pass but feature broken" fixtures are caught ≥ 95%; every `verify@1` contains reproducible evidence a human can replay.

**Failure cases.** App won't launch → that *is* the finding (fail with launch log). No drivable surface (pure library) → falls back to executing the public API in a scratch script and says so. Nondeterministic flows → retries with seed control, reports flakiness rather than guessing.

**Extensibility.** Flow drivers (HTTP, CLI, browser via playwright, mobile later); evidence sinks (PR comment with screenshots).

---

## 6. migrate — checkpointed campaign runner

**Purpose.** Execute long-running mechanical campaigns — dependency major bumps, API migrations, framework upgrades — as resumable, checkpointed batches with a gate between each.

**Problem it solves.** Migrations die in the middle: half-converted codebases, a branch nobody can rebase. One giant agent session hits context limits and produces an unreviewable 400-file diff.

**Example usage.**
```
/migrate plan "react-router v5 → v6"        # produces campaign plan + batch graph
/migrate run --batch next                    # one reviewable batch at a time
/migrate status
```

**Internal workflow.** (1) Inventory every occurrence of the old pattern; cluster into batches by subsystem and risk. (2) Persist campaign state in `.kitbash/artifacts/migrate/<name>.json`. (3) Each `run`: convert one batch, run `verify` + `prereview` gates, stop at a clean reviewable commit. (4) Resumable across sessions, machines, and teammates — state is in the repo, not the chat.

**Commands.** `plan`, `run [--batch <id|next>]`, `status`, `abort --batch` (revert one batch cleanly).

**Configuration.** `batch_max_files = 15`, `gates = ["verify", "prereview"]`, `stop_on = "gate-fail"`.

**Prompt template (core).**
```
Campaign: {{campaign.rule}}. This batch: {{batch.files}}.
Apply the transformation exactly; when a case doesn't match the rule,
add it to exceptions with reasoning — do not improvise a conversion.
The batch must end green: {{gates}}.
```

**Success criteria.** Campaigns complete across ≥ 3 sessions without state loss; every batch lands as an independently revertable commit; exception list surfaces genuinely hard cases rather than silent misconversions.

**Failure cases.** Pattern too irregular for batching → `plan` says so upfront and recommends manual-with-assist. Mid-batch gate failure → batch reverts to checkpoint, failure recorded, campaign continues on next batch.

**Extensibility.** Codemod backends (ast-grep, jscodeshift) for the deterministic core with LLM handling only the irregular tail; campaign templates for common migrations, shared via the registry.

---

## 7. onboard — the guided tour that builds itself

**Purpose.** Generate a personalized, task-anchored tour of the codebase for a new contributor — grounded in lore, ending at a real first issue.

**Problem it solves.** Onboarding is weeks of interrupt-driven archaeology. READMEs describe the project; nobody documents *how to navigate* it — and docs rot because they're written once and never regenerated.

**Example usage.**
```
/onboard --role backend --first-issue
/onboard --explain src/sync/         # focused subsystem tour
```

**Internal workflow.** (1) Read lore map, decisions, conventions. (2) Rank subsystems by relevance to role + recent activity. (3) Generate a staged tour: entry points, the three core flows traced end-to-end, "read these 5 files in this order," conventions that will bite you. (4) Pick a good-first-issue matching the toured area. (5) Tour is regenerated on demand — never a stale wiki page.

**Commands.** `/onboard [--role <r>] [--first-issue] [--explain <path>]`.

**Configuration.** `roles = ["frontend", "backend", "infra"]`, issue label for starters.

**Prompt template (core).**
```
New {{role}} contributor. Lore: {{lore.map}} {{lore.conventions}}.
Build a tour: (1) how a request/build flows end-to-end with file:line waypoints,
(2) five files to read in order and what each teaches, (3) three conventions
that will surprise them, cited. Anchor everything to current code — verify
every path exists before citing it.
```

**Success criteria.** New-contributor time-to-first-merged-PR drops measurably; every cited path/line verified at generation time (static eval enforces zero dead references).

**Failure cases.** No lore yet → runs shallow (structure + entry points), recommends `excavate`/`lore build` to deepen. Monorepo scale → requires `--scope`, refuses to fake a 40-package overview in one tour.

**Extensibility.** Output formats (markdown doc, PR walkthrough comments); team-specific tour templates.

---

## Explicitly rejected skills

- **commit-writer, test-generator, doc-writer as standalone skills** — frontier models do these unprompted; without lore grounding or gate enforcement they're prompt-pack filler. Their *grounded* versions live inside prereview (conventions), verify (evidence), and release notes derived from `plan@1` artifacts.
- **"security auditor" as a general skill** — a real one needs taint tracking and dependency scanning, i.e., deterministic tooling with an LLM front-end. Belongs as a gate wrapping semgrep/osv-scanner (future `audit` gate), not as prompt cosplay of a pentester.
- **benchmarker as v1 flagship** — real benchmarking is environment-control work; a naive skill produces confident noise. Deferred until `verify`'s evidence infrastructure can carry variance-aware measurement (`benchmark@1` schema is reserved).
