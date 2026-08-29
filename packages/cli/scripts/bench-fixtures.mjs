/**
 * The benchmark corpus, built once and shared.
 *
 * Both `benchmark.mjs` (which publishes the token table) and
 * `tokenizer-check.mjs` (which measures how wrong the estimator is) have to
 * look at *the same bytes*, or the error bar the table quotes is an error bar
 * for some other corpus. Extracted here so there is one definition of the
 * fixtures and one extractor per target, not two that drift.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { standingStub } from "../dist/ksf.js";
import { ADAPTERS } from "../dist/adapters.js";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
const cli = join(here, "../dist/index.js");

// agent-plugins is an opt-in publishing target (agent-plugins.org): it is not part
// of a repo's auto-detected fan-out and would not fire in this fixture's compile
// (no plugin.json). It is lazy, so it carries the same stub cost as every other
// lazy target and adds no standing-tax story — this benchmark measures the
// always-on tax across the targets a repo compiles to by default, so it is excluded.
const BENCH_ADAPTERS = ADAPTERS.filter((a) => a.id !== "agent-plugins");

// How each target loads a skill, read from the adapters themselves rather than
// restated here — a second copy of this map is exactly how the published numbers
// drift away from what the compiler actually emits.
export const LOADING = Object.fromEntries(BENCH_ADAPTERS.map((a) => [a.id, a.loading]));

export const SKILLS = [
  { name: "prereview", kind: "manifested (budget 1500, lazy)", standing: 60 },
  { name: "review-checklist", kind: "bare / unmanifested (no budget)", standing: null },
];

function run(args, cwd) {
  const r = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`kitbash ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

/** The compiled text of one skill's contribution to a target's output. */
export function artifactText(tmp, target, skillName) {
  const read = (rel) => readFileSync(join(tmp, rel), "utf8");
  switch (target) {
    case "claude-code":
      return read(`.claude/skills/${skillName}/SKILL.md`);
    case "cursor":
      return read(`.cursor/rules/${skillName}.mdc`);
    // Every one of these is served by the vendor-neutral path and reads the same
    // bytes, so they measure identically. Zed and cline compile there directly;
    // copilot and gemini also read it, so their own skills directory is not
    // written when it is present (see VENDOR_NEUTRAL_ALIASES). Listed separately
    // rather than folded together, because a reader looking up "what does Zed
    // cost" must find a row.
    case "agents":
    case "zed":
    case "cline":
    case "copilot":
    case "gemini":
      return read(`.agents/skills/${skillName}/SKILL.md`);
    case "windsurf":
      return read(`.windsurf/rules/${skillName}.md`);
    case "aider":
    case "agentsmd": {
      const file = target === "aider" ? "CONVENTIONS.md" : "AGENTS.md";
      const m = read(file).match(new RegExp(`<!-- kitbash:begin ${skillName} -->[\\s\\S]*?<!-- kitbash:end ${skillName} -->`));
      return m ? m[0] : "";
    }
    default:
      return "";
  }
}

/** The standing stub an agent keeps in context for a lazy target. */
export function stubText(tmp, skillName) {
  const body = readFileSync(join(tmp, ".kitbash/skills", skillName, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "");
  return standingStub(body);
}

/**
 * Build the corpus in a temp repo with every target present so every adapter
 * fires, hand it to `fn`, and clean up. `fn` receives the workspace path.
 */
export function withBenchWorkspace(fn) {
  const tmp = mkdtempSync(join(tmpdir(), "kitbash-bench-"));
  try {
    for (const d of [".claude", ".cursor", ".agents", ".zed", ".clinerules", ".windsurf", ".github"]) mkdirSync(join(tmp, d));
    writeFileSync(join(tmp, "GEMINI.md"), "");
    writeFileSync(join(tmp, "CONVENTIONS.md"), "");

    run(["init"], tmp);

    // 1) A real manifested skill (budget 1500, lazy disclosure).
    run(["install", `file:${join(repoRoot, "examples/skills/prereview")}`], tmp);

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

    run(["compile"], tmp);
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
