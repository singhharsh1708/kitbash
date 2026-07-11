/** Working v0.1 commands: init, install, remove, list, compile, doctor. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ADAPTERS, GENERATED_MARK, mergeSection, pruneSections, readFileIfExists, type CompiledFile } from "./adapters.js";
import { dropLock, integrityOf, readLock, upsertLock, LOCK_FILE } from "./lock.js";
import { estimateTokens, loadInstalledSkills, loadSkill, resolveBody, standingStub, NAME_RE, SKILLS_DIR, type LoadedSkill } from "./ksf.js";
import { parseToml } from "./toml.js";

const CONFIG = "kitbash.toml";

const INIT_CONFIG = `# kitbash project configuration — https://github.com/singhharsh1708/kitbash
[project]
# Adapters to compile for. Omit to autodetect (.claude/, .cursor/, AGENTS.md floor).
# targets = ["claude-code", "cursor", "agentsmd"]
`;

export async function cmdInit(): Promise<number> {
  const root = process.cwd();
  if (existsSync(join(root, CONFIG))) {
    console.log(`${CONFIG} already exists — nothing to do`);
    return 0;
  }
  writeFileSync(join(root, CONFIG), INIT_CONFIG);
  mkdirSync(join(root, SKILLS_DIR), { recursive: true });
  console.log(`created ${CONFIG} and ${SKILLS_DIR}/`);
  console.log("next: kitbash install <gh:owner/repo | owner/repo | file:path>, then kitbash compile");
  return 0;
}

/**
 * Confine an install subpath to the cloned repo. Returns the resolved absolute
 * path, or null if it escapes `base` (e.g. "../../etc") — a directory-traversal guard.
 */
