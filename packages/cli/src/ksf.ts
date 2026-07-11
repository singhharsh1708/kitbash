/** KSF skill loading, validation, and template resolution. Spec: spec/SPEC.md */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseToml, type TomlTable } from "./toml.js";

export interface SkillManifest {
  skill: {
    name: string;
    version: string;
    description: string;
    license?: string;
    homepage?: string;
  };
  context: { budget: number; standing: number; disclosure: "lazy" | "eager" };
  triggers: { commands: string[]; auto: string[]; events: string[] };
  permissions: { tools: string[]; network: boolean; write: boolean };
  artifacts: { produces: string[]; consumes: string[] };
  targets: { requires: string[]; mode: "skill" | "gate" };
  lore: { reads: string[]; writes: string[] };
  dependencies: Record<string, string>;
}

export interface LoadedSkill {
  dir: string;
  manifest: SkillManifest;
  body: string;
  /** true for SKILL.md-only skills (skills.sh / Claude convention) with a synthesized manifest */
  bare: boolean;
}

export const SKILLS_DIR = ".kitbash/skills";
export const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Read a UTF-8 file, stripping a leading BOM — editors on Windows add one and it breaks `^---` / `^[table]` matching. */
function readText(path: string): string {
  const s = readFileSync(path, "utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Rough estimate (~4 chars/token). Good enough for budget enforcement; lint owns precision. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function standingStub(body: string): string {
  return (body.split(/\n\s*\n/)[0] ?? "").trim();
}

export function loadSkill(dir: string): LoadedSkill {
  const manifestPath = join(dir, "skill.toml");
  const bodyPath = join(dir, "SKILL.md");
  if (!existsSync(bodyPath)) {
    throw new Error(`no skill found at ${dir}\n  a skill is a folder with SKILL.md (and optionally skill.toml). Point the source at that folder.`);
  }
  if (!existsSync(manifestPath)) return loadBareSkill(dir, bodyPath);

  const raw = parseToml(readText(manifestPath));
  const manifest = validate(raw, manifestPath);
  const body = readText(bodyPath);
  return { dir, manifest, body, bare: false };
}

/**
 * Interop: a SKILL.md-only folder (the skills.sh / Claude Skills convention)
 * is valid KSF-minus-manifest. Synthesize permissive defaults and flag it —
 * the caller surfaces "unmanifested" warnings at install and compile.
 */
function loadBareSkill(dir: string, bodyPath: string): LoadedSkill {
  const raw = readText(bodyPath);
  const fm = parseFrontmatter(raw);
  const body = raw.replace(FRONTMATTER_RE, "").trimStart();

  const fallback = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 40);
  const name = fm["name"] && NAME_RE.test(fm["name"]) ? fm["name"] : fallback;
  if (!NAME_RE.test(name)) throw new Error(`${dir}: cannot derive a valid skill name (got "${name}")`);

  return {
    dir,
    bare: true,
    body,
    manifest: {
      skill: { name, version: "0.0.0", description: fm["description"] ?? "Imported skill (no manifest)" },
      context: { budget: 6000, standing: 250, disclosure: "lazy" },
      triggers: { commands: [], auto: [], events: [] },
      permissions: { tools: [], network: false, write: false },
      artifacts: { produces: [], consumes: [] },
      targets: { requires: [], mode: "skill" },
      lore: { reads: [], writes: [] },
      dependencies: {},
    },
  };
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(FRONTMATTER_RE);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[0].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.+?)\s*$/);
    if (kv) out[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadInstalledSkills(root: string): LoadedSkill[] {
  const base = join(root, SKILLS_DIR);
  if (!existsSync(base)) return [];
  // Only load directories that actually contain a skill — skip aborted installs,
  // backups, or stray folders (.git, empty dirs) instead of crashing every command.
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, "SKILL.md")))
    .map((e) => loadSkill(join(base, e.name)))
    .sort((a, b) => a.manifest.skill.name.localeCompare(b.manifest.skill.name));
}

/**
 * Resolve {{...}} template variables for compilation.
 * artifact.* and lore.* compile to path references the agent follows at
 * invocation time; prompt.* inlines prompts/<name>.md from the skill dir.
 */
export function resolveBody(skill: LoadedSkill): string {
  return skill.body.replace(/\{\{\s*([a-z]+)\.([a-z0-9-]+)\s*\}\}/g, (whole, ns: string, name: string) => {
    switch (ns) {
      case "artifact":
        return `\`.kitbash/artifacts/${name}.json\``;
      case "lore":
        return `the project knowledge under \`.kitbash/lore/${name}/\` (skip silently if absent)`;
      case "prompt": {
        const p = join(skill.dir, "prompts", `${name}.md`);
        if (!existsSync(p)) throw new Error(`${skill.manifest.skill.name}: template references missing ${p}`);
        return readFileSync(p, "utf8").trim();
      }
      default:
        throw new Error(`${skill.manifest.skill.name}: unknown template variable ${whole}`);
    }
  });
}

