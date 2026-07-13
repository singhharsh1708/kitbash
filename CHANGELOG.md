# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: semver — for skills *and* for this CLI, breaking prompt changes are breaking changes.

## [0.6.0] — 2026-07-14

Trust & review release: installing a skill means letting someone else's instructions run with your agent's permissions — this release makes that reviewable and governable.

### Added
- **Pre-install review gate**: `kitbash install` prints a review block (permissions incl. network/write, budget, standing, capability requirements, lint warnings incl. injection heuristics) *before* writing anything, and prompts `install? [y/N]` on a TTY. `--yes`/`-y` skips the prompt; non-interactive runs (CI) proceed as before.
- **`[policy]` in `kitbash.toml`** — org-level allowlists: `allow_sources` (globs matched against `gh:owner/repo[/path][@ref]` / `file:` sources), `deny_network`, `deny_write`, `max_budget`. Policy is a hard gate at install (`--yes` does not bypass it) and `doctor` rechecks it against already-installed skills.
- **Remote sources for `preview`, `lint`, and `explain`**: `kitbash preview gh:owner/repo/path` fetches to a temp dir and renders the exact compiled output per agent — skills are fully readable before install, no side effects.

### Changed
- `install` output: the summary (budget/standing/permissions) moved from after the copy to the review block before it; the post-install lines now just confirm the pin.
- `explain`/`lint`/`preview` "not found" errors now mention that a source (`gh:owner/repo`, `file:path`) is accepted.

## [0.5.0] — 2026-07-12

### Added
- Three v0.2-roadmap commands: `kitbash lint [skill-or-path] [--strict]` (full static check suite, works pre-install), `kitbash explain <skill-or-path> <adapter>` (why a compilation degraded, with the token cost of eager targets), and `kitbash preview <skill-or-path>` (each adapter's compiled output with per-target token counts, before installing).
- `aider` adapter — marker-merged `CONVENTIONS.md` (detected via an existing `CONVENTIONS.md` or `.aider.conf.yml`) — **8 targets total**.
- CI runs on Windows and macOS alongside Linux; fixed the platform-dependent subpath test so the suite is green on all three.
- Site: live terminal replay in the hero and an interactive per-target compile preview.

## [0.3.0] — 2026-07-11

### Added
- Four new adapters — `copilot` (`.github/instructions/*.instructions.md`), `cline` (`.clinerules/`), `windsurf` (`.windsurf/rules/`), `gemini` (GEMINI.md marker merge) — **7 targets total**.
- Commands compilation: `triggers.commands` now emit native slash commands (Claude Code `.claude/commands/*.md` shims).
- Generalized marker-merge for shared files (AGENTS.md, GEMINI.md): user content preserved, sections idempotent, stale sections pruned.
- Pruning generalized to written-set semantics across all managed output locations — covers removed skills and renamed commands.
- README: badges, status-quo-vs-kitbash comparison, FAQ; social preview asset; demo regenerated from a real 7-target session.

## [0.2.0] — 2026-07-11

### Added
- `kitbash.lock`: content-hash pins (sha256 over the skill directory) written on install, dropped on remove.
- Integrity drift detection in `kitbash doctor` — exits 1 when installed files differ from the lock.
- SKILL.md-only interop (skills.sh / Claude Skills convention): installs directly, manifest synthesized with conservative defaults, flagged `unmanifested` at install/list/compile. Verified against real third-party repos.
- `owner/repo` shorthand sources (resolve as `gh:`).
- Stale-output pruning on `compile`: generated outputs of removed skills are deleted — only files bearing the generated header are ever touched.
- `kitbash.toml` `[project].targets` honored; unknown targets error.
- Animated real-session demo in the README; launch plan in `docs/launch.md`.

### Changed
- Bare (unmanifested) skills report budget violations as warnings instead of build failures — their authors never declared those limits.
- `--version` reads package.json.

## [0.1.0] — 2026-07-10

### Added
- KSF spec draft v0.1 (`spec/SPEC.md`) with JSON schema; RFC process (`rfcs/`); RFC-0001.
- Working thin slice, zero runtime dependencies: `init`, `install` (gh:/file:), `remove`, `list`, `compile`, `doctor`.
- Adapters: `claude-code`, `cursor`, `agentsmd` floor (idempotent marker merge).
- Context budget and standing-stub enforcement at compile; visible degradation warnings; `--strict`.
- Template resolution: `{{artifact.*}}`/`{{lore.*}}` compile to path references, `{{prompt.*}}` inlines.
- End-to-end test suite in CI.
- Reference skill `prereview`; manifesto; landing page; docs.