export function resolveSubpath(base: string, subpath: string): string | null {
  const resolved = resolve(base, subpath);
  return resolved === base || resolved.startsWith(base + sep) ? resolved : null;
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Accepts gh:owner/repo[/path][@ref], bare owner/repo[/path][@ref], file:path, or a local path. */
function normalizeSource(source: string, root: string): { kind: "gh" | "local"; value: string } {
  if (source.startsWith("gh:")) return { kind: "gh", value: source.slice(3) };
  if (source.startsWith("file:")) return { kind: "local", value: resolve(root, source.slice(5)) };
  const local = resolve(root, source);
  if (existsSync(local)) return { kind: "local", value: local };
  if (/^[\w.-]+\/[\w.-]+/.test(source)) return { kind: "gh", value: source };
  return { kind: "local", value: local }; // will fail with a clear "missing SKILL.md" error
}

export async function cmdInstall(args: string[]): Promise<number> {
  const source = args[0];
  if (!source) {
    console.error("usage: kitbash install <gh:owner/repo[/path][@ref] | owner/repo | file:path>");
    return 1;
  }
  const root = process.cwd();
  const normalized = normalizeSource(source, root);
  let cleanup: string | undefined;
  try {
    let dir: string;
    if (normalized.kind === "gh") {
      const m = normalized.value.match(/^([^/@]+)\/([^/@]+)(?:\/([^@]+))?(?:@(.+))?$/);
      if (!m) {
        console.error(`invalid source "${source}".`);
        console.error("  expected: gh:owner/repo, owner/repo, owner/repo/path/to/skill, or owner/repo@ref");
        return 1;
      }
      if (!hasGit()) {
        console.error("git is required to install from GitHub but was not found on PATH.");
        console.error("  install git, or use a local source: kitbash install file:./path/to/skill");
        return 1;
      }
      const [, owner, repo, subpath, ref] = m;
      cleanup = mkdtempSync(join(tmpdir(), "kitbash-"));
      const url = `https://github.com/${owner}/${repo}.git`;
      const cloneArgs = ref ? ["clone", "--quiet", url, cleanup] : ["clone", "--quiet", "--depth", "1", url, cleanup];
      try {
        execFileSync("git", cloneArgs, { stdio: ["ignore", "ignore", "pipe"] });
      } catch {
        console.error(`could not clone https://github.com/${owner}/${repo}.`);
        console.error("  check the repo exists and is public, the name is spelled right, and you're online.");
        return 1;
      }
      if (ref) {
        try {
          execFileSync("git", ["-C", cleanup, "checkout", "--quiet", ref], { stdio: ["ignore", "ignore", "pipe"] });
        } catch {
          console.error(`ref "${ref}" not found in ${owner}/${repo} (not a branch, tag, or commit).`);
          return 1;
        }
      }
      if (subpath) {
        const resolved = resolveSubpath(cleanup, subpath);
        if (!resolved) {
          console.error(`invalid subpath "${subpath}": it escapes the repository.`);
          console.error("  use a path inside the repo, e.g. owner/repo/skills/my-skill.");
          return 1;
        }
        dir = resolved;
      } else {
        dir = cleanup;
      }
      if (subpath && !existsSync(dir)) {
        console.error(`path "${subpath}" not found in ${owner}/${repo}.`);
        console.error("  point at the folder that contains skill.toml (or SKILL.md).");
        return 1;
      }
    } else {
      dir = normalized.value;
      if (!existsSync(dir)) {
        console.error(`local path not found: ${dir}`);
        return 1;
      }
    }

    const skill = loadSkill(dir);
    const { name, version, description } = skill.manifest.skill;
    const dest = join(root, SKILLS_DIR, name);
    if (existsSync(dest)) {
      console.error(`${name} is already installed. To reinstall: kitbash remove ${name} && kitbash install ${source}`);
      return 1;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true });
    upsertLock(root, { name, version, source, integrity: integrityOf(dest) });

    console.log(`installed ${name}@${version} — ${description}`);
    console.log(`  budget ${skill.manifest.context.budget} tokens · standing ${skill.manifest.context.standing} · mode ${skill.manifest.targets.mode}`);
    if (skill.manifest.permissions.tools.length) console.log(`  permissions: ${skill.manifest.permissions.tools.join(", ")}`);
    if (skill.bare) console.log(`  ⚠ unmanifested (SKILL.md only) — defaults applied, no permissions or budget declared by the author`);
    console.log(`  pinned in ${LOCK_FILE}`);
    console.log("next: kitbash compile");
    return 0;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

export async function cmdRemove(args: string[]): Promise<number> {
  const name = args[0];
  if (!name || !NAME_RE.test(name)) {
    console.error("usage: kitbash remove <skill-name>");
    return 1;
  }
  const root = process.cwd();
  const dir = join(root, SKILLS_DIR, name);
  if (!existsSync(dir)) {
    const installed = loadInstalledSkills(root).map((s) => s.manifest.skill.name);
    console.error(`${name} is not installed.`);
    console.error(installed.length ? `  installed: ${installed.join(", ")}` : "  no skills installed yet.");
    return 1;
  }
  rmSync(dir, { recursive: true });
  dropLock(root, name);
  console.log(`removed ${name}`);
  console.log("next: kitbash compile (prunes this skill's generated outputs)");
  return 0;
}

export async function cmdList(): Promise<number> {
  const skills = loadInstalledSkills(process.cwd());
  if (!skills.length) {
    console.log("no skills installed — kitbash install <source>");
    return 0;
  }
  for (const s of skills) {
    const m = s.manifest;
    const bare = s.bare ? "  [unmanifested]" : "";
    console.log(`${m.skill.name}@${m.skill.version}  budget=${m.context.budget}  standing=${m.context.standing}  mode=${m.targets.mode}${bare}  — ${m.skill.description}`);
  }
  return 0;
}

export async function cmdDoctor(): Promise<number> {
  const root = process.cwd();
  console.log("detected targets:");
  for (const a of ADAPTERS) {
    const found = a.detect(root);
    const note = a.id === "agentsmd" ? " (floor: Codex, Gemini CLI, anything reading AGENTS.md)" : "";
    console.log(`  ${found ? "✓" : "✗"} ${a.id}${note}`);
  }

  const skills = loadInstalledSkills(root);
  const standing = skills.reduce((sum, s) => sum + estimateTokens(standingStub(s.body)), 0);
  const active = skills.reduce((sum, s) => sum + s.manifest.context.budget, 0);
  console.log(`installed skills: ${skills.length}`);
  console.log(`standing context cost: ~${standing} tokens (stubs); worst-case active: ${active} tokens (budgets)`);

  let drift = 0;
  for (const entry of readLock(root)) {
    const dir = join(root, SKILLS_DIR, entry.name);
    if (!existsSync(dir)) {
      console.log(`  ⚠ ${entry.name}: in ${LOCK_FILE} but not installed`);
      continue;
    }
    if (integrityOf(dir) !== entry.integrity) {
      console.error(`  ✗ ${entry.name}: integrity drift — installed files differ from ${LOCK_FILE}`);
      drift++;
    }
  }
  if (drift) {
    console.error(`${drift} skill(s) drifted from their lock — reinstall or investigate`);
    return 1;
  }
  console.log("lock integrity: ok");
  return 0;
}

function configuredAdapters(root: string): typeof ADAPTERS | string {
  const p = join(root, CONFIG);
  if (!existsSync(p)) return ADAPTERS.filter((a) => a.detect(root));
  const raw = parseToml(readFileSync(p, "utf8"));
  const project = raw["project"];
  const targets =
    project && typeof project === "object" && !Array.isArray(project) && Array.isArray(project["targets"])
      ? (project["targets"] as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined;
  if (!targets) return ADAPTERS.filter((a) => a.detect(root));
  const unknown = targets.filter((t) => !ADAPTERS.some((a) => a.id === t));
  if (unknown.length) return `unknown target(s) in ${CONFIG}: ${unknown.join(", ")} (known: ${ADAPTERS.map((a) => a.id).join(", ")})`;
  return ADAPTERS.filter((a) => targets.includes(a.id));
}

export async function cmdCompile(args: string[]): Promise<number> {
  const strict = args.includes("--strict");
  const root = process.cwd();
  const skills = loadInstalledSkills(root);

  const adaptersOrError = configuredAdapters(root);
  if (typeof adaptersOrError === "string") {
    console.error(adaptersOrError);
    return 1;
  }
  const adapters = adaptersOrError;
  const installedNames = new Set(skills.map((s) => s.manifest.skill.name));

  const files = new Map<string, string>();
  const owners = new Map<string, string>(); // non-merge path → skill that wrote it, for conflict detection
  const warnings: string[] = [];
  // shared marker-merged files (AGENTS.md, GEMINI.md): start from pruned on-disk content
  const mergedFiles = new Map<string, string>();

  for (const skill of skills) {
    const body = resolveBody(skill);
    const { name } = skill.manifest.skill;
    if (skill.bare) warnings.push(`${name}: unmanifested (SKILL.md only) — defaults applied, no permissions declared`);
    const over = budgetViolations(skill, body);
    if (over.length && !skill.bare) {
      for (const v of over) console.error(`✗ ${v}`);
      return 1;
    }
    warnings.push(...over); // bare skills: report, don't fail — the author never declared these limits

    for (const adapter of adapters) {
      const out = adapter.emit(skill, body, root);
      warnings.push(...out.warnings);
      for (const f of out.files) {
        if (f.merge) {
          const current = mergedFiles.get(f.path) ?? pruneSections(readFileIfExists(root, f.path), installedNames);
          const merged = mergeSection(current, name, f.content);
          mergedFiles.set(f.path, merged);
          files.set(f.path, merged);
        } else {
          const prev = owners.get(f.path);
          if (prev && prev !== name) {
            warnings.push(`conflict: "${prev}" and "${name}" both write ${f.path} — "${name}" wins. Rename the clashing trigger command or skill.`);
          }
          owners.set(f.path, name);
          files.set(f.path, f.content);
        }
      }
    }
  }

  const written: CompiledFile[] = [...files.entries()].map(([path, content]) => ({ path, content }));
  for (const f of written) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content.endsWith("\n") ? f.content : `${f.content}\n`);
    console.log(`→ ${f.path}`);
  }
  // Shared marker files not rewritten this compile still need stale sections pruned —
  // e.g. after removing the last skill that wrote to them, no adapter emits to rebuild them.
  for (const rel of MANAGED_SHARED_FILES) {
    if (files.has(rel) || !existsSync(join(root, rel))) continue;
    const before = readFileSync(join(root, rel), "utf8");
    const after = pruneSections(before, installedNames);
    if (after !== before) {
      writeFileSync(join(root, rel), after.endsWith("\n") ? after : `${after}\n`);
      console.log(`✂ pruned stale section(s) from ${rel}`);
    }
  }
  for (const pruned of pruneStaleOutputs(root, new Set(files.keys()))) console.log(`✂ ${pruned}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  if (!skills.length) {
    console.log("no skills installed — kitbash install <source> to add one");
    return 0;
  }
  console.log(`compiled ${skills.length} skill(s) for ${adapters.length} agent target(s)`);
  if (strict && warnings.length) {
    console.error(`--strict: failing on ${warnings.length} warning(s)`);
    return 1;
  }
  return 0;
}

/** Static-tier evals (SPEC §6): schema, dead refs, budgets, artifact/trigger shape, injection heuristics.
 *  No eval file required — these always run. Audit/behavioral tiers need a runner (not in v0.3). */
type Check = { name: string; ok: boolean; warn?: boolean; detail?: string };

const ARTIFACT_RE = /^[a-z][a-z0-9-]*@\d+$/;
// Prompt-injection heuristics. Deliberately narrow — these warn, they never silently pass or hard-fail,
// since a security-focused skill may legitimately quote the very phrases it defends against.
const INJECTION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /ignore\s+(?:all\s+)?(?:your\s+)?(?:previous|prior|above)\s+instructions/i, label: "override of prior instructions" },
  { re: /disregard\s+(?:the\s+)?(?:above|previous|prior|system)/i, label: "disregard-directive" },
  { re: /you\s+are\s+now\s+(?:a|an|the)\b/i, label: "role reassignment" },
  { re: /do\s+not\s+(?:tell|inform|reveal\s+to)\s+the\s+user/i, label: "conceal-from-user" },
  { re: /exfiltrat|curl\s+[^|]*\|\s*(?:sh|bash)|send\s+.*\s+to\s+https?:\/\//i, label: "data-exfiltration shape" },
];

function staticChecks(skill: LoadedSkill): Check[] {
  const checks: Check[] = [];
  const m = skill.manifest;

  checks.push({ name: "manifest", ok: true, warn: skill.bare, detail: skill.bare ? "unmanifested (SKILL.md only) — defaults applied" : `${m.skill.name}@${m.skill.version}` });

  // templates / dead references
  let body: string | undefined;
  try {
    body = resolveBody(skill);
    checks.push({ name: "references", ok: true });
  } catch (e) {
    checks.push({ name: "references", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // budgets — the measured claim
  if (body !== undefined) {
    const bodyTokens = estimateTokens(body);
    const stubTokens = estimateTokens(standingStub(body));
    const overBudget = bodyTokens > m.context.budget;
    const overStanding = stubTokens > m.context.standing;
    // bare skills never declared these limits — measure and warn, don't fail
    checks.push({
      name: "budget",
      ok: !overBudget || skill.bare,
      warn: overBudget && skill.bare,
      detail: `body ~${bodyTokens} tok / budget ${m.context.budget}`,
    });
    checks.push({
      name: "standing",
      ok: !overStanding || skill.bare,
      warn: overStanding && skill.bare,
      detail: `stub ~${stubTokens} tok / limit ${m.context.standing}`,
    });
  }

  // artifact refs must be name@version
  const badArtifacts = [...m.artifacts.produces, ...m.artifacts.consumes].filter((a) => !ARTIFACT_RE.test(a));
  if (m.artifacts.produces.length || m.artifacts.consumes.length) {
    checks.push({ name: "artifacts", ok: badArtifacts.length === 0, detail: badArtifacts.length ? `malformed: ${badArtifacts.join(", ")} (want name@version)` : `produces ${m.artifacts.produces.length}, consumes ${m.artifacts.consumes.length}` });
  }

  // command triggers must be slash-prefixed
  const badCommands = m.triggers.commands.filter((c) => !c.startsWith("/"));
  if (badCommands.length) checks.push({ name: "triggers", ok: false, detail: `commands must start with '/': ${badCommands.join(", ")}` });

  // injection heuristics (warn only)
  if (body !== undefined) {
    const hits = INJECTION_PATTERNS.filter((p) => p.re.test(body!)).map((p) => p.label);
    if (hits.length) checks.push({ name: "injection", ok: true, warn: true, detail: `heuristic match — review: ${hits.join(", ")}` });
  }

  return checks;
}

export async function cmdTest(args: string[]): Promise<number> {
  const strict = args.includes("--strict");
  const only = args.find((a) => !a.startsWith("-"));
  const root = process.cwd();
  let skills = loadInstalledSkills(root);
  if (only) {
    skills = skills.filter((s) => s.manifest.skill.name === only);
    if (!skills.length) {
      console.error(`${only} is not installed.`);
      return 1;
    }
  }
  if (!skills.length) {
    console.error("no skills installed — kitbash install <source> first");
    return 1;
  }

  let failed = 0;
  let warned = 0;
  for (const skill of skills) {
    const checks = staticChecks(skill);
    const bad = checks.filter((c) => !c.ok);
    const warns = checks.filter((c) => c.ok && c.warn);
    failed += bad.length;
    warned += warns.length;
    const mark = bad.length ? "✗" : warns.length ? "⚠" : "✓";
    console.log(`${mark} ${skill.manifest.skill.name}`);
    for (const c of checks) {
      const sym = !c.ok ? "✗" : c.warn ? "⚠" : "·";
      console.log(`    ${sym} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
  }

  console.log(`\ntested ${skills.length} skill(s) · ${failed} failure(s) · ${warned} warning(s) (static tier)`);
  if (skills.some((s) => existsSync(join(root, SKILLS_DIR, s.manifest.skill.name, "evals")))) {
    console.log("note: evals/ present — audit & behavioral tiers need a runner (not in this build); static tier ran");
  }
  if (failed) return 1;
  if (strict && warned) {
    console.error(`--strict: failing on ${warned} warning(s)`);
    return 1;
  }
  return 0;
}

function budgetViolations(skill: LoadedSkill, body: string): string[] {
  const { name } = skill.manifest.skill;
  const { budget, standing } = skill.manifest.context;
  const out: string[] = [];
  const bodyTokens = estimateTokens(body);
  if (bodyTokens > budget) out.push(`${name}: compiled body is ~${bodyTokens} tokens, over its budget of ${budget}`);
  const stubTokens = estimateTokens(standingStub(body));
  if (stubTokens > standing) out.push(`${name}: standing stub is ~${stubTokens} tokens, over its standing limit of ${standing}`);
  return out;
}

/**
 * Managed output locations scanned for stale generated files. A file here is
 * deleted only if it bears the generated header AND was not written by the
 * current compile — covers removed skills and renamed commands alike.
 */
/** Shared marker-merged files whose stale sections are pruned even when no adapter rewrites them. */
const MANAGED_SHARED_FILES = ["AGENTS.md", "GEMINI.md"];

const MANAGED_DIRS: { dir: string; suffix: string; wholeDir?: boolean }[] = [
  { dir: ".claude/skills", suffix: "/SKILL.md", wholeDir: true },
  { dir: ".claude/commands", suffix: ".md" },
  { dir: ".cursor/rules", suffix: ".mdc" },
  { dir: ".clinerules", suffix: ".md" },
  { dir: ".windsurf/rules", suffix: ".md" },
  { dir: ".github/instructions", suffix: ".instructions.md" },
];

function pruneStaleOutputs(root: string, written: Set<string>): string[] {
  const pruned: string[] = [];
  for (const loc of MANAGED_DIRS) {
    const base = join(root, loc.dir);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      let rel: string;
      let removeTarget: string;
      if (loc.wholeDir) {
        if (!e.isDirectory()) continue;
        rel = `${loc.dir}/${e.name}${loc.suffix}`;
        removeTarget = join(base, e.name);
      } else {
        if (!e.isFile() || !e.name.endsWith(loc.suffix)) continue;
        rel = `${loc.dir}/${e.name}`;
        removeTarget = join(base, e.name);
      }
      if (written.has(rel)) continue;
      const marker = join(root, rel);
      if (existsSync(marker) && readFileSync(marker, "utf8").includes(GENERATED_MARK)) {
        rmSync(removeTarget, { recursive: true });
        pruned.push(`removed ${loc.wholeDir ? `${loc.dir}/${e.name}/` : rel} (stale)`);
      }
    }
  }
  return pruned;
}
