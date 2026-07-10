/** Working v0.1 commands: init, install, remove, list, compile, doctor. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ADAPTERS, AGENTS_MD, mergeAgentsSection, readAgentsMd, type CompiledFile } from "./adapters.js";
import { estimateTokens, loadInstalledSkills, loadSkill, resolveBody, standingStub, NAME_RE, SKILLS_DIR } from "./ksf.js";

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
  console.log("next: kitbash install <gh:owner/repo | file:path>, then kitbash compile");
  return 0;
}

export async function cmdInstall(args: string[]): Promise<number> {
  const source = args[0];
  if (!source) {
    console.error("usage: kitbash install <gh:owner/repo[/path][@ref] | file:path>");
    return 1;
  }
  const root = process.cwd();
  let cleanup: string | undefined;
  try {
    let dir: string;
    if (source.startsWith("gh:")) {
      const m = source.slice(3).match(/^([^/@]+)\/([^/@]+)(?:\/([^@]+))?(?:@(.+))?$/);
      if (!m) {
        console.error(`invalid source: ${source} (expected gh:owner/repo[/path][@ref])`);
        return 1;
      }
      const [, owner, repo, subpath, ref] = m;
      cleanup = mkdtempSync(join(tmpdir(), "kitbash-"));
      const url = `https://github.com/${owner}/${repo}.git`;
      const cloneArgs = ref ? ["clone", "--quiet", url, cleanup] : ["clone", "--quiet", "--depth", "1", url, cleanup];
      execFileSync("git", cloneArgs, { stdio: ["ignore", "ignore", "inherit"] });
      if (ref) execFileSync("git", ["-C", cleanup, "checkout", "--quiet", ref], { stdio: ["ignore", "ignore", "inherit"] });
      dir = subpath ? join(cleanup, subpath) : cleanup;
    } else {
      dir = resolve(root, source.startsWith("file:") ? source.slice(5) : source);
    }

    const skill = loadSkill(dir);
    const { name, version, description } = skill.manifest.skill;
    const dest = join(root, SKILLS_DIR, name);
    if (existsSync(dest)) {
      console.error(`${name} is already installed — kitbash remove ${name} first (update lands in v0.2)`);
      return 1;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true });

    console.log(`installed ${name}@${version} — ${description}`);
    console.log(`  budget ${skill.manifest.context.budget} tokens · standing ${skill.manifest.context.standing} · mode ${skill.manifest.targets.mode}`);
    if (skill.manifest.permissions.tools.length) console.log(`  permissions: ${skill.manifest.permissions.tools.join(", ")}`);
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
  const dir = join(process.cwd(), SKILLS_DIR, name);
  if (!existsSync(dir)) {
    console.error(`${name} is not installed`);
    return 1;
  }
  rmSync(dir, { recursive: true });
  console.log(`removed ${name}`);
  console.log(`note: previously compiled outputs remain (e.g. .claude/skills/${name}/, .cursor/rules/${name}.mdc, AGENTS.md §${name}) — delete them or re-run kitbash compile after review`);
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
    console.log(`${m.skill.name}@${m.skill.version}  budget=${m.context.budget}  standing=${m.context.standing}  mode=${m.targets.mode}  — ${m.skill.description}`);
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
  return 0;
}

export async function cmdCompile(args: string[]): Promise<number> {
  const strict = args.includes("--strict");
  const root = process.cwd();
  const skills = loadInstalledSkills(root);
  if (!skills.length) {
    console.error("no skills installed — kitbash install <source> first");
    return 1;
  }

  const adapters = ADAPTERS.filter((a) => a.detect(root));
  const files = new Map<string, string>();
  const warnings: string[] = [];
  let agentsContent = readAgentsMd(root);

  for (const skill of skills) {
    const body = resolveBody(skill);
    const { name } = skill.manifest.skill;
    const { budget, standing } = skill.manifest.context;

    const bodyTokens = estimateTokens(body);
    if (bodyTokens > budget) {
      console.error(`✗ ${name}: compiled body is ~${bodyTokens} tokens, over its declared budget of ${budget}`);
      return 1;
    }
    const stubTokens = estimateTokens(standingStub(body));
    if (stubTokens > standing) {
      console.error(`✗ ${name}: standing stub is ~${stubTokens} tokens, over its declared standing limit of ${standing}`);
      return 1;
    }

    for (const adapter of adapters) {
      const out = adapter.emit(skill, body, root);
      warnings.push(...out.warnings);
      for (const f of out.files) {
        if (f.path === AGENTS_MD) {
          agentsContent = mergeAgentsSection(agentsContent, name, f.content);
          files.set(AGENTS_MD, agentsContent);
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
  for (const w of warnings) console.log(`⚠ ${w}`);
  console.log(`compiled ${skills.length} skill(s) for ${adapters.length} agent target(s)`);
  if (strict && warnings.length) {
    console.error(`--strict: failing on ${warnings.length} warning(s)`);
    return 1;
  }
  return 0;
}
