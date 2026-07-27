# RFC 0003 — Kitbash v2 architecture

- Status: draft
- Author(s): Kitbash maintainers
- Depends on: [RFC 0001](0001-ksf.md), [RFC 0002](0002-ksf-1.0-stabilization.md)

## Summary

Kitbash today is a frontend that produces one opaque markdown string and N backends
that string-template it. That shape cannot support native per-target lowering,
exact measurement, third-party adapters, compiler passes, or incremental builds —
the things a standard build system needs. This RFC designs the v2 architecture that
adds the missing middle (a small IR + a pass pipeline) without betraying the four
things that make Kitbash worth using: **zero runtime dependencies, compile-to-native,
deterministic builds, install-time trust.** KSF stays backward compatible; the change
is internal.

The guiding rule is the review's, made concrete: **every subsystem must justify its
existence, and the IR is minimal — a structured skill document, not a markdown AST.**

---

## 1. Architecture

```
                         kitbash v2 — data flow

  skill.toml ─┐
              ├─▶ [1 PARSE] ─────▶ RawSkill ──▶ [2 VALIDATE] ──▶ ValidatedSkill
  SKILL.md ───┘   toml.ts,         (manifest    schema+bounds     (typed manifest
  scripts/*       frontmatter       + raw body   + SAFETY lints    + raw body,
  evals/*         splitter)         + files)     = a validate pass  no diagnostics
                                                       │            left unhandled)
                                                       ▼
                                              ┌──────────────────┐
                                              │   [3 BUILD IR]    │  resolve templates,
                                              │   ksf → SkillIR   │  extract standing stub,
                                              │                   │  identify sections,
                                              │                   │  native slots, refs
                                              └────────┬─────────┘
                                                       │  SkillIR (see §3)
                                                       ▼
                                     ┌─────────────────────────────────┐
                                     │        [4 PASS PIPELINE]         │
                                     │  ordered, some third-party:      │
                                     │   validate → transform → (fixed) │
                                     │   • canonicalize                 │
                                     │   • resolve-refs                 │
                                     │   • budget-check   (validate)    │
                                     │   • inject-permissions (into IR, │
                                     │       NOT prose in the driver)   │
                                     │   • <third-party transform>      │
                                     └───────────────┬─────────────────┘
                                                     │  lowered SkillIR
                        ┌────────────────────────────┼────────────────────────────┐
                        ▼                             ▼                             ▼
                 [5 LOWER + EMIT]              [5 LOWER + EMIT]             [5 LOWER + EMIT]
                 adapter A.lower(IR)           adapter B.lower(IR)          adapter …N
                  → RenderPlan                  → RenderPlan                 → RenderPlan
                  → CompiledFile[]              → CompiledFile[]             → CompiledFile[]
                 (claude-code: native           (agentsmd: prose             (third-party npm
                  allowed-tools frontmatter)     fallback for perms)          adapter, pinned)
                        │                             │                             │
                        └──────────────┬──────────────┴──────────────┬──────────────┘
                                       ▼                             ▼
                              [6 MEASURE]                     ┌──────────────┐
                              tokenizer per adapter    ◀──────│  TOKENIZER   │ vendored BPE
                              (exact, family BPE)             │  registry    │ tables as data
                                       │                      │ tiktoken/SP  │ (still zero-dep)
                                       ▼                      └──────────────┘
                              [7 RECONCILE + WRITE]  (the driver — core, not extensible)
                               • marker-merge shared files    ┌──────────────┐
                               • conflict detection           │    CACHE     │ content-addressed
                               • stale-output prune       ◀───│ .kitbash/    │ (IR hash, tokenizer
                               • write CompiledFile[]         │  cache/      │  rev, adapter ver)
                               • update kitbash.lock          └──────────────┘  → incremental skip
                                       │
                                       ▼
                          native outputs + kitbash.lock + measurements

  ─────────────────────────────────────────────────────────────────────────────────
  TRUST PIPELINE (cross-cutting, runs at fetch+install; a set of VALIDATE passes):
    fetchSource ─▶ resolve commit (SHA) ─▶ strip .git ─▶ integrity hash
      ─▶ safety lints (visible-text, dynamic-context, remote-exec, secrets) [HARD]
      ─▶ behavioral heuristics [WARN]  ─▶ [policy] gate [HARD]
      ─▶ (optional) signature/attestation verify against trust root
      ─▶ review block (manifest + resolved body) ─▶ y/N  ─▶ pin in lock
```

