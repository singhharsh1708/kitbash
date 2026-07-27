# RFC 0003 — implementation roadmap

Companion to [RFC 0003](0003-v2-architecture.md). Assumes the RFC is accepted. This
is the PR-by-PR plan. Every PR leaves the repo working and CI green; no PR requires
rewriting an earlier one; each is independently mergeable.

Ground truth (current tree): `commands.ts` 1093 · `ksf.ts` 305 · `adapters.ts` 285 ·
`toml.ts` 185 · `lock.ts` 102 · `index.ts` 84 · `test.mjs` 906 · `benchmark.mjs` 163.
No `exports` in `package.json` (bin only). One e2e test. Regex-based lints. Opaque
string body flow.

Two invariants govern ordering:
- **Freeze before build.** Any contract that a later PR or an external user depends
  on (lock format, exit codes, `--json` envelope, adapter interface, tokenizer label)
  is *reserved/frozen in Phase 0*, before the machinery exists, so no later PR breaks it.
- **Refactor before behavior.** The IR and render-layer refactors are behavior-
  preserving and snapshot-guarded first; the one PR that changes output (native
  permissions) lands only after the snapshot net exists.

---

# Part 1 — dependency graph

```
                         ┌────────────────── PHASE 0 (freeze-or-never) ──────────────────┐
                         │                                                               │
  P0.1 lock version+     P0.2 edition       P0.3 tokenizer       P0.4 authors    P0.5 delete
  reserved fields        marker             honest label         field fix       publish/search
        │                   │                   │                    │             + deps-reserved
        │                   │                   │                    │                  │
        │                   │                   │                    │             P0.6 exit-code
        │                   │                   │                    │             enum (SPEC+wire)
        │                   │                   │                    │                  │
        └───────────┬───────┴───────────────────┴────────┬───────────┴──────────────────┘
                    │                                     │
                    ▼                                     ▼
   ┌──────────────────────── PHASE 1 (make the wedge true) ────────────────────────┐
   │                                                                                │
   │  P1.1 extract shared render layer  ──▶  P1.2 SkillIR type + buildIR            │
   │        (behavior-preserving)                    │                              │
   │                                                 ▼                              │
   │                                        P1.3 adapters → lower(IR)               │
   │                                          (behavior-preserving, snapshot)       │
   │                                                 │                              │
   │             P1.5 pass pipeline skeleton ◀───────┤                              │
   │                    │                            ▼                              │
   │                    └──────────────▶  P1.4 inject-permissions pass +            │
   │                                        native allowed-tools (FIRST output      │
   │                                        change — needs snapshot net first)      │
   │                                                                                │
   │  P1.7 conformance corpus + golden runner ──(guards P1.1–P1.4, prereq for)──┐   │
   │        + toml-test + fuzzer                                                │   │
   │                                                                            ▼   │
   │  P0.3 label ──▶ P1.6 real BPE tokenizer (changes all numbers) ────▶  P1.8 earn│
   │                     (independent of IR; needs corpus to guard)       scripts  │
   └────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
   ┌──────────────────────── PHASE 2 (pkg-mgr + trust) ─────────────────────────┐
   │  P2.1 resolved-commit pin + .git strip ──▶ P2.2 restore-from-lock,         │
   │            (uses P0.1 reserved fields)          compile --check            │
   │  P2.3 @kitbash/core library split ──▶ P2.4 --json + diagnostics API        │
   │        (splits commands.ts; uses P0.6 exit codes)                          │
   │  P2.5 signing/provenance + audit (uses P0.1 signature field, P2.1 commit)  │
   │  P2.6 incremental+parallel cache (needs pure adapters from P1.3)           │
   └────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
   ┌──────────────── PHASE 3 (ecosystem — post-adoption) ───────────────────────┐
   │  P3.1 third-party adapters (needs P1.3 lower + P0.1 pin + P2.5 verify)      │
   │  P3.2 third-party passes (needs P1.5)   P3.3 adapter certification (P1.7)   │
   │  P3.4 source-as-identity + resolver + update/drift (needs P0.7 reserve,     │
   │        P2.1 commit pin, P0.6 codes)     P3.5 adapter registry (P3.1)        │
   └────────────────────────────────────────────────────────────────────────────┘
```

**Critical path** (the chain that gates everything): `P0.1/P0.6 → P1.1 → P1.2 → P1.3
→ P1.4`, with `P1.7` (snapshots) landing beside P1.1 so P1.4's output change is safe.
Tokenizer (`P0.3 → P1.6`) is a parallel track. Phase 2/3 hang off Phase 0's frozen
contracts and Phase 1's pure adapters.

