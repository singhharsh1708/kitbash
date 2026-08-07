# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: semver — for skills *and* for this CLI, breaking prompt changes are breaking changes.

## [0.14.0] — 2026-08-07

### Added
- **`kitbash update` — the v0.2 exit criterion, closed.** Updating a skill was the one lifecycle step with no tooling: you ran `remove` + `install` and reviewed nothing, or edited files by hand and tripped doctor's drift check. `update` refetches each skill's pinned source and prints the complete review before touching a byte: manifest field deltas with permission escalations flagged (`permissions.network: no → YES  ⚠ escalation`), the changed-file list, then a unified diff of every readable file — instructions, prompts, scripts. Only then does it ask. Three properties are deliberate. The four safety lints that gate install (`visible-text`, `dynamic-context`, `remote-exec`, `secrets`) re-run against the new version and block the update regardless of `--yes` — a skill must clear the same gate to change on disk as to arrive. `[policy]` is re-enforced, so a new version that declares a permission your policy denies cannot arrive by update. And unlike `install`, a non-interactive run **never** auto-applies: no TTY plus no `--yes` means the diff prints, nothing changes, and the exit code says so — the command's whole contract is that a human saw the diff and said yes. Local edits to an installed skill are detected via the lockfile hash and called out before being overwritten; a source that renames its skill is refused rather than silently replacing another.
- **`kitbash diff` — the same review, read-only.** One argument diffs an installed skill against a fresh fetch of its pinned source ("what would update do?"); two arguments diff any two skills — installed names, local paths, or fetchable sources, so `kitbash diff prereview gh:owner/repo/skills/prereview@v2` works before anything is installed. Exit codes follow diff(1): `0` identical, `1` different, `2` trouble — scriptable as a cheap "is my skill stale?" probe in CI. Both commands share one diff engine: an LCS line diff with hunk headers, binary and symlink entries listed but never line-diffed, CRLF normalized so a Windows checkout doesn't read as a wall of changes.

### Fixed
- The CLI docs page still described the 0.6.0 command surface: a flat help listing with no planned/working split, an unknown command exiting `1` with a help dump (it exits `2` with a did-you-mean), planned commands exiting `2` (they exit `7`), and a `-v` alias that was removed in 0.11.0. The synopsis, command summary, and exit-code table now match the shipped binary, and the docs index gained the tenth adapter (`zed`) its own list had dropped.

## [0.13.0] — 2026-07-29

### Fixed
- **Cline was being charged a standing tax it stopped owing, and served the same skill twice.** The `cline` adapter compiled to `.clinerules/<name>.md` — a *rule*, always active, whole body in context every session — and declared the target eager. Cline reads Agent Skills (`apps/vscode/src/core/storage/skill-directories.ts` scans `.cline/skills`, `.clinerules/skills`, `.claude/skills` and `.agents/skills`) and loads them progressively: name and description at startup, the body only when `use_skill` fires. So the target was billed ~539 standing tokens for a skill Cline was willing to lazy-load for ~40. Worse, in any repo that also had `.agents/`, Kitbash emitted the identical body to both paths and Cline scanned both — the always-on copy defeating the lazy one, and a tool whose entire pitch is measuring standing cost silently adding ~539 tokens of it. `cline` now compiles to `.agents/skills/<name>/SKILL.md`, the same vendor-neutral file `agents` and `zed` emit, which makes the duplicate structurally impossible: one file serves Cline, Codex, Cursor, Copilot and Zed at once. Detection gains `.cline/`. Stale `.clinerules/<name>.md` output is pruned on the next compile; your own rule files there are untouched.
- **The measured tax moved with it**, because the numbers are read from the adapters rather than restated: **14×** for a manifested skill (~40 lazy vs ~560 eager) and **47×** for an unmanifested one, up from 13× and 45×. Cline leaving the eager set costs a row in a table, not the argument — `aider` and `agentsmd` still carry the whole body every session. Eight of the ten targets are now lazy.

### Added
- **A skill authored `disclosure = "eager"` now warns on `cline`.** Cline loads every skill on demand, so an eager-authored skill does not get the always-resident body it asked for. Compiling that silently would fix one spec §2 conformance violation by introducing its mirror image; it warns instead, and fails `--strict`.

## [0.12.0] — 2026-07-28