Everything left of the pass pipeline is the **frontend** (parse/validate/IR). The
pass pipeline is the **middle** (the new part). Lowering+emit is the **backend**.
The cache and tokenizer are services the pipeline calls. The trust pipeline is a
cross-cutting set of validate passes gated at fetch/install, not compile.

---

## 2. Compiler pipeline

Eight stages. Each names its inputs, outputs, invariants, and where a third party
may extend it. **Only the pass pipeline (stage 4) and adapter set (stage 5) are
extensible; everything else is core and fixed.**

### Stage 1 — Parse
- **In:** a skill directory (`skill.toml`, `SKILL.md`, `scripts/`, `evals/`).
- **Out:** `RawSkill { manifestTable, rawBody, frontmatter, files[] }`.
- **Invariants:** total function or a typed parse error; never partial. Parses
  untrusted remote input, so it is a security boundary (see §9 of the review — the
  TOML parser is named/fuzzed).
- **Extension:** none. The format grammar is fixed.

### Stage 2 — Validate
- **In:** `RawSkill`.
- **Out:** `ValidatedSkill` or `Diagnostic[]` with a failure. Runs the schema, the
  numeric/enum/type bounds, and the **safety lints as validate passes** (the trust
  gate lives here, not bolted onto install).
- **Invariants:** if it returns a `ValidatedSkill`, every hard rule held; no silent
  coercion (the 0.9.0 fix, formalized). Warn-level diagnostics carry forward.
- **Extension:** third-party **validate passes** may ADD diagnostics; they may never
  remove or downgrade a core diagnostic (§5).

### Stage 3 — Build IR
- **In:** `ValidatedSkill`.
- **Out:** `SkillIR` (§3): typed manifest carried intact + a light body model
  (stub, sections, native slots, refs), with templates resolved.
- **Invariants:** template resolution is total (an unresolved `{{...}}` is a hard
  diagnostic, per spec §3); the IR is serializable and content-hashable (feeds the
  cache); building the IR does no target-specific work.
- **Extension:** none. The IR shape is a frozen contract (adapters and passes depend
  on it).

### Stage 4 — Pass pipeline
- **In:** `SkillIR`.
- **Out:** a transformed `SkillIR`.
- **Invariants:** passes are ordered deterministically; a pass is a pure function
  `(SkillIR, PassCtx) → SkillIR`; validate passes run before transform passes; the
  fixed core passes (canonicalize, resolve-refs, budget-check, inject-permissions)
  always run and cannot be removed. **Permissions are injected into the IR here as
  structured data, so each adapter can lower them natively or to prose — the driver
  no longer flattens them to English before adapters run.**
- **Extension:** `[project].passes` names transform/validate passes (pinned npm
  packages). Lowering is NOT a pass — it is adapter-owned (§5).

### Stage 5 — Lower + Emit (per adapter)
- **In:** the lowered `SkillIR`, a `LowerCtx` (target root, active config).
- **Out:** `CompiledFile[]` per adapter, plus per-file `RenderPlan` metadata.
- **Invariants:** `adapter.lower` is pure (no IO, network, clock, or randomness);
  it returns a plan, the core renders bytes (one YAML/marker/header renderer, not
  nine hand-concatenations); output is byte-stable across runs and machines.
- **Extension:** the adapter set (§4) — first-party in-tree + third-party pinned.

### Stage 6 — Measure
- **In:** each adapter's emitted content + its declared tokenizer id.
- **Out:** exact per-target loaded/standing token counts, stamped with
  `tokenizer@rev`.
- **Invariants:** counts are reproducible for a given tokenizer revision; a
  tokenizer upgrade is a versioned, changelog-visible event, never silent drift.
- **Extension:** the tokenizer registry (new BPE families as vendored data).

### Stage 7 — Reconcile + Write
- **In:** all adapters' `CompiledFile[]`.
- **Out:** files on disk, updated `kitbash.lock`, stale outputs pruned.
- **Invariants:** marker-merge preserves user content; only kitbash-marked sections
  are touched; prune removes only generated files, never colocated user files (the
  0.9.0 fix); conflict on two skills writing one path is surfaced.
- **Extension:** none. This is core correctness.