---

# Part 2 — milestones

## Milestone 1 — Freeze the contracts (Phase 0)
All small, mostly parallel, ship before any `1.0` tag. These paint no corners and
each is a clean first-or-second PR.

### PR #1 — Lockfile version header + reserved fields
- **Motivation:** the lock format must be able to carry `resolved` (commit),
  `signature`, `outputHash` later without a breaking on-disk change; reserve them and
  a `version = N` header now.
- **Files:** `lock.ts` (`readLock`/`writeLock`/`LockEntry`), `test.mjs` (+lock-format
  assertions), SPEC §8.
- **LOC:** ~60. **Review:** easy. **Risk:** low — old lockfiles (no version) read as
  v0 and migrate on next write; forward-only.
- **Acceptance:** an old lock (no header) still loads; new writes carry `version = 1`;
  unknown future fields are preserved on rewrite; drift detection unchanged.

### PR #2 — Optional `edition` marker in `[skill]`
- **Motivation:** freeze-or-never opt-in to stricter validation without breaking
  additive-only forward-compat.
- **Files:** `spec/schema/skill.schema.json`, `ksf.ts` (`validate`, `opt`), `SPEC.md`,
  `test.mjs`.
- **LOC:** ~40. **Review:** easy. **Risk:** low — additive optional field, no behavior
  until an edition is defined.
- **Acceptance:** `edition = "2026"` parses and round-trips; absent = current behavior;
  an unknown edition value errors with a clear message.

### PR #3 — Honest tokenizer label
- **Motivation:** stop implying per-target *tokenization*; stamp `estimate-v1`
  everywhere a token number appears, so P1.6 is a visible, versioned upgrade.
- **Files:** `ksf.ts` (`estimateTokens` doc + an exported `TOKENIZER_ID`),
  `adapters.ts` (warning text), `commands.ts` (doctor/compile/preview labels),
  `benchmark.mjs`, `docs/benchmarks/README.md` (regen), site benchmark/docs prose.
- **LOC:** ~50 code + doc regen. **Review:** easy. **Risk:** low — labels only, no
  number changes.
- **Acceptance:** every surface printing a token count also prints/records
  `estimate-v1`; benchmark determinism gate still green.