const KNOWN_TABLES = ["skill", "context", "triggers", "permissions", "artifacts", "targets", "lore", "dependencies"];
const EVENTS_ENUM = ["pre-push", "pre-commit", "ci", "pr-open"];
const REQUIRES_ENUM = ["scripts", "hooks", "subagents", "network"];
const LORE_ENUM = ["decisions", "conventions", "invariants", "map"];

/**
 * Schema-conformance lints (spec/schema/skill.schema.json) surfaced as warnings by `kitbash test`.
 * Per RFC 0002 these warn rather than fail: unknown tables and unrecognized enum values stay
 * forward-compatible (a newer skill on an older compiler shouldn't hard-error).
 */
export function schemaLints(dir: string): string[] {
  const p = join(dir, "skill.toml");
  if (!existsSync(p)) return [];
  let raw: TomlTable;
  try {
    raw = parseToml(readText(p));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const k of Object.keys(raw)) if (!KNOWN_TABLES.includes(k)) out.push(`unknown table [${k}] — typo or unsupported, ignored`);
  const enumCheck = (tbl: string, key: string, allowed: string[]) => {
    for (const v of strs(table(raw, tbl), key)) if (!allowed.includes(v)) out.push(`${tbl}.${key} "${v}" is not one of ${allowed.join(", ")}`);
  };
  enumCheck("triggers", "events", EVENTS_ENUM);
  enumCheck("targets", "requires", REQUIRES_ENUM);
  enumCheck("lore", "reads", LORE_ENUM);
  enumCheck("lore", "writes", LORE_ENUM);
  return out;
}

function validate(raw: TomlTable, source: string): SkillManifest {
  const errors: string[] = [];
  const skill = table(raw, "skill");
  const context = table(raw, "context");

  const name = str(skill, "name") ?? "";
  const version = str(skill, "version") ?? "";
  const description = str(skill, "description") ?? "";
  const budget = num(context, "budget");
  const standing = num(context, "standing");

  // Bounds mirror spec/schema/skill.schema.json — value constraints on frozen fields.
  if (!NAME_RE.test(name)) errors.push(`skill.name "${name}" must match ${NAME_RE}`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) errors.push(`skill.version "${version}" is not semver`);
  if (description.length < 10 || description.length > 200) errors.push("skill.description must be 10–200 characters");
  if (budget === undefined || budget < 50 || budget > 20000) errors.push("context.budget is required and must be 50–20000");
  if (standing !== undefined && (standing < 0 || standing > 500)) errors.push("context.standing must be 0–500");

  if (errors.length) throw new Error(`${source}: invalid manifest\n  - ${errors.join("\n  - ")}`);

  const t = (k: string): TomlTable => table(raw, k);
  return {
    skill: { name, version, description, ...opt("license", str(skill, "license")), ...opt("homepage", str(skill, "homepage")) },
    context: {
      budget: budget!,
      standing: standing ?? 100,
      disclosure: str(context, "disclosure") === "eager" ? "eager" : "lazy",
    },
    triggers: { commands: strs(t("triggers"), "commands"), auto: strs(t("triggers"), "auto"), events: strs(t("triggers"), "events") },
    permissions: {
      tools: strs(t("permissions"), "tools"),
      network: bool(t("permissions"), "network") ?? false,
      write: bool(t("permissions"), "write") ?? false,
    },
    artifacts: { produces: strs(t("artifacts"), "produces"), consumes: strs(t("artifacts"), "consumes") },
    targets: { requires: strs(t("targets"), "requires"), mode: str(t("targets"), "mode") === "gate" ? "gate" : "skill" },
    lore: { reads: strs(t("lore"), "reads"), writes: strs(t("lore"), "writes") },
    dependencies: deps(raw),
  };
}

function opt<T>(key: string, v: T | undefined): Record<string, T> {
  return v === undefined ? {} : ({ [key]: v } as Record<string, T>);
}

function table(raw: TomlTable, key: string): TomlTable {
  const v = raw[key];
  return v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function str(t: TomlTable, key: string): string | undefined {
  return typeof t[key] === "string" ? (t[key] as string) : undefined;
}

function num(t: TomlTable, key: string): number | undefined {
  return typeof t[key] === "number" ? (t[key] as number) : undefined;
}

function bool(t: TomlTable, key: string): boolean | undefined {
  return typeof t[key] === "boolean" ? (t[key] as boolean) : undefined;
}

function strs(t: TomlTable, key: string): string[] {
  const v = t[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function deps(raw: TomlTable): Record<string, string> {
  const t = table(raw, "dependencies");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (typeof v === "string") out[k] = v;
  return out;
}
