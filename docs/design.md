# Kitbash architecture

## Overview

```
                 ┌─────────────────────────────────────────┐
                 │                Registry                  │
                 │  GitHub-native sources + community index │
                 └────────────────────┬────────────────────┘
                                      │ install / update (hash-pinned)
                                      ▼
┌──────────────┐    ┌─────────────────────────────────────────┐
│  skill.toml  │    │               kitbash CLI                │
│  SKILL.md    │───▶│  resolve → lint → lock → compile → test  │
│  scripts/    │    └────────────────────┬────────────────────┘
│  evals/      │                         │ adapters
└──────────────┘                         ▼
   KSF (spec)      ┌──────────┬──────────┬──────────┬──────────┐
                   │ .claude/ │ .cursor/ │ AGENTS.md│ .github/ │ …
                   │ skills/  │ rules/   │ sections │ skills/  │
                   └──────────┴──────────┴──────────┴──────────┘
```

One source of truth (KSF), compiled to every assistant's native format. The native outputs are build artifacts — gitignored by default, or committed for teams that want zero-tooling onboarding (both supported; `kitbash.toml` decides).

## The compiler and adapters

Each adapter implements:

```ts
interface Adapter {
  id: string;                          // "claude-code", "cursor", "copilot", ...
  detect(repo: Path): boolean;         // is this assistant used here?
  capabilities(): CapabilitySet;       // scripts? hooks? lazy-load? scoped rules?
  emit(skill: ResolvedSkill): File[];  // native output
}
```

**Capability matrix + graceful degradation.** A skill that declares `requires = ["scripts"]` compiles fully on Claude Code, and on Cursor compiles to an instruction-only variant with the script steps rewritten as manual commands — with a build warning. `kitbash compile --strict` fails instead. Degradation is *explicit and visible*, never silent.

Launch adapters: `claude-code`, `cursor`, `copilot`, `codex`, `agentsmd` (generic fallback — every assistant that reads AGENTS.md gets at least the floor). Fast follow: `gemini-cli`, `windsurf`, `opencode`, `cline`, `aider`, `continue`, `openhands`. Adapters are plugins: third parties can ship one for a new assistant without touching core.

## Resolution and trust

`kitbash install` resolves a source (`gh:owner/repo[/path][@ref]`, `https://…`, `file:…`, or an index short name), fetches, lints, and pins in `kitbash.lock`:

```toml
[[skill]]
name = "prereview"
source = "gh:kitbash-dev/prereview"
version = "0.3.1"
resolved = "gh:kitbash-dev/prereview@9f2c41d"
integrity = "sha256-Qm3…"          # over the full skill directory
```

Trust model, in order of shipping:

1. **v0: content hashing + diff-on-update.** A skill's instructions are code that runs on your codebase. `kitbash update` renders an instruction-level diff and requires confirmation. No script from a skill is ever executed at install time; scripts run only when the agent invokes the skill, under the declared permissions.
2. **v0: permissions manifest.** `[permissions] tools = ["read", "grep", "bash:git *"]`, `network = false`. Adapters translate to platform enforcement where it exists (Claude Code permission rules); elsewhere it compiles into the instructions and install-time review is the backstop — stated honestly as advisory.
3. **v0: injection lint.** Heuristic scan of SKILL.md for exfiltration patterns, tool-permission escalation, instructions to modify agent config or fetch remote instructions. Not perfect; raises cost of the lazy attack.
4. **Later: sigstore signing, index review tiers** (community → audited → verified), org-scoped private indexes.

## Artifacts and pipelines

Artifacts are **stdin/stdout for agents** — the pipe operator that makes skills compose. Not prompt hopes: an artifact is a JSON file under `.kitbash/artifacts/` with a versioned schema:

- `plan@1` — file-level implementation plan: touchpoints, risks, test plan
- `findings@1` — review findings: file, line, severity, rationale
- `verify@1` — behavioral verification record: flows driven, evidence
- `benchmark@1` — before/after measurements

`skill.toml` declares `produces` / `consumes`. The compiler wires the handoff into each platform's idiom (Claude Code: instructions to read/write the artifact path; others: same, degraded). A **pipeline** is a declared graph:

```toml
[pipeline.ship]
steps = ["plan", "verify", "prereview", "release"]
# each step gates the next; artifacts flow through .kitbash/artifacts/
```

