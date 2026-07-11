/** Working v0.1 commands: init, install, remove, list, compile, doctor. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
      dir = subpath ? join(cleanup, subpath) : cleanup;
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
  if (!skills.length) {
    console.error("no skills installed — kitbash install <source> first");
    return 1;
  }

  const adaptersOrError = configuredAdapters(root);
  if (typeof adaptersOrError === "string") {
    console.error(adaptersOrError);
    return 1;
  }
  const adapters = adaptersOrError;
  const installedNames = new Set(skills.map((s) => s.manifest.skill.name));

  const files = new Map<string, string>();
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
  for (const pruned of pruneStaleOutputs(root, new Set(files.keys()))) console.log(`✂ ${pruned}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  console.log(`compiled ${skills.length} skill(s) for ${adapters.length} agent target(s)`);
  if (strict && warnings.length) {
    console.error(`--strict: failing on ${warnings.length} warning(s)`);
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
