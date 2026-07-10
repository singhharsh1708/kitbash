<p align="center">
  <img src="assets/mascot.svg" width="240" alt="The Kitbasher, the tinkerer who builds from parts">
</p>

# Kitbash

> **The open standard for portable AI agent skills.**
> Write a skill once. A package manager and compiler run it in Claude Code, Cursor, Codex, Copilot, Gemini CLI, Windsurf, OpenCode, Aider — every coding agent you use.

```
JavaScript packages  →  npm
Containers           →  Docker
Lint rules           →  ESLint
Agent skills         →  Kitbash
```

**Status: pre-alpha. Spec draft v0.1. Nothing here is stable yet.**

```
kitbash install prereview
kitbash compile
# → .claude/skills/prereview/  .cursor/rules/prereview.mdc  AGENTS.md §prereview  ...
```

---

## The problem

Every AI coding assistant invented its own extension format:

| Assistant | Format |
|---|---|
| Claude Code | `.claude/skills/*/SKILL.md`, plugins, hooks |
| Cursor | `.cursorrules`, `.cursor/rules/*.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md`, `*.instructions.md` |
| OpenAI Codex | `AGENTS.md`, prompts |
| Windsurf | `.windsurfrules`, workflows |
| Cline / Roo | `.clinerules` |
| Continue | config blocks |
| Aider | `CONVENTIONS.md` |
| OpenHands | microagents |

Meanwhile the "skills" that developers actually share are viral prompt packs — useful, but structurally dead ends:

- **No portability.** A great Claude skill is useless to your teammate on Cursor.
- **No testing.** Prompts ship on vibes. Nobody knows if version 1.3 got worse.
- **No trust.** Installing a skill means pasting unreviewed instructions into the thing that edits your code. Prompt injection is a supply-chain attack nobody is scanning for.
- **No versioning.** Update a rules file and behavior silently changes for the whole team.
- **No composition.** Skills can't feed each other. Every prompt is an island.
- **Context bloat.** Every installed rule burns tokens on every request, forever, unmeasured.

npm solved distribution for JS. Babel solved write-once-run-everywhere. ESLint solved shareable, configurable rules. Homebrew solved one-command install with community taps. **Nobody has solved any of this for agent skills.** Kitbash is that layer.

## What Kitbash is

Three pillars:

### 1. KSF — the Kitbash Skill Format ([spec](spec/SPEC.md))

An open, assistant-agnostic format. A skill is a directory:

```
prereview/
  skill.toml        # manifest: triggers, permissions, context budget, artifacts
  SKILL.md          # the instructions (progressive disclosure)
  scripts/          # optional deterministic helpers
  evals/            # tests. yes, tests for a skill.
```

The manifest declares things no other format even has a field for:

- **`[context] budget`** — max tokens this skill may inject. Enforced. `kitbash lint` fails skills that bloat.
- **`[permissions]`** — which tools the skill may direct the agent to use. Reviewable at install time.
- **`[artifacts]`** — typed JSON the skill produces/consumes (`plan@1`, `findings@1`), so skills compose through data, not prompt-chaining hope.
- **`[targets]`** — capability requirements, so the compiler can degrade gracefully on assistants that can't run scripts — and derive a per-skill compatibility matrix automatically.
- **`[dependencies]`** — skills build on other skills, npm-style: semver ranges, resolved as a graph, pinned as a closure in the lockfile.

### 2. The `kitbash` CLI

```
kitbash init                     # set up a repo
kitbash install gh:owner/skill   # install from any GitHub repo (Homebrew-tap style)
kitbash install prereview        # short names resolve via the community index
kitbash compile                  # emit native format for every assistant you use
kitbash doctor                   # detect which assistants are present
kitbash lint                     # budget, schema, prompt-injection heuristics
kitbash test                     # run the skill's evals
kitbash update                   # show a human-readable diff of instruction changes before applying
```

Installs are pinned in `kitbash.lock` by content hash. **An updated skill never changes your agent's behavior silently** — `kitbash update` shows you the instruction diff like a code review, because that's what it is.

### 3. The registry

GitHub-native first (like Go modules / Homebrew taps): any repo can publish a skill, the community index maps short names to audited sources. Signing and review tiers come later — see [roadmap](docs/roadmap.md).

## What Kitbash adds beyond "skills"

The prompt-file abstraction is too small. Kitbash names the missing pieces:

- **Adapters** — compile targets per assistant, with a capability matrix and graceful degradation.
- **Artifacts** — typed handoffs (`plan@1`, `findings@1`, `benchmark@1`): stdin/stdout for agents. Skills pipe into each other, so `/plan → implement → /verify → /prereview → /release` is a real pipeline, not a suggestion.
- **Gates** — skills that run as deterministic pass/fail hooks (pre-push, CI). Exit codes, not vibes.
- **Loadouts** — curated skill sets per stack: `kitbash install loadout:oss-maintainer`.
- **Lore** — a structured, versioned repo-intelligence layer (decisions, conventions, invariants, ownership) that every skill can query and extend, portable across assistants. The project memory your agent forgets every session, made durable.
- **Evals** — three tiers: static lint (free), instruction audit, and behavioral runs against fixture repos using headless agent CLIs.

Full architecture: [docs/design.md](docs/design.md). Flagship skills: [docs/skills-catalog.md](docs/skills-catalog.md).

## What Kitbash refuses to be

- **Not another prompt collection.** Unversioned, untested prompt piles are the problem, not the product.
- **Not an agent framework.** We don't compete with Claude Code or Cursor; we make your investment in skills portable across all of them.
- **Not a personality store.** Cosmetic personas don't change outcomes. We ship skills that are measured by their evals.

## Quickstart (pre-alpha)

```bash
npm install -g kitbash    # not published yet — build from source
kitbash init
kitbash doctor
```

## Contributing

The spec is a draft and this is the best time to shape it. See [CONTRIBUTING.md](CONTRIBUTING.md). Design discussions happen in issues.

## License

Apache-2.0