### Stage 8 — Cache (incremental + parallel)
- **In/Out:** wraps stages 3–6. Key = hash of (SkillIR, tokenizer rev, adapter
  version, pass set). A cache hit skips lower+emit+measure for that (skill, adapter)
  pair.
- **Invariants:** cache is a pure optimization; a cold cache and a warm cache
  produce byte-identical output (this is the determinism test). Adapters being pure
  is what makes both caching and parallelism safe — the pipeline can lower every
  (skill × adapter) pair concurrently with no shared state.
- **Extension:** none.

---

## 3. Intermediate Representation

**Yes, Kitbash needs an IR — but a small one.** The failure mode to avoid is a full
markdown AST: that over-couples to markdown internals, bloats the frozen contract,
and buys nothing, because adapters render *markdown-ish* text anyway. The IR exists
for exactly one reason: **to let each backend lower the cross-cutting concerns
(permissions, triggers, description, references) natively instead of receiving a
pre-flattened English string.** It is a structured skill document, not a syntax tree.

```ts
interface SkillIR {
  manifest: SkillManifest;          // the already-typed manifest, carried intact
  stub: string;                     // the standing stub (first real paragraph)
  body: BodyBlock[];                // ordered blocks; prose stays opaque text
  slots: NativeSlots;               // structured data backends may render natively
  refs: SkillRef[];                 // scripts/, artifacts, prompts the body points at
  provenance: { source: string; resolved: string; tokenizerHints: string[] };
}

type BodyBlock =
  | { kind: "prose"; text: string }            // opaque — not parsed into an AST
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string };

interface NativeSlots {                          // the reason the IR exists
  description: string;
  permissions: { tools: string[]; network: boolean; write: boolean };
  triggers: { commands: string[]; auto: string[]; events: string[] };
  disclosure: "lazy" | "eager";
}

type SkillRef =
  | { kind: "script"; path: string }
  | { kind: "artifact"; name: string; version: string }
  | { kind: "prompt"; path: string };
```

**Example.** For `prereview` (`tools = ["read","grep","bash:git diff *"]`, a
`/prereview` command, a `scripts/` dir), the IR carries `slots.permissions.tools`
and `slots.triggers.commands` as data and `refs: [{kind:"script",...}]`.

**How adapters consume it.** Each adapter reads the slots and decides, per target:

```ts
// claude-code: lower permissions NATIVELY (today they are lost to prose)
lower(ir: SkillIR): RenderPlan {
  return {
    files: [{
      path: `.claude/skills/${ir.manifest.skill.name}/SKILL.md`,
      frontmatter: {
        name: ir.slots.description ? ir.manifest.skill.name : ...,
        description: ir.slots.description,
        "allowed-tools": toClaudeToolGrammar(ir.slots.permissions.tools), // NATIVE
      },
      body: ir.body,                 // core renders it
    }],
    // scripts/ ref → the adapter declares it copies scripts (earns the capability)
    copies: ir.refs.filter(r => r.kind === "script"),
  };
}

// agentsmd: no native permission slot → lower to a prose note (shared fallback)
lower(ir: SkillIR): RenderPlan {
  return { files: [{ path: "AGENTS.md", merge: true,
    body: [...ir.body, permissionsProse(ir.slots.permissions)] }] };
}
```

This is the whole point: the same structured permission data lowers to a native
`allowed-tools:` on Claude Code and to a prose note on AGENTS.md — the "compiler +
conformance contract" wedge becomes real instead of prose-deep, and triggers stop
being read by one adapter of nine.

---

## 4. Adapter plugin system

```ts
interface Adapter {
  readonly apiVersion: 1;                        // negotiated; core refuses mismatched majors
  readonly id: string;                           // "claude-code", "acme-internal"
  readonly capabilities: readonly Capability[];  // ONLY what lower() delivers (invariant)
  readonly loading: "lazy" | "eager";
  readonly tokenizer: TokenizerId;               // which family measures this target
  detect(root: string): boolean;                 // pure
  managedPaths(name: string): ManagedPath[];     // adapter OWNS what it writes+prunes
  lower(ir: SkillIR, ctx: LowerCtx): RenderPlan; // pure: (IR, ctx) → plan; no IO
}
```

**Lifecycle:** discover → version-negotiate → `detect` → (cache check) → `lower` →
core emit → `measure`. A run touches an adapter only through these; the core never
hands it a filesystem or network handle.