### PR #4 — Fix the dropped `authors` field
- **Motivation:** `authors` is schema'd + frozen but the loader discards it
  (gap-hunt #27); surface it at install review.
- **Files:** `ksf.ts` (`SkillManifest`, `validate`), `commands.ts` (review block),
  `test.mjs`.
- **LOC:** ~40. **Review:** easy. **Risk:** low.
- **Acceptance:** `authors` loads, appears in the review block, survives round-trip.

### PR #5 — Retire conceded surface (`publish`/`search` + index source) and reserve `[dependencies]`
- **Motivation:** stop advertising abandoned scope and stop silently dropping declared
  deps; freeze the command surface honestly.
- **Files:** `index.ts` (remove `publish`/`search` from the array), `commands.ts`
  (`normalizeSource` — remove any index short-name path; add a loud WARN when
  `[dependencies]` is non-empty at install), `SPEC.md` (mark `[dependencies]`
  reserved), `docs/roadmap.md`, `test.mjs`.
- **LOC:** ~60. **Review:** easy–medium (surface change). **Risk:** low — removing
  stubs no one scripts against; the deps WARN replaces a silent drop.
- **Acceptance:** `kitbash publish`/`search` no longer listed; a skill with a
  `[dependencies]` entry installs with a visible WARN, not silent loss; help text and
  spec agree.

### PR #6 — Exit-code contract
- **Motivation:** stop double-using `2`; document a stable enum other tools script on.
- **Files:** `commands.ts` (all `return 1/2` sites → named codes), `index.ts`
  (dispatch), `SPEC.md` (the table), `test.mjs` (assert codes per path).
- **LOC:** ~90. **Review:** medium (touches many return sites). **Risk:** medium — a
  wrong code is a contract bug; mitigated by per-path tests.
- **Acceptance:** policy-block=3, safety-lint=4, integrity-drift=5, fetch=6,
  not-implemented=7, usage=2, findings=1; documented; tested per path.

## Milestone 2 — Snapshot net + render extraction (Phase 1 prep)

### PR #7 — Conformance corpus + golden runner + toml-test + fuzzer
- **Motivation:** the safety net every later refactor needs, and the artifact that
  makes KSF a standard.
- **New files:** `conformance/` (manifest/compile/measure fixtures, `checklist.json`,
  `VERSION`), `packages/cli/scripts/conformance.mjs` (runner), `scripts/fuzz-toml.mjs`.
- **Files:** `package.json` (test scripts), CI (`ci.yml` add corpus + toml-test +
  fuzz steps).
- **LOC:** ~400 (mostly data). **Review:** medium. **Risk:** low — additive; catches
  everything downstream.
- **Acceptance:** corpus runs in CI; a deliberately-broken adapter output fails a
  golden; `toml-test` valid/invalid corpus wired; fuzzer runs a bounded budget green.

### PR #8 — Extract the shared render layer
- **Motivation:** nine hand-concatenations of frontmatter+header+body become one
  renderer, so a template change can't silently drift and the IR migration has a seam.
- **Files:** `adapters.ts` (`fileAdapter`/`claudeCode`/`mergedFileAdapter`/`skillDir`
  all call a new `renderFile(plan)`), new `render.ts`. Behavior-preserving.
- **LOC:** ~120 (net small; mostly moved). **Review:** medium. **Risk:** medium —
  must be byte-identical output; **guarded entirely by PR #7 goldens.**
- **Acceptance:** all adapter goldens byte-identical before/after; no benchmark drift.

## Milestone 3 — The IR (Phase 1 core)

### PR #9 — Introduce `SkillIR` + `buildIR` (behavior-preserving)
- **Motivation:** the load-bearing v2 change; add the IR but adapters still read
  `ir.body` as today's string, so output is unchanged.
- **New files:** `ir.ts` (`SkillIR`, `BodyBlock`, `NativeSlots`, `SkillRef`,
  `buildIR`). **Files:** `commands.ts` (`cmdCompile` builds IR, passes it where it
  passed `emitBody`), `adapters.ts` (`emit` signature accepts IR, reads `ir.body`).
- **LOC:** ~200. **Review:** hard (the contract). **Risk:** medium — guarded by
  goldens; output must not change.
- **Acceptance:** goldens byte-identical; IR is serializable + content-hashable; the
  `permissionsNote` prose still appears (moved into buildIR's body, not the driver).

### PR #10 — Adapters consume slots; native `allowed-tools` on claude-code
- **Motivation:** the first *real* wedge win — claude-code lowers permissions to
  native frontmatter instead of losing them to prose; triggers read from IR by every
  adapter that supports them.
- **Files:** `adapters.ts` (`claudeCode.lower` emits `allowed-tools`; a `toClaudeTool
  Grammar` mapper; shared prose fallback for the rest), `render.ts`, goldens (updated
  intentionally), `benchmark.mjs`/README (regen — numbers move), site docs.
- **LOC:** ~160. **Review:** hard. **Risk:** **high — the first intentional output
  change.** Mitigated: goldens updated in the same PR with the diff visible; the KSF
  tool grammar → Claude grammar mapping is the subtle part.
- **Acceptance:** claude-code output carries a correct `allowed-tools:`; other targets
  keep the prose note; degradation/explain unaffected; goldens + benchmark regenerated
  and reviewed.

### PR #11 — Pass pipeline skeleton
- **Motivation:** formalize validate→transform ordering; move the existing lints,
  budget-check, and permission-injection into named passes so third-party passes have
  a slot later.
- **New files:** `passes.ts` (`Pass`, the fixed core passes, the runner). **Files:**
  `commands.ts` (`staticChecks`/`cmdCompile` call the pipeline), `ir.ts`.
- **LOC:** ~180. **Review:** hard. **Risk:** medium — pure reorganization of existing
  logic; goldens + the full lint test-suite guard it.
- **Acceptance:** identical diagnostics and output vs before; the pipeline order is
  deterministic and documented; a no-op third-party pass hook exists but is unused.

## Milestone 4 — Exact measurement + capabilities (Phase 1 finish)

### PR #12 — Real per-family BPE tokenizer
- **Motivation:** make the one uncontested differentiator true.
- **New files:** `tokenizer.ts` + vendored BPE table data (as data files, still
  zero *runtime dependency*), `TokenizerId` registry. **Files:** `ksf.ts`
  (`estimateTokens` → `countTokens(text, tokenizerId)`), `adapters.ts` (each declares
  `tokenizer`), `commands.ts`/`benchmark.mjs` (use it), README/site (regen — all
  numbers change), the `measure/` conformance fixtures.
- **LOC:** ~300 code + vendored tables. **Review:** hard. **Risk:** high — every
  number moves; the honest label from PR #3 makes it a versioned event, not a
  surprise. Independent of the IR track, so it can land in parallel after PR #7.
- **Acceptance:** counts match reference tokenizers within tolerance on the `measure/`
  fixtures; `tokenizer@rev` stamped; benchmark regenerated.

### PR #13 — Earn the `scripts` capability
- **Motivation:** close the degenerate `capabilities: []` matrix by *implementation*,
  not by filling strings.
- **Files:** `adapters.ts` (skill-dir adapters copy `scripts/` into their output;
  declare `capabilities: ["scripts"]`; a shared `CAPABILITIES` vocab imported by
  `ksf.ts` + `adapters.ts` with a compile-time claimed-vs-delivered assertion),
  `commands.ts` (emit wiring), goldens, `test.mjs`.
- **LOC:** ~140. **Review:** medium. **Risk:** medium — changes degradation output for
  scripts-requiring skills; goldens guard it.
- **Acceptance:** a skill with `scripts/` + `requires=[scripts]` compiles the scripts
  and reports NOT degraded on skill-dir targets, still degraded on aider/agentsmd; the
  claimed-vs-delivered test passes.

## Milestone 5 — Reproducibility + machine interface (Phase 2, after adoption signal)

### PR #14 — Resolved-commit pin + `.git` strip
- **Files:** `commands.ts` (`fetchSource` runs `git rev-parse`, threads SHA), `lock.ts`
  (`resolved` field — reserved in PR #1), integrity over stripped bytes, `test.mjs`.
- **LOC:** ~90. **Review:** medium. **Risk:** medium — integrity hash of the stripped
  tree differs from today's; a one-time re-pin. Acceptance: lock carries the full SHA;
  `.git` excluded from the hash; reinstall of the same SHA is byte-identical.

### PR #15 — Restore-from-lock + `compile --check`
- **Files:** `commands.ts` (`cmdInstall` with no arg restores every locked skill;
  `cmdCompile --check` fails if output would change), `index.ts`, `test.mjs`.
- **LOC:** ~120. **Review:** medium. **Risk:** low. Acceptance: a fresh clone with
  only `kitbash.lock` restores all skills at their pinned SHAs; `--check` is CI-usable.

### PR #16 — `@kitbash/core` library boundary
- **Motivation:** split the 1093-line `commands.ts` into a pure `core` (compile/
  validate/measure/lint returning data) + a thin CLI shell; add `package.json`
  `exports`.
- **New files:** `core/` (moved logic), `cli.ts` (renderer). **Files:** `commands.ts`
  shrinks to CLI glue, `index.ts`, `package.json` (`exports`, `types`).
- **LOC:** ~250 moved, ~80 new. **Review:** hard. **Risk:** medium — large move;
  goldens + e2e guard behavior; done as pure relocation, no logic change.
- **Acceptance:** `import { compile } from "@kitbash/core"` returns a `CompileResult`;
  the CLI behaves identically; e2e green.

### PR #17 — `--json` + diagnostics API
- **Files:** `cli.ts`/`core` (envelope + `Diagnostic` codes), every command, `SPEC.md`
  (envelope schema, diagnostic-code table), `test.mjs`.
- **LOC:** ~200. **Review:** medium. **Risk:** low — additive flag. Acceptance:
  `--json` emits the versioned envelope with per-target cost + coded diagnostics; prose
  mode unchanged; envelope schema documented.

### PR #18 — Incremental + parallel compile (content-addressed cache)
- **Files:** `commands.ts`/`core` (cache keyed on IR-hash+tokenizer-rev+adapter-ver),
  new `cache.ts`, `test.mjs` (cold==warm byte-equality). Needs pure adapters (PR #9/10).
- **LOC:** ~180. **Review:** hard. **Risk:** medium — a cache bug = wrong output;
  the cold-vs-warm determinism test is the guard. Acceptance: warm cache skips
  unchanged (skill,adapter) pairs; cold and warm output byte-identical.

## Milestone 6 — Signing + ecosystem (Phase 2/3, post-adoption)

### PR #19 — Signing/provenance + `audit`
- **Files:** `lock.ts` (`signature` — reserved PR #1), `commands.ts` (verify at
  install, `[policy].trusted_signers`, TOFU, build `cmdAudit`), `SPEC.md`, `test.mjs`.
- **LOC:** ~220. **Review:** hard. **Risk:** high (a trust primitive). Acceptance:
  signed skills verify against a trust root; unsigned fall back to TOFU with a
  first-seen record; `audit` re-verifies integrity + signature + re-runs safety lints.

### PR #20–#24 — Third-party adapters, passes, certification, source-as-identity + resolver + `update`, adapter registry
- Each hangs off the frozen Phase 0/1 contracts (see graph). Deferred until adoption;
  scoped when real. Effort L each.

---

# Part 3 — contributor suitability

**Good first PRs** (self-contained, well-fenced by tests, no architectural context):
- PR #2 (edition marker), #3 (tokenizer label), #4 (authors field), #5 (retire stubs).
  Each is <60 LOC, additive, with an obvious acceptance test.
- Parts of #7 (writing conformance *fixtures* — pure data — is ideal onboarding work).

**Requires deep architectural knowledge** (touch the IR/pipeline/contract):
- PR #9 (SkillIR), #10 (native lowering + tool-grammar mapping), #11 (pass pipeline),
  #12 (tokenizer correctness), #16 (core split), #18 (cache correctness), #19 (trust).
  These need the maintainer or a trusted contributor; a wrong contract here is
  expensive to unwind.

**Middle tier** (mechanical but wide): #6 (exit codes), #8 (render extraction), #13
(scripts capability), #14/#15/#17.

---

# Part 4 — estimates

- **Total implementation time** (one experienced maintainer, part-time):
  - Milestone 1 (freeze): ~1–2 weeks. **This is the only urgent block at 0 users.**
  - Milestones 2–4 (IR + measurement + capabilities — Phase 1): ~6–10 weeks.
  - Milestones 5–6 (Phase 2/3): months, and **should not start until adoption
    justifies it.**
  - To a demonstrable v2 wedge (Milestones 1–4): ~2–3 months of focused work.
- **Biggest technical risks:**
  1. PR #10 — the KSF tool-grammar → Claude `allowed-tools` mapping (semantic, subtle,
     the first output change). Mitigation: goldens + a dedicated grammar-mapping unit
     test corpus.
  2. PR #12 — tokenizer correctness and keeping it zero-*runtime*-dependency while
     vendoring large BPE tables. Mitigation: tables as data, reference-count fixtures.
  3. PR #16 — the `core` split is a big move that could regress behavior. Mitigation:
     pure relocation, goldens + e2e as the net, no logic edits in the same PR.
- **Highest-risk migration:** PR #12 (real tokenizer) — it changes *every published
  number* at once. It is only safe because PR #3 already turned the number into a
  labeled, versioned quantity, so the change is a `estimate-v1 → cl100k@rev` changelog
  event, not a silent shift. Ship it in its own release with the benchmark diff called
  out.

---

# Part 5 — exact implementation order

No later PR rewrites an earlier one if built in this order. Within a milestone, PRs
without an arrow between them in Part 1 may land in any order or in parallel.

```
 1. PR #1  lock version + reserved fields        ─┐  freeze the on-disk + CLI
 2. PR #6  exit-code contract                     │  contracts FIRST, so #14/#15/
 3. PR #3  tokenizer honest label                 │  #16/#17/#19 build on frozen shapes
 4. PR #2  edition marker                         │  (2,3,4,5 are parallel-safe)
 5. PR #4  authors field                          │
 6. PR #5  retire stubs + reserve deps           ─┘
 ── ship: this is the 1.0-freeze release ─────────────────────────────────────────
 7. PR #7  conformance corpus + goldens + fuzz    (the safety net — before any refactor)
 8. PR #8  extract shared render layer            (guarded by #7; seam for the IR)
 9. PR #9  SkillIR + buildIR (no output change)   (needs #8's seam)
10. PR #10 native allowed-tools (FIRST change)    (needs #9 slots + #7 goldens)
11. PR #11 pass pipeline skeleton                 (needs #9; folds in existing lints)
12. PR #12 real BPE tokenizer                     (parallel track: needs only #3 + #7)
13. PR #13 earn scripts capability                (needs #9/#10 lowering + #7)
 ── ship: this is the "wedge is real and honest" release ──────────────────────────
14. PR #14 resolved-commit pin + .git strip       (needs #1)
15. PR #15 restore-from-lock + compile --check    (needs #14)
16. PR #16 @kitbash/core split                    (needs stable pipeline: after #11)
17. PR #17 --json + diagnostics                   (needs #16 + #6)
18. PR #18 incremental+parallel cache             (needs pure adapters #9/#10)
19. PR #19 signing/provenance + audit             (needs #1 signature + #14 commit)
20. PR #20+ ecosystem (adapters/passes/registry/resolver/update)  — post-adoption
```

**The line to remember:** everything through PR #6 is *freeze-or-never* and cheap —
do it now. Everything #7–#13 makes the compiler wedge true and honest — do it to earn
users. Everything #14+ is package-manager and ecosystem weight — do it only once users
exist. The order above guarantees each contract is frozen before anything depends on
it, and each refactor is snapshot-guarded before the one PR that changes output.
