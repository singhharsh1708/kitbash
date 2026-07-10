# Landscape research

Why Kitbash exists, derived from what already exists and where it stops.

## The field today

### Viral prompt packs

- **[Ponytail](https://github.com/DietrichGebert/ponytail/)** (~75k stars in weeks, MIT) — injects a "lazy senior dev" ruleset: a ladder of questions the agent must climb before writing code (does this need to exist? does it already exist? …). Measured ~54% less code, ~20% cheaper on real sessions. Ships adapters for a dozen assistants by hand-maintaining a copy per format.
- **Caveman** — compresses agent output style to cut token spend; hook-based activation, intensity levels, session stats.

**What they prove:** single-behavior skills go viral; developers will install agent modifiers in huge numbers; measured claims (Ponytail's %) build trust.
**Where they stop:** each is one hardcoded philosophy. Distribution is copy-paste or per-assistant plugin. No shared format, no tests, no versioned trust. Every one of them re-solves the "N assistants, N formats" problem by hand — that is the tell that infrastructure is missing.

### Distribution directories

- **[skills.sh](https://www.skills.sh/docs/cli)** (Vercel) — `npx skills add owner/repo` copies SKILL.md folders into 70+ agents; open directory with an install-count leaderboard. The strongest prior art on *distribution* and proof of demand at scale.
**Where it stops:** it distributes the SKILL.md convention as-is. No manifest — no budgets, permissions, artifacts, dependencies, or gate semantics. Installs are unpinned copies: no lockfile, no diff-on-update, no integrity checking, no tests. Ranking is install counts, i.e. popularity. Distribution without engineering.
**Kitbash's answer is interop, not rivalry:** a bare SKILL.md folder is KSF-minus-manifest, so `kitbash install` accepts any skills.sh skill directly — flagged as unmanifested, defaults applied. Their catalog is our funnel; our manifest, lock, and evals are the upgrade path.

### Platform-native extension systems

- **Claude Skills / plugins** — richest model: progressive disclosure via frontmatter, scripts, hooks, subagents, marketplaces. Claude-only.
- **Cursor Rules** (`.mdc`, glob-scoped, auto/manual attach) — good scoping model. Cursor-only, no scripts, no tests.
- **Copilot instructions** (repo-wide + path-scoped `*.instructions.md`) — GitHub-native. Static text only.
- **Windsurf workflows / Cline rules / Roo modes / Continue blocks / OpenHands microagents** — each a partial re-invention: triggers, scoping, sometimes tool constraints, always locked in.
- **Codex CLI + AGENTS.md** — `AGENTS.md` is the closest thing to a standard: plain markdown read by many agents. Lowest common denominator: no triggers, no scoping, no permissions, no budget, no composition. It's a README for robots, and that's all it can ever be.

**What they prove:** the *capability set* skills need is known — lazy loading, scoped triggers, script execution, tool permissions.
**Where they stop:** every capability dies at the platform boundary. A team using three assistants maintains three divergent rule sets that drift apart.

### Config conventions

- **Aider conventions files**, dotfile rule stacks, `CLAUDE.md`/`AGENTS.md` hierarchies — accreting text files with no ownership, no measurement, and silent context cost on every request.

## The gap map

| Capability | Prompt packs | Platform systems | skills.sh | **Kitbash** |
|---|---|---|---|---|
| Cross-assistant distribution | manual copies | none | **yes — same file copied** | **compiler + adapters (native idioms, visible degradation)** |
| Versioned, pinned installs | git clone at best | marketplace-ish (one platform) | unpinned copies | **lockfile + content hashes** |
| Behavior testing | none | none | none | **eval tiers** |
| Trust / injection review | none | partial review | none | **install-time diff, permissions manifest, signing** |
| Context cost accounting | none | none | none | **declared budgets, lint-enforced** |
| Skill composition | none | ad-hoc chaining | none | **typed artifacts + pipelines** |
| Ranking | stars | stars | install counts | **measurement badges** |
| Durable repo knowledge | none | per-platform memory | none | **lore layer** |

skills.sh solved distribution. Everything below the first row is still empty — that's the product: skills.sh distributes skills; Kitbash makes them engineering.

## First principles: what developers actually want

Developers don't want "AI skills." They want: fewer review cycles, faster onboarding, fewer bugs, less repetitive work, better architecture decisions, less context switching. A skill is only worth installing if it moves one of those. Two consequences:

1. **Grounding beats prompting.** A generic "write tests" skill is a commodity — the model already does that. Value comes from *project-specific grounding* (this team's review standards, this repo's invariants) and *enforcement* (gates that block, evals that measure). Hence lore and gates are core primitives, not add-ons.
2. **Trust is the adoption ceiling.** Teams won't standardize on unreviewable prompt injections into their codebases. Hence lockfiles, diff-on-update, and permission manifests are v0 features, not v2.

## Ideas considered and rejected

- **Personalities as a product** — cosmetic; output style doesn't change outcomes. Allowed as config flavor, never a pillar.
- **Generic single-task skills** (test generator, doc writer, commit writer) as standalone offerings — commodity; every frontier model does this unprompted. Only shipped when grounded in lore or enforced as gates.
- **A new agent/framework** — competing with Claude Code/Cursor is a losing war and betrays the point: portability of the developer's investment.
- **"Adaptive prompts" / auto-optimizing magic** — unfalsifiable marketing. Replaced by the measurable version: lore-driven context injection with evals.
- **Marketplace-first strategy** — a store of untested prompts is a race to the bottom and a prompt-injection watering hole. Registry ships *after* lint + evals + hashing exist.

## Sources

- [Ponytail repository](https://github.com/DietrichGebert/ponytail/)
- [Ponytail README](https://github.com/DietrichGebert/ponytail/blob/main/README.md)
- [Ponytail guide (Dashen Tech)](https://dashen-tech.com/en/dev-tools/ponytail-lazy-senior-dev-agent-skill/)
- [Ponytail analysis (DEV Community)](https://dev.to/yashddesai/ponytail-the-ai-coding-skill-taking-github-by-storm-and-the-one-question-nobodys-answered-yet-46mc)