**Version negotiation.** `apiVersion` is a single integer. The core supports a
window (e.g. v1–v2); an adapter outside the window is refused with a clear
diagnostic, not silently run. Additive changes to `SkillIR`/`RenderPlan` bump the
minor and stay compatible; a breaking change bumps `apiVersion`.

**Capability negotiation.** `capabilities` is validated against a single shared
`CAPABILITIES` vocabulary (imported by both the loader and the adapters, fixing the
double-definition). The compile-time invariant: an adapter may list a capability
**only if `lower` produces its primitive** (the `capabilities: []` correctness rule,
now enforced by a test that diffs claimed vs delivered). Degradation is computed from
real capabilities, so `explain` stops lying.

**Managed paths.** Each adapter declares `managedPaths`; `MANAGED_DIRS` is derived
from the active adapters (a removed adapter's prune entry deletes itself — no dead
in-tree list).

**Diagnostics.** `lower` may return diagnostics in the `RenderPlan`; it never throws
for expected conditions. All diagnostics use the shared code/severity contract (§6).

**Plugin discovery.** First-party adapters are in-tree. Third-party: `[project].adapters
= ["@acme/kitbash-adapter-foo"]` → dynamic `import()`, **gated by the same trust the
skills get**: the package is pinned in the lockfile with an integrity hash and must
pass a `[policy].allow_adapters` allowlist. A third-party adapter you have not pinned
does not load.

**Security + determinism.** Adapters run in-process (no sandbox VM — that violates
"avoid unnecessary abstraction" and zero-dep), but they are **pure by contract**:
they receive only the IR and a data-only `LowerCtx`, never fs/net/clock handles.
Determinism is guaranteed structurally (no IO to be nondeterministic about) and
verified by the cold-vs-warm-cache byte-equality test. A third-party adapter that
tries to reach outside its inputs simply has nothing to reach through.

---

## 5. Compiler pass system

Passes model cross-cutting transforms the way LLVM/Babel/rustc do, but deliberately
smaller.

```ts
interface Pass {
  readonly name: string;
  readonly kind: "validate" | "transform";       // NOT "lower" — lowering is adapter-owned
  run(ir: SkillIR, ctx: PassCtx): { ir: SkillIR; diagnostics: Diagnostic[] };
}
```

**Ordering.** Fixed phases, deterministic within each:
1. **validate passes** (core: schema-conformance, safety-lints, budget-check) —
   run first, fail fast.
2. **transform passes** (core: canonicalize → resolve-refs → inject-permissions).
3. third-party passes run **after** their phase's core passes, in lockfile-declared
   order (deterministic, pinned).

**Optimization passes** in Kitbash's world = context-cost reductions: e.g. a
`dedupe-boilerplate` transform, or a `strip-nonessential` pass an author opts into.
These are transforms; they must preserve semantics and are off by default.

**Validation passes** add diagnostics; **lowering is not a pass** — it is the
adapter's job, because lowering is inherently per-target and belongs with the code
that knows the target.

**Intentionally NOT extensible:** parse, the IR shape, the *core* validate passes
(a third-party pass cannot disable the safety/trust lints — it can only add), emit +
reconcile (marker-merge/prune), the lockfile writer, and the trust pipeline. If a
third party could weaken the trust gate, the trust model is gone. This boundary is
the security-critical invariant of the whole design.

---

## 6. Public API

Two consumers: humans (CLI prose) and machines (library + `--json`). Both sit on one
core.

```ts
// @kitbash/core — the stable library boundary (package.json "exports")
export function compile(dir: string, opts?: CompileOptions): CompileResult;
export function validate(dir: string): ValidationResult;   // parse+validate, no emit
export function measure(dir: string, opts?): MeasureResult; // per-target exact counts
export function lint(dir: string): Diagnostic[];

interface CompileResult {
  schemaVersion: 1;
  skill: { name: string; version: string; source: string; resolved: string };
  outputs: { adapter: string; files: { path: string; bytes: number }[];
             loaded: number; standing: number; tokenizer: string }[];
  diagnostics: Diagnostic[];
  summary: { targets: number; errors: number; warnings: number };
}

interface Diagnostic {                 // the stable diagnostics contract
  code: string;                        // "KB1004" — stable, documented, greppable
  severity: "error" | "warning" | "info";
  message: string;
  file?: string; span?: [number, number];
  data?: Record<string, unknown>;      // machine-actionable payload
}
```