### Added
- **`zed` adapter — the tenth target.** Zed reads the vendor-neutral `.agents/skills/<name>/SKILL.md` path, but nothing in a Zed-only repo announces that: the `agents` adapter probes `.agents/` and `.codex/`, neither of which Zed creates. A repo whose only agent marker was `.zed/` therefore compiled to nothing but the eager `AGENTS.md` floor — paying a skill's whole body every session on an agent that can lazy-load it for free. The new target detects `.zed/` and emits the byte-identical file `agents` does, so a repo with both compiles that skill once, not twice. **Ten targets, nine output files.**
- **Zed's silent frontmatter rejections are now visible.** Zed's skill loader is stricter than KSF and drops a non-conforming skill at load with no diagnostic in the UI — the silent capability loss spec §2 forbids. Two constraints are checked and warned about at `compile` (so `--strict` fails on them) and in `explain`: `name` must match `^[a-z0-9]+(-[a-z0-9]+)*$`, which rejects the doubled and trailing hyphens KSF's own name rule permits (`tidy--commits` is a legal skill name Zed will not load); and `description` must be non-empty and at most **1024 UTF-8 bytes, not characters** — a trap for any non-ASCII description, where 600 characters can be 1,200 bytes. A manifested skill is bounded at 200 characters, so only an unmanifested `SKILL.md`, whose frontmatter is copied through unvalidated, can breach either bound. No `disable-model-invocation` key is emitted: KSF has no field meaning "never auto-invoke", so synthesizing one would guess at the author's intent.

### Fixed
- **`explain` no longer answers "no capability degradation" about a skill the target refuses to load.** Adapters can now declare target-specific constraints separately from `emit()`, and `explain` reads them directly — a true statement that read as a false one.

## [0.11.0] — 2026-07-28

Credibility pass. A staff-level review of the shipped product found the docs, site, and CLI contradicting each other — fatal for a tool whose whole pitch is honest measurement. Every fix here aligns the surface with reality; none is a new feature.

### Fixed
- **The flagship number was reported three ways.** `compile` warned ~517, `preview` showed ~507, and the benchmark said 560 for the same skill on the same target — because the compiled permissions note and the adapter's own wrapper were counted inconsistently. All three now report the true cost of the emitted file (560), and `preview` renders exactly what `compile` writes.
- **The measurement no longer fails `--strict`.** The standing-cost report was pushed into the same `warnings` array as real problems, so `compile --strict` failed on the one bundled skill — the product punishing the one number it exists to surface. It is now an informational note (`ℹ`), not a warning; `--strict` still fails on genuine warnings (budget overruns, degradation, conflicts).
- **Stub commands cited already-passed milestones.** `kitbash update` said "lands in v0.2" on a 0.10 build. The eight unimplemented commands now point at the roadmap with no stale version, and `--help` lists them under a separate "Planned (not yet implemented)" section instead of mixing them with working commands.
- **The bundled example advertised `mode = gate`** while `kitbash gate` is unimplemented; it now ships as `mode = skill`, runnable end to end with shipped commands.
- **Exit codes are consistent and conventional:** unknown command is `2` (usage) with a did-you-mean suggestion instead of `1` + a full help dump; an unbuilt command is `7`; `test`/`lint` on an empty repo return `0` (vacuous pass) to match `compile`/`list`, so CI scripting agrees across commands.
- **`doctor`** shows undetected targets with `·` (not present in this repo) instead of `✗` (which now means a real problem), with an "N of 9 in this repo" count.
- **`compile`** on a partial fan-out prints how many more targets are available and how to enable them, so "compiled for 2 targets" no longer reads as a shortfall against the "every agent" pitch.
- Website and docs corrected: the interactive preview no longer shows a fictional 1,480-token cost, the quickstart review/compile blocks match the real CLI, the standing-tax figure is stated once, README marks which skills ship vs are planned, and "KSF" is expanded on first use.

### Added
- Per-command help (`kitbash install --help`, `kitbash help <command>`), a did-you-mean suggestion on a mistyped command, and proper pluralization in count lines ("1 skill for 2 targets", not "1 skill(s) for 2 agent target(s)"). Token counts carry units (`standing 60 tok/session`). Removed the `-v` version alias (it collides with the near-universal `-v` = verbose).

## [0.10.0] — 2026-07-26

Secrets and behavioral checks — adopted from the field-tested rule set of a dedicated agent-config scanner, but scoped to what Kitbash does: scan the skill being installed, statically, with no network. Kitbash does not audit your own agent config (settings.json, MCP servers, hooks) — that is a different tool's job.

### Added
- **`secrets` lint (hard-fail).** A skill that ships a live credential — AWS, Anthropic, OpenAI, GitHub, Google, Stripe, Slack, or Linear keys, a database connection string with an inline password, or a private-key block — now blocks install, in the body or any file in the skill. Each pattern keys on a provider's real key shape (prefix + length + character class), and a placeholder guard drops documentation values, so a skill that teaches `sk-ant-...`, `${OPENAI_API_KEY}`, or AWS's own `AKIAIOSFODNN7EXAMPLE` installs fine. Not bypassable by `--yes`, enforced with or without a `[policy]` file.
- **Behavioral warn heuristics** in the injection check: output-suppression directives (`always report success`, `suppress the findings`), auto-run / no-consent directives (`without asking`, `automatically install`), bulk-credential harvesting (`collect all passwords`), and an injection directive hidden in an HTML comment (invisible in rendered markdown, read by the agent — while ordinary tooling comments like `<!-- prettier-ignore -->` do not trip it). These warn rather than block, since a defensive security skill may legitimately quote them; `--strict` fails on them.

