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

- Bump `packages/cli/package.json` version (semver).
- `npm test` runs again via `prepublishOnly`.
- `npm publish` (2FA / web-auth as configured).
- Tag the release; note user-facing changes.