```jsonc
// kitbash compile --json  → one versioned envelope, the wedge as DATA
{ "schemaVersion": 1, "command": "compile",
  "results": [ { "adapter": "claude-code", "loaded": 567, "standing": 40,
                 "tokenizer": "cl100k@2024-05", "files": [...] } ],
  "diagnostics": [ { "code": "KB2003", "severity": "warning",
                     "message": "eager target carries 507 standing tokens", ... } ],
  "summary": { "targets": 9, "errors": 0, "warnings": 3 } }
```

**Exit-code contract** (documented in SPEC, stop double-using 2):

| code | meaning |
|---|---|
| 0 | success |
| 1 | findings (lint/test failures, degradation under --strict) |
| 2 | usage error |
| 3 | policy block |
| 4 | safety-lint block |
| 5 | integrity drift |
| 6 | fetch/network failure |
| 7 | not implemented |

The CLI is a thin renderer over `@kitbash/core`; `--json` prints the envelope, no
flag prints prose. An editor, a CI action, or another tool builds on `core`.

---

## 7. Testing strategy

```
                     what each layer catches
      ┌───────────────────────────────────────────────────┐
  ▲   │ regression   every fixed bug → a permanent fixture │
  │   ├───────────────────────────────────────────────────┤
  │   │ integration  the real dist CLI in temp dirs        │  process behavior,
  │   │  (e2e, today's test.mjs — KEPT, not replaced)      │  exit codes, prompts
  │   ├───────────────────────────────────────────────────┤
  │   │ conformance  data-only KSF corpus (§8)             │  spec compliance,
  │   │              run by ANY implementation             │  cross-impl agreement
  │   ├───────────────────────────────────────────────────┤
  │   │ snapshot     skill × adapter → byte-exact goldens  │  accidental output drift,
  │   │                                                     │  determinism
  │   ├───────────────────────────────────────────────────┤
  │   │ property     parse∘print roundtrip; compile is     │  whole input classes:
  │   │              idempotent; cold cache == warm cache  │  determinism, no coercion
  │   ├───────────────────────────────────────────────────┤
  │   │ fuzz         TOML parser; lint regexes vs a         │  parser crashes, ReDoS,
  │   │              false-positive corpus                  │  lint FP/FN drift
  │   ├───────────────────────────────────────────────────┤
 many  │ unit         parser, tokenizer, each lint, IR      │  logic in isolation
      └───────────────────────────────────────────────────┘
```

- **unit** — the parser, the tokenizer per family (against reference token counts),
  each lint detector, IR construction. Fast, most numerous.
- **parser** — a dedicated tier wiring the **BurntSushi `toml-test`** corpus, so the
  KSF-TOML subset boundary is exactly where the spec claims.
- **property** — `parse(print(x)) == x`; `compile(compile(x)) == compile(x)`
  (idempotent); `coldCache == warmCache` (determinism); no schema-invalid input is
  silently coerced.
- **fuzz** — the TOML parser (crashes/hangs on untrusted remote input) and the lint
  regexes (a corpus of real secrets + benign lookalikes guards FP/FN; catches ReDoS).
- **snapshot** — every (skill, adapter) pair to byte-exact goldens; guards the
  maintainer's own adapter edits, not just users'.
- **conformance** — §8; the authority for "supports KSF."
- **integration** — today's e2e script, unchanged in shape (the review confirmed it
  is the right *shape*, just insufficient alone).
- **regression** — the standing rule already in force: every fixed bug gets a fixture.

---

## 8. Conformance suite

`conformance/` is **data-only** so any implementation in any language can run it.

```
conformance/
  VERSION                       # the KSF version this corpus certifies (e.g. 1.0)
  manifest/                     # parse+validate fixtures
    valid/xxxx.toml             # input
    valid/xxxx.json             # expected parsed manifest
    invalid/yyyy.toml
    invalid/yyyy.error          # expected diagnostic code(s), e.g. KB1002
  compile/                      # lowering fixtures
    <case>/skill/               # a full skill dir
    <case>/<adapter-id>/…       # expected byte-exact emitted files, per adapter
  measure/                      # measurement fixtures
    <case>/skill/
    <case>/expected.json        # { "tokenizer": "cl100k@rev", "loaded": N, "standing": M }
  checklist.json                # SPEC §9 MUST/SHOULD items → the fixtures that prove each
```