### Notes
- This is a deliberate narrow adoption. Config-auditing (permissions in `settings.json`, MCP server risk, hook analysis) and harness-OS features (learned instincts, session memory, a skill marketplace) are out of scope by design — Kitbash is a compiler with a review gate, not an agent operating system.

## [0.9.0] — 2026-07-24

Conformance and honesty release. A codebase audit found a consistent pattern: the JSON schema was treated as the contract, but the loader enforced almost none of it, and several layers advertised enforcement they never delivered. This closes that gap.

### Fixed
- **Adapters no longer claim capabilities they don't deliver.** `claude-code` declared `scripts`/`hooks`/`subagents` and the skill-directory adapters declared `scripts`, but `emit()` only writes `SKILL.md` — no `scripts/` copied, no hook, no subagent. Because the capability was in the set, degradation was computed as empty and `explain`/`--strict` reported full support for output referencing files that were never produced — the exact silent capability loss spec §2 forbids. Capability sets are now empty until the emit code that delivers a capability exists; a skill that `requires` one now correctly reports degraded.
- **The manifest loader enforces the schema instead of silently coercing.** A scalar where the schema types an array (`commands = "/deploy"`) became `[]` (a slash command that never registered, permissions that evaporated); a fractional `budget` passed the range check; an unknown `disclosure` silently became `lazy`. These are now hard errors, and an unknown `targets.mode` warns at `test` (forward-compatible table, per RFC 0002).
- **Safety lints scan the whole skill, not just `SKILL.md`.** The three install-blocking lints read only the body while install copies the entire directory — a `curl … | sh` in `scripts/setup.sh`, or hidden text in a sibling file, sailed straight through. Every non-binary file is now scanned; a symlink is flagged (it points outside the reviewed files).
- **A malformed installed manifest no longer bricks every command.** One hand-edited `skill.toml` made `list`/`compile`/`doctor` exit before processing valid siblings — and `doctor` threw before the integrity check that exists to catch exactly that tamper. `doctor` now reports the load failure, counts it, and still runs drift detection.
- **`compile` refuses to run with zero resolved targets** (e.g. `targets = []`) rather than pruning every generated file while writing nothing back.
- **Pruning removes only the generated file**, never a user file colocated in a generated skill directory (a `NOTES.md` beside `SKILL.md` survives).
- **Integrity hashing is symlink-aware.** `walk()` skipped symlinks entirely, so repointing one inside an installed skill was invisible drift; the link target is now hashed without being followed.
- **`preview` errors on a bad `[project].targets`** instead of silently falling back to every adapter.

### Added
- **Declared permissions are compiled into the instruction body.** Spec §2 requires permissions be enforced natively or compiled into the instructions; only the install-review third was done, so a teammate who pulled the generated file saw no restriction. Non-default permissions now render a block into every target's output (prose, not native frontmatter — the KSF tool grammar is provisional).
- **`gate-verdict` check**: a `mode = "gate"` skill with no `scripts/` and no declared artifact — nothing to produce a deterministic verdict — now fails `lint`/`test`.

## [0.8.1] — 2026-07-23

Security fix. The pre-install review gate did not actually block what it flagged.

### Fixed
- **Safety lints now block `install`, not just `lint`/`test`.** The two hard-fail lints shipped in 0.8.0 (`visible-text`, `dynamic-context`) were printed at install as warnings and never stopped it — so a skill with hidden instructions installed cleanly for anyone without a `kitbash.toml`, since only a `[policy]` violation returned non-zero. Failed safety lints are now a hard gate at install: non-bypassable by `--yes`, enforced with or without a policy file, before anything is written. Schema and quality checks (a malformed artifact ref, a non-slash command) are unchanged — they still surface at `kitbash test` and never block an install.

### Added
- **`remote-exec` lint** — a third hard-fail that catches download-and-execute pipelines hidden in a skill's prose (a "Prerequisites" section, a fenced example): `curl … | sh`, `eval "$(curl …)"`, `base64 -d | sh`, PowerShell `iex`/`iwr`, save-then-`chmod +x`-then-run, and remote-archive extract-run. This is the ClawHavoc / ClickFix family — payloads that live in documentation, not in the manifest a structural lint reads. It is a heuristic, not a proof (`c=curl; $c url | sh` evades a regex on prose); it raises attacker cost at the point where one skill fans out to nine files. Verified against benign installs (`npm install`, `pip install`, `curl -o file`) to keep false positives out.
- **`deny_remote_exec` in `[policy]`** — defaults to on; set `false` to consciously exempt a trusted internal skill from the remote-exec block. The hidden-text and dynamic-context lints are never exemptible.

