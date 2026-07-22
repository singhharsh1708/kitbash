/**
 * Measured benchmark: one source skill → 8 targets, real token cost per target.
 *
 * Runs the actual compile pipeline on committed fixtures (no network), then
 * measures the emitted output the way an agent pays for it: standing cost
 * (always in context, every session) vs loaded cost (read when invoked).
 *
 * The point Kitbash keeps making: a skill authored to lazy-load costs its
 * standing stub on lazy targets and its whole body on eager ones. That gap is
 * the hidden tax of hand-maintaining a copy per agent. Here it is, in numbers.
 *
 * Reproduce:  node packages/cli/scripts/benchmark.mjs
 * Writes:     docs/benchmarks/README.md
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, standingStub } from "../dist/ksf.js";
import { ADAPTERS } from "../dist/adapters.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const cli = join(here, "../dist/index.js");
const fixture = join(repoRoot, "examples/skills/prereview");

// How each target loads a skill, read from the adapters themselves rather than
// restated here — a second copy of this map is exactly how the published numbers
// drift away from what the compiler actually emits.
const LOADING = Object.fromEntries(ADAPTERS.map((a) => [a.id, a.loading]));

function run(args, cwd) {
  const r = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`kitbash ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

/** Token cost of one skill's contribution to a target's output. */
function measure(tmp, target, skillName) {
  const read = (rel) => readFileSync(join(tmp, rel), "utf8");
  switch (target) {
    case "claude-code":
      return estimateTokens(read(`.claude/skills/${skillName}/SKILL.md`));
    case "cursor":
      return estimateTokens(read(`.cursor/rules/${skillName}.mdc`));
    case "agents":
      return estimateTokens(read(`.agents/skills/${skillName}/SKILL.md`));
    case "copilot":
      return estimateTokens(read(`.github/instructions/${skillName}.instructions.md`));
    case "cline":
      return estimateTokens(read(`.clinerules/${skillName}.md`));
    case "windsurf":
      return estimateTokens(read(`.windsurf/rules/${skillName}.md`));
    case "gemini":
    case "aider":
    case "agentsmd": {
      const file = target === "gemini" ? "GEMINI.md" : target === "aider" ? "CONVENTIONS.md" : "AGENTS.md";
      const m = read(file).match(new RegExp(`<!-- kitbash:begin ${skillName} -->[\\s\\S]*?<!-- kitbash:end ${skillName} -->`));
      return m ? estimateTokens(m[0]) : 0;
    }
    default:
      return 0;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "kitbash-bench-"));
