# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: semver — for skills *and* for this CLI, breaking prompt changes are breaking changes.

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
