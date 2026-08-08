/**
 * Reverse compile: read the agent instruction/rule files a repo ALREADY has —
 * the copy-per-agent mess — so `kitbash import` can turn them into one KSF source
 * and show where they have drifted apart. This is the inverse of the adapters:
 * adapters WRITE a format; here we READ the common ones back.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_MARK, pruneSections } from "./adapters.js";
import { estimateTokens } from "./ksf.js";

/** One imported instruction source found in a repo. */
export interface ImportedSource {
  agent: string; // the coding agent this file feeds
  file: string; // repo-relative path
  body: string; // human-authored instruction text (frontmatter + kitbash sections stripped)
  tokens: number; // estimated standing cost of that body
  loading: "eager" | "lazy";
}

/** Known hand-authored instruction files, by exact path. */
const FILE_SOURCES: { path: string; agent: string; loading: "eager" | "lazy" }[] = [
  { path: "CLAUDE.md", agent: "claude-code", loading: "eager" },
  { path: "AGENTS.md", agent: "agentsmd", loading: "eager" },
  { path: "GEMINI.md", agent: "gemini", loading: "eager" },
  { path: "CONVENTIONS.md", agent: "aider", loading: "eager" },
  { path: ".cursorrules", agent: "cursor", loading: "eager" },
  { path: ".windsurfrules", agent: "windsurf", loading: "eager" },
  { path: ".clinerules", agent: "cline", loading: "eager" }, // may also be a directory (handled below)
  { path: ".github/copilot-instructions.md", agent: "copilot", loading: "eager" },
];

/** Known rule directories whose *.md/*.mdc files are each an instruction source. */
const DIR_SOURCES: { dir: string; ext: string; agent: string; loading: "eager" | "lazy" }[] = [
  { dir: ".cursor/rules", ext: ".mdc", agent: "cursor", loading: "lazy" },
  { dir: ".github/instructions", ext: ".instructions.md", agent: "copilot", loading: "eager" },
  { dir: ".clinerules", ext: ".md", agent: "cline", loading: "eager" },
  { dir: ".windsurf/rules", ext: ".md", agent: "windsurf", loading: "lazy" },
  { dir: ".devin/rules", ext: ".md", agent: "windsurf", loading: "lazy" },
];

/**
 * Strip a file down to its human-authored instruction text: drop leading YAML
 * frontmatter, remove any kitbash-generated marker sections and header comment,
 * and trim. Returns "" for a file that is entirely kitbash output (nothing to import).
 */
export function stripToBody(raw: string): string {
  let s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // BOM
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // leading frontmatter
  s = pruneSections(s, new Set()); // remove all <!-- kitbash:begin/end --> sections
  s = s
    .split(/\r?\n/)
    .filter((line) => !line.includes(GENERATED_MARK)) // drop generated-header comments
    .join("\n");
  return s.trim();
}

function readSource(root: string, rel: string, agent: string, loading: "eager" | "lazy"): ImportedSource | null {
  const body = stripToBody(readFileSync(join(root, rel), "utf8"));
  if (!body) return null; // empty or purely kitbash-generated — not a real existing config
  return { agent, file: rel, body, tokens: estimateTokens(body), loading };
}

/** Every hand-authored agent instruction source present in the repo. */
export function collectImports(root: string): ImportedSource[] {
  const out: ImportedSource[] = [];
  const seen = new Set<string>();

  for (const s of FILE_SOURCES) {
    const abs = join(root, s.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue; // .clinerules may be a dir
    const src = readSource(root, s.path, s.agent, s.loading);
    if (src) {
      out.push(src);
      seen.add(s.path);
    }
  }

  for (const d of DIR_SOURCES) {
    const abs = join(root, d.dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith(d.ext)) continue;
      const rel = `${d.dir}/${name}`;
      if (seen.has(rel)) continue;
      const src = readSource(root, rel, d.agent, d.loading);
      if (src) {
        out.push(src);
        seen.add(rel);
      }
    }
  }
  return out;
}

/** A set of sources sharing byte-identical instruction text (after whitespace normalization). */
export interface DriftGroup {
  body: string;
  files: string[];
}

/** Normalize for drift comparison: collapse runs of whitespace, trim each line. */
function normalize(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Group sources by whether they carry the same rules. One group means every agent
 * agrees; more than one means the copies have drifted apart — the pain to surface.
 */
export function driftGroups(sources: ImportedSource[]): DriftGroup[] {
  const groups = new Map<string, DriftGroup>();
  for (const s of sources) {
    const key = normalize(s.body);
    const g = groups.get(key);
    if (g) g.files.push(s.file);
    else groups.set(key, { body: s.body, files: [s.file] });
  }
  // Largest group first (the de-facto canonical version), then by first file for determinism.
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length || (a.files[0]! < b.files[0]! ? -1 : 1));
}