const skills = [];
try {
  // Every target present so all eight adapters fire.
  for (const d of [".claude", ".cursor", ".agents", ".clinerules", ".windsurf", ".github"]) mkdirSync(join(tmp, d));
  writeFileSync(join(tmp, "GEMINI.md"), "");
  writeFileSync(join(tmp, "CONVENTIONS.md"), "");

  run(["init"], tmp);

  // 1) A real manifested skill (budget 1500, lazy disclosure).
  run(["install", `file:${fixture}`], tmp);
  skills.push({ name: "prereview", kind: "manifested (budget 1500, lazy)", standing: 60 });

  // 2) A bare SKILL.md-only skill — the skills.sh / Claude Skills convention,
  //    which has no manifest and so no declared budget. Sized to a realistic
  //    mid-size community skill.
  const bare = join(tmp, "bare");
  mkdirSync(bare);
  const bareBody =
    "Enforce this project's code-review checklist on every diff before it merges.\n\n" +
    Array.from({ length: 40 }, (_, i) => `- Rule ${i + 1}: check the diff for issue class ${i + 1} and cite the exact line and the fix.`).join("\n") +
    "\n";
  writeFileSync(join(bare, "SKILL.md"), `---\nname: review-checklist\ndescription: Enforce the team code-review checklist\n---\n\n${bareBody}`);
  run(["install", `file:${bare}`], tmp);
  skills.push({ name: "review-checklist", kind: "bare / unmanifested (no budget)", standing: null });

  run(["compile"], tmp);

  const targets = Object.keys(LOADING);
  const rows = [];
  for (const s of skills) {
    const stubTokens = estimateTokens(standingStub(readFileSync(join(tmp, ".kitbash/skills", s.name, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "")));
    const perTarget = {};
    for (const t of targets) {
      const loaded = measure(tmp, t, s.name);
      const standing = LOADING[t] === "lazy" ? stubTokens : loaded;
      perTarget[t] = { loaded, standing };
    }
    rows.push({ ...s, stubTokens, perTarget });
  }

  // ---- console ----
  console.log(`Measured compile cost — one source skill, ${Object.keys(LOADING).length} targets (est. ~4 chars/token)\n`);
  for (const r of rows) {
    console.log(`${r.name}  (${r.kind})`);
    console.log(`  ${"target".padEnd(12)} ${"loaded".padStart(8)} ${"standing".padStart(9)}  loading`);
    for (const t of Object.keys(LOADING)) {
      const c = r.perTarget[t];
      console.log(`  ${t.padEnd(12)} ${String(c.loaded).padStart(8)} ${String(c.standing).padStart(9)}  ${LOADING[t]}`);
    }
    const standingEager = Object.entries(r.perTarget).find(([t]) => LOADING[t] === "eager")[1].standing;
    const standingLazy = Object.entries(r.perTarget).find(([t]) => LOADING[t] === "lazy")[1].standing;
    console.log(`  → standing tax: ~${standingLazy} tok lazy vs ~${standingEager} tok eager — ${(standingEager / Math.max(1, standingLazy)).toFixed(0)}× per session\n`);
  }

  // ---- doc ----
  const fmt = (n) => n.toLocaleString("en-US");
  let md = `# Benchmark: one skill, every target

<!-- generated by kitbash — run: node packages/cli/scripts/benchmark.mjs -->

Kitbash compiles one source skill to every agent's native format. This measures what that output actually costs, in tokens, per target — run on committed fixtures through the real \`kitbash compile\` pipeline.

Two costs matter:

- **Loaded** — tokens the agent reads when the skill is in play.
- **Standing** — tokens sitting in the context window *every session, before the skill is even invoked*. Lazy targets keep only a stub; eager targets carry the whole body.

Token counts are estimates (~4 chars/token), the same estimator the compiler enforces budgets with, so the benchmark and the build agree by construction. Absolute counts will differ by a few percent against a model-specific tokenizer; the lazy-vs-eager *ratio* is what the argument rests on. Loading modes are read from the adapters themselves, not restated here, so this table cannot drift from what the compiler emits. Reproduce with \`node packages/cli/scripts/benchmark.mjs\`.

`;
  for (const r of rows) {
    md += `## \`${r.name}\` — ${r.kind}\n\n`;
    md += `| Target | Loaded (tok) | Standing (tok) | Loading |\n|---|--:|--:|:--|\n`;
    for (const t of Object.keys(LOADING)) {
      const c = r.perTarget[t];
      md += `| ${t} | ${fmt(c.loaded)} | ${fmt(c.standing)} | ${LOADING[t]} |\n`;
    }
    const standingEager = Object.entries(r.perTarget).find(([t]) => LOADING[t] === "eager")[1].standing;
    const standingLazy = Object.entries(r.perTarget).find(([t]) => LOADING[t] === "lazy")[1].standing;
    md += `\n**Standing tax:** ~${fmt(standingLazy)} tokens on a lazy target vs ~${fmt(standingEager)} on an eager one — about **${(standingEager / Math.max(1, standingLazy)).toFixed(0)}× per session** for the identical skill. A team running four agents pays that gap four times over, forever, unless something measures it.\n\n`;
  }
  md += `## Why this is the pitch

Kitbash compiles to the cheapest loading mode each target actually supports — Claude Code, Cursor, Devin (ex-Windsurf) and the vendor-neutral \`.agents/skills/\` path all load on demand, so a skill there costs only its stub. The table above is what it costs on the targets whose only mode is eager: the whole body, every session, before the skill is invoked.

No other format has a field for this. Kitbash measures it at compile time, warns when a lazy-authored skill lands on an eager target, and fails the build under \`--strict\`. The copy-per-agent status quo pays the eager cost on every target and never sees the number.\n`;

  const outDir = join(repoRoot, "docs/benchmarks");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "README.md"), md);
  console.log(`wrote docs/benchmarks/README.md`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