**Fixture format:** input file + expected output file (or expected error code). No
executable expectations — a runner compares its own output to the committed files.

**Adapter certification:** an adapter is "KSF-conformant" if, over the `compile/`
fixtures naming it, it produces the committed goldens (MUST-tagged fixtures) and its
`capabilities` match what its output actually delivers. First-party adapters are
certified in CI; third-party adapters ship the corpus result in their README.

**How an independent implementation becomes "KSF compliant":** run the corpus for a
given `VERSION`, report pass rate. Compliance = 100% of MUST fixtures + declared
handling of SHOULD fixtures. This — not Kitbash's source — is the authority. That is
the difference between a spec-shaped README and a standard.

**Versioning:** the corpus is versioned with KSF. Additive-only within a major means
a KSF 1.1 corpus is a superset of 1.0; a certified 1.0 impl still passes the 1.0
subset. A major bump ships a new corpus and a migration note.

---

## 9. Versioning

Four independent version lines, each with a job:

| line | what it versions | rule |
|---|---|---|
| **KSF version** | the format (manifest fields, semantics) | frozen fields; additive-only within a major (RFC 0002) |
| **edition** (opt-in) | a skill's declared strictness target | optional `edition = "2026"` in `[skill]`; unset = lenient/forward-compat default |
| **compiler version** | the CLI/library (semver) | independent; old skills compile on new compilers unchanged |
| **adapter apiVersion** | the Adapter contract | integer; negotiated window; additive minor, breaking major |
| **lockfile version** | `kitbash.lock` on-disk format | `version = N` header; reader migrates old N forward |

**The edition marker** (new, cheap, freeze-or-never) resolves the tension between
"forward-compat requires warn-not-fail on unknown fields" and "authors sometimes want
strictness." Unset: unknown fields warn (a newer skill compiles on an older
compiler). `edition = "2026"`: the compiler may hard-fail unknowns the edition
knows about. It gives an explicit opt-in to stricter behavior without abandoning the
additive-only default — the same move as Rust editions.

**How compatibility holds for 10 years:** (1) additive-only within a KSF major keeps
old skills valid; (2) the conformance corpus per version makes "still compatible"
testable, not asserted; (3) the edition marker lets the format evolve strictness
without breaking un-editioned skills; (4) the lockfile `version` header lets the
on-disk format migrate; (5) the adapter `apiVersion` window lets the backend contract
move without orphaning third-party adapters overnight. A breaking change is always
possible — it just costs a KSF major, a new corpus, a migration note, and an edition.

---

## 10. Migration (no rewrite)

The v2 architecture is reached by **adding the middle and reserving contracts**, not
rewriting. The current code is largely kept: the manifest types, the lockfile hasher,
the lints, the marker-merge/prune, the e2e harness all survive. What changes is that
the opaque-string flow becomes an IR flow, and the frozen surfaces get reserved before
1.0.

### Phase 0 — freeze-or-never (before any 1.0 tag) — effort: **S–M (weeks)**
The only genuinely urgent work at 0 users, because it is impossible to change after a
freeze:
- Reserve lockfile fields (`resolved` commit, `signature`, `outputHash`, `version = N`
  header) even before the machinery behind them exists.
- Add the optional `edition` marker to `[skill]` (schema + loader).
- Freeze the Adapter interface, the exit-code enum, and the `--json` envelope schema
  as documented contracts.
- Label the tokenizer honestly (`tokenizer = "estimate-v1"`) everywhere a number
  appears; stop implying per-target *tokenization*.
- Delete the conceded `publish`/`search` stubs and the index short-name source form;
  mark `[dependencies]` spec-reserved and WARN loudly instead of silently dropping.
- Reconcile the two validators so the frozen `authors` field stops being dropped.
- Fix source-as-identity path/key format (so `acme/review` and `globex/review` can
  coexist later without a lockfile break).

### Phase 1 — make the wedge true — effort: **L (months)**
- Introduce `SkillIR` + the pass pipeline; move permissions/triggers into IR passes;
  adapters become `lower(IR)`.
- Vendor per-family BPE tokenizers as data; wire the measure stage; stamp
  `tokenizer@rev`.
