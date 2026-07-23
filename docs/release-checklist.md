# Release checklist

Run this before publishing a new `kitbash` version to npm. It's the lifecycle a
user actually exercises — the "remove the last skill" bug (fixed in #24) got
through unit tests and was only caught by walking the whole flow by hand. Don't
skip the live and error-path sections; that's where regressions hide.

All commands run from the repo root unless noted. CLI package is `packages/cli`.

## 1. Static correctness

```bash
cd packages/cli
npm run check      # tsc --noEmit — must be clean
npm test           # build + full e2e suite — every assertion ok
npm run bench      # regenerates docs/benchmarks/README.md
cd ../..
git status --short # bench must be deterministic: no diff after a clean run
node -e "JSON.parse(require('fs').readFileSync('spec/schema/skill.schema.json','utf8'))"  # schema parses
```

Gate: typecheck clean, suite green, `git status` clean after bench, schema parses.

## 2. End-to-end in a scratch repo

```bash
R=$(mktemp -d); cd "$R"; mkdir .claude .cursor
K=<path-to>/packages/cli/dist/index.js   # from `npm test`/`npm run build`

node "$K" --version                      # prints version
node "$K" bogus-cmd; echo $?             # unknown command → exit 1
node "$K" init                           # creates kitbash.toml + .kitbash/skills/
```

Then the happy path (see §3 for a live source), checking each:

- `install` — reports budget/standing, pins in `kitbash.lock`
- `list` — shows the skill, `[unmanifested]` if bare
- `test` — static tier runs; measured budget line present
- `doctor` — detects targets, reports standing cost, `lock integrity: ok`
- `compile` — emits per detected target; generated header + `kitbash:begin` markers present
- `compile` again — idempotent (marker count stays 1)
- `compile --strict` — exits 1 when a warning is present

## 3. Real-world interoperability (live, over the network)

Install a real `SKILL.md`-only project from GitHub and confirm the full flow:

```bash
node "$K" install gh:addyosmani/agent-skills/skills/code-review-and-quality
node "$K" test          # flags unmanifested; measures the ~5,044-tok standing cost
node "$K" compile       # emits outputs; surfaces the eager-load (cannot lazy-load) warning
```

Gate: installs, flagged unmanifested, compiles, and the standing-cost warning
matches what the README/benchmark claim.

## 4. Error paths (each must exit 1 with a clear, actionable message)

```bash
node "$K" install gh:addyosmani/agent-skills/skills/code-review-and-quality  # duplicate → rejected
node "$K" install gh:this-user/does-not-exist-xyz                            # missing repo
node "$K" install gh:addyosmani/agent-skills@no-such-ref                     # bad ref
node "$K" install gh:addyosmani/agent-skills/skills/nope                     # bad subpath
node "$K" remove not-installed                                              # not installed (lists what is)
node "$K" install                                                          # no arg → usage
```

## 5. Lifecycle cleanup (the regression that bit us)

```bash
node "$K" remove code-review-and-quality   # remove the LAST skill
node "$K" compile                          # must PRUNE, not bail:
                                           #   ✂ pruned stale section(s) from AGENTS.md
                                           #   ✂ removed .claude/skills/... (stale)
                                           #   exit 0
```

Gate: no orphaned generated files, no lingering `kitbash:begin` sections in
`AGENTS.md`/`GEMINI.md`, user content in those files preserved.

## 6. Publish

Publishing is automated. Land the version bump, push a tag, and
`.github/workflows/release.yml` does the rest.

```bash
# on a branch, in a PR
npm version <major|minor|patch> --no-git-tag-version --prefix packages/cli
$EDITOR CHANGELOG.md          # add the release section
node site/build.mjs           # restamp the version, regenerate changelog.html
```

Once that PR is merged:

```bash
git checkout main && git pull
git tag v<version> && git push origin v<version>
```

The workflow then:

1. **verify** — refuses to continue unless the tag matches `packages/cli/package.json`, then re-runs typecheck, the full suite, the benchmark-determinism gate, and `site/build.mjs --check`. A tag cannot ship something `main` would have rejected.
2. **publish** — `npm publish` over OIDC trusted publishing. No token is stored, nothing expires between releases, no OTP prompt, and npm attaches a provenance attestation automatically. Skipped when that version is already on the registry, so re-running is safe.
3. **github-release** — creates the GitHub release, with notes lifted verbatim from this version's `CHANGELOG.md` section. Runs on the built-in `GITHUB_TOKEN` — no secret needed. Idempotent: edits the release if it already exists.
4. **homebrew** — downloads the published tarball, rewrites `url` + `sha256` in the tap formula, pushes. Skipped with a warning if `TAP_TOKEN` is not set.

Nothing is left to do by hand once the two one-time secrets below are in place — no browser, no OTP, no formula editing, no release notes.

### One-time setup

**npm trusted publishing.** On npmjs.com → the `kitbash` package → Settings →
Trusted Publishers → add a GitHub Actions publisher:

| Field | Value |
|---|---|
| Organization or user | `singhharsh1708` |
| Repository | `kitbash` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |
| Allowed actions | tick **npm publish** — required for publishers created after 2026-05-20 |

Needs npm ≥ 11.5.1 and Node ≥ 22.14 on the runner; the workflow pins Node 24 and
fails loudly if npm is older.

**Homebrew tap.** The tap lives in a separate repo, and pushing to another repo
from Actions needs a credential the default `GITHUB_TOKEN` doesn't grant. Create
a fine-grained PAT scoped to `singhharsh1708/homebrew-tap` with **Contents:
Read and write**, then add it to this repo (Settings → Secrets and variables →
Actions) as `TAP_TOKEN`. Without it the tap step skips with a warning and the
formula is bumped by hand. The GitHub release does **not** need this — it runs
on the built-in token.

### Manual fallback

If the workflow is unavailable: `npm publish` from `packages/cli` (the web-auth
token goes stale between releases — expect to run `npm login --auth-type=web`
first), then bump the tap formula by hand.