`kitbash run ship` prints the run order and hands the driving prompt to whichever assistant is active. Deterministic pipeline steps (gates) run without any LLM.

## Gates

A gate is a skill with `mode = "gate"`: it must terminate in a deterministic pass/fail (exit code from a script, or a schema-validated artifact judged by fixed rules). Gates mount as pre-push hooks or CI steps: `kitbash gate run prereview`. This is the difference between "the agent usually reviews my code" and "unreviewed diffs don't leave my machine."

## Lore — repo intelligence

The highest-leverage missing primitive. Every assistant has session amnesia; every platform's memory is proprietary and non-portable. Lore is a structured, versioned knowledge layer in-repo:

```
.kitbash/lore/
  decisions/    # ADR-style: what was decided, why, evidence links
  conventions/  # "errors are wrapped with X", "no barrel files" — with citations
  invariants/   # things that must stay true; each links to the gate/test enforcing it
  map.md        # subsystem guide: what lives where, who owns it
```

- **Built** by `kitbash lore build` (mines git history, PR review comments, issue threads into *proposed* entries) — then **curated by humans**; auto-generated slop is rejected at the PR boundary like any other code.
- **Queried** by every skill through every assistant — compiled into lazy-loaded context, within budget.
- **Written back** by skills: `excavate` records answered questions; `prereview` promotes repeated review comments into convention entries.

Lore entries are markdown with frontmatter, diffable and reviewable. No database, no service. This is deliberately boring technology.

Lore is also deliberately **separable**: nothing in KSF hard-couples to it (skills declare `[lore]` reads/writes, but absent lore they degrade gracefully). If it outgrows the core — and it might; portable repo memory is arguably a product of its own — it ships as `@kitbash/lore` without breaking a single skill.

## Context budgets

Every skill declares `[context] budget` (tokens) and `disclosure = "lazy" | "eager"`. The compiler measures actual compiled size per adapter, fails builds over budget, and `kitbash doctor` reports total standing context cost across installed skills — the number nobody today can see.

## Evals

Three tiers, all runnable via `kitbash test`:

1. **Static** (free, CI-always): schema validity, budget compliance, injection lint, dead references.
2. **Instruction audit** (cheap, one LLM call): does SKILL.md contradict itself, exceed scope, or conflict with another installed skill?
3. **Behavioral** (metered): run the skill against a fixture repo through a headless agent (`claude -p`, other CLIs as they expose non-interactive modes) and assert on outcomes — artifacts produced, files changed/unchanged, gate exit codes. Eval files declare fixture, task, assertions:

```yaml
# evals/catches-injection-bug.eval.yaml
fixture: fixtures/express-app
task: "prereview the diff on branch eval/sqli"
assert:
  - artifact: findings@1
    contains: { severity: high, file: "src/db.ts" }
```

Behavioral evals are what let the index rank skills by *measured* quality instead of stars.

## Repository layout (this repo)

```
kitbash/
  spec/            # KSF spec + JSON schemas (versioned independently)
  packages/cli/    # the kitbash CLI (TypeScript, zero runtime deps target)
  packages/adapters/   # one package per adapter (post-MVP split)
  examples/skills/     # reference skills, dogfooded
  docs/            # design, research, roadmap, skill catalog
```

## Configuration

- `kitbash.toml` (repo root): installed skills, target adapters, compile mode (gitignore vs commit), pipeline definitions.
- `~/.config/kitbash/config.toml`: user defaults, index sources, telemetry opt-in (off by default, forever).
- `kitbash.lock`: machine-written pins.

## Future direction: structured steps (RFC territory)

The strongest critique of prompt-file skills: they should be programs, not prose. Kitbash's answer is the deterministic shell — scripts, gates, artifact contracts — around a necessarily non-deterministic LLM core. A future RFC may let gate-mode skills declare ordered steps (`collect → generate → validate → emit`) so more of the skill's surface becomes checkable. What we will not build is a general workflow DSL that replaces the agent: that's the agent-framework trap, and it's a non-goal below.

## Non-goals

- Not an agent runtime, model router, or IDE. Kitbash compiles; agents execute.
- No hosted execution; the CLI is local-first, offline-capable after install.
- No telemetry by default; no accounts required for public installs.
- No popularity-ranked marketplace. The index surfaces measurements (eval pass rate, token cost, compatibility, signature status) — never star ratings.