- Ship the data-only conformance corpus + per-adapter golden snapshots + `toml-test`
  + the fuzzer.
- Earn the `scripts` capability (adapters copy `scripts/`), closing the degenerate
  matrix by implementation.

### Phase 2 — package-manager + trust credibility — effort: **L**
(build only once people install across machines/CI)
- Resolved-commit pin + `.git` strip + `install` (no args) = restore-from-lock +
  `compile --check`.
- Optional signing/provenance + a trust root + the `audit` command.
- `@kitbash/core` library boundary + `--json` on all commands + the diagnostics API.
- Incremental + parallel compile via the content-addressed cache.

### Phase 3 — ecosystem — effort: **L (post-adoption)**
- Third-party adapters (`[project].adapters`, pinned) and third-party passes.
- Adapter certification against the corpus.
- Version-range dependency resolution keyed on source identity, and `update` with a
  capability-drift re-consent gate.
- A registry **of adapters/passes** (not of skills — skills stay decentralized,
  git-URL-as-identity, Go-modules style). The one naming authority Kitbash needs is
  for the code that extends it, not for the content it compiles.

---

## Finally

### 1. MUST happen before v1.0
All of **Phase 0** (freeze-or-never), plus the honest tokenizer label, plus enough of
the **IR** that KSF 1.0 is not frozen around the opaque-string body model. If you
freeze the current shape, the IR becomes a KSF-2.0-major change later; if you land the
IR first, it is internal. Reserve every extension point (adapter apiVersion, `--json`
envelope, exit codes, lockfile fields, edition) — reserving is cheap now and
impossible after.

### 2. Should wait until after adoption
Signing/provenance, the resolver + `update`, third-party adapters/passes, the
adapter registry, incremental/parallel caching. All are correct and correctly
ordered — but every one of them only pays off at a user count Kitbash does not have.
Building them on spec is polishing an engine no one drives.

### 3. Should probably never be built
- A **skills hosting registry** — ceded to vercel-labs/skills (27k stars); Kitbash is
  the build system, not the store.
- A **runtime harness** (learned instincts, session memory, a dashboard) — that is
  ECC's product; competing there at 1/30,000th the size is a loss.
- A **config auditor** for your own `.claude`/mcp/hooks — that is AgentShield/ctxlint.
- A **plugin sandbox VM** — over-abstraction; purity-by-contract is enough and keeps
  the code approachable.

### 4. Biggest architectural risks
1. **Freezing KSF 1.0 around the string-templater shape** — makes the IR a major-bump
   change and permanently caps the wedge at prose-deep. (Mitigation: land the IR in
   Phase 1, before the freeze.)
2. **The tokenizer staying approximate** — the one uncontested differentiator is
   dishonest until it is exact. (Mitigation: Phase 0 honest label, Phase 1 real BPE.)
3. **Adapter API churn** breaking third parties once they exist. (Mitigation: freeze
   `apiVersion` + a support window before opening the door.)
4. **The trust gate being weakenable by a third-party pass** — would erase the trust
   model. (Mitigation: core validate passes are non-removable by design; §5.)

### 5. Biggest opportunities
1. **The conformance corpus** — the single thing that turns "a tool" into "a standard"
   others implement. Nobody in this space has one.
2. **Exact per-target measurement** — the uncontested wedge, made true.
3. **Third-party adapters** — 50+ targets without the maintainer becoming the
   bottleneck; the product thesis ("one source → N formats") only scales if N is not
   gated by release cadence.
4. **The library API** — being the substrate editors/CI/other tools build on is what
   "standard build system" actually means.

### 6. Verdict
**Yes — this architecture can realistically carry Kitbash for a decade, but only
because it is small.** The IR is one struct, not a syntax tree. The pass pipeline is
two phases, not an optimizer framework. The plugin model is purity-by-contract, not a
sandbox. Every subsystem earns its place against a named failure in the current code.
The current shape *cannot* support the goal — it caps at nine hand-maintained string
templaters with a heuristic measurement. The v2 shape can, and it is reachable by
addition, not rewrite. The decisive move is **sequencing, not scope**: freeze the
contracts correctly now, make the wedge true and honest next, and defer everything
that only matters at scale until scale exists. If Kitbash does Phase 0 and enough of
Phase 1 to prove the wedge, it has an architecture worth standardizing — and the
discipline to have stopped there is what will keep it maintainable.