## [0.8.0] — 2026-07-23

Every target that can lazy-load now does. Two adapters were still emitting always-on files for agents that had since grown proper skill directories.

### Changed
- **`copilot` compiles to `.github/skills/<name>/SKILL.md`** instead of a `.github/instructions/*.instructions.md` file with `applyTo: "**"`. Copilot reads agentskills.io skills and loads only the frontmatter until the skill is needed; the old form applied to every single request.
- **`gemini` compiles to `.gemini/skills/<name>/SKILL.md`** instead of merging into `GEMINI.md`. Gemini CLI injects only each skill's name and description at session start and pulls the body in via its `activate_skill` tool; Google's own docs describe `GEMINI.md` as persistent workspace-wide background.
- Six of nine targets now lazy-load — claude-code, cursor, agents, copilot, windsurf/devin, gemini. The eager holdouts are cline, aider and the AGENTS.md floor.

### Fixed
- Stale sections in a marker-merged file are now pruned whenever nothing wrote to that file during a compile, not only when the owning skill was uninstalled. Without this, a `GEMINI.md` from an older Kitbash kept its generated section forever after the adapter moved. Upgrading cleans up the old `GEMINI.md` sections and `.github/instructions/` files on the next `kitbash compile`; your own content in those files is untouched.

### Added
- `.github/workflows/release.yml` — a pushed `v*` tag verifies the tag against the manifest, re-runs the full gate suite, publishes to npm via OIDC trusted publishing (no stored token, provenance attached automatically), and bumps the Homebrew formula.

## [0.7.0] — 2026-07-22

Ecosystem-correctness release. Two of Kitbash's assumptions about the agent landscape had gone stale, and one of them was flattering its own headline number.

### Added
- **`agents` adapter** — `.agents/skills/<name>/SKILL.md`, the vendor-neutral Agent Skills path read by Codex (its only repo path), Cursor, Copilot, Gemini CLI, Roo, Amp, OpenCode, Zed and Antigravity. Lazy-loaded; detected when `.agents/` or `.codex/` exists. **Nine targets total.**
- **Two hard lint failures** for instructions a reviewer cannot see or that run before the model reads anything: `visible-text` rejects zero-width characters, bidi overrides and the Unicode Tags block; `dynamic-context` rejects backtick command substitution in a skill body. Both fail `lint` and `test` with exit 1, no `--strict` needed — Kitbash fans one skill out to nine files, several of them permanently in context.
- `node site/build.mjs --check` verifies the committed site output is current; gated in CI, and Vercel now runs the build instead of serving whatever was committed.

### Changed
- **`windsurf` is lazy, not eager.** Windsurf became Devin Desktop on 2026-06-02: the adapter now writes `.devin/rules/<name>.md` when `.devin/` exists (falling back to `.windsurf/rules/`) and emits `trigger: model_decision`, so the description sits in context and the body loads on demand.
- The benchmark reads each target's loading mode from the adapters themselves rather than a second hardcoded map — the copy is exactly how published numbers drift from what the compiler emits. Regenerated: four targets now lazy-load, five are eager-only.
- Standing-tax framing corrected throughout: Kitbash compiles to the cheapest loading mode each target actually supports, and the tax is what it costs on targets whose only mode is eager. The 12x/46x gap still holds, measured against the corrected matrix.

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

## [0.4.1] — 2026-07-11

### Fixed
- TOML parser hardening: quoted strings and keys, signed numbers, spaced table headers, invalid-escape guard (`TomlError` instead of raw exceptions), plus edge cases around inline values.
- `gh:` installer: directory-traversal guard on subpaths; two skills writing the same output path now warn instead of silently overwriting.
- Schema bounds enforced (budget ≤ 20000, standing ≤ 500, description ≤ 200 chars); YAML frontmatter values escaped so descriptions with quotes/colons stay valid.
- Cross-platform deterministic integrity hashing — `kitbash.lock` hashes are CRLF/LF-insensitive and path-order stable.
- `doctor` flags a missing lockfile and installed-but-unpinned skills.
- Standing stub skips markdown headers; unresolved `{{template}}` variables error at compile instead of leaking.
- UTF-8 BOM stripped from manifests; stray subdirectories under the skills dir no longer crash `list`/`doctor`.

## [0.4.0] — 2026-07-11

### Added
- Homebrew install: `brew install singhharsh1708/tap/kitbash`; README install/update/uninstall guide.

### Fixed
- Every eager target now reports the standing token cost of a lazy-authored skill, not just the shared-file ones.

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
