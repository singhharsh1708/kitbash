/** Working v0.1 commands: init, install, remove, list, compile, doctor. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ADAPTERS, GENERATED_MARK, mergeSection, pruneSections, readFileIfExists, type CompiledFile } from "./adapters.js";
import { dropLock, integrityOf, readLock, upsertLock, walk, LOCK_FILE } from "./lock.js";
import { fileChanges, manifestDelta, textOf, unifiedDiff } from "./diff.js";
import { collectImports, driftGroups, type ImportedSource } from "./importers.js";
import { estimateTokens, loadInstalledSkills, loadInstalledSkillsSafe, loadSkill, resolveBody, schemaLints, standingStub, COMMAND_RE, NAME_RE, SKILLS_DIR, type LoadedSkill } from "./ksf.js";
import { parseToml } from "./toml.js";

const CONFIG = "kitbash.toml";

/**
 * Lints that block install unconditionally (not just `lint`/`test`): they flag
 * instructions a reviewer cannot see or code that runs on install. Everything
 * else staticChecks reports — schema, budgets, dead refs — is quality, surfaced
 * at `kitbash test`, and never stops an install.
 */
const SAFETY_LINTS = new Set(["visible-text", "dynamic-context", "remote-exec", "secrets"]);

const INIT_CONFIG = `# kitbash project configuration — https://github.com/singhharsh1708/kitbash
[project]
# Adapters to compile for. Omit to autodetect (.claude/, .cursor/, AGENTS.md floor).
# targets = ["claude-code", "cursor", "agentsmd"]

# Install policy (org allowlist). Enforced at install and rechecked by doctor.
# [policy]
# allow_sources = ["gh:your-org/*"]  # globs; matched against gh:owner/repo[/path][@ref] or file:/abs/path
# deny_network = true                # refuse skills declaring network permission
# deny_write = true                  # refuse skills declaring write permission
# max_budget = 6000                  # refuse skills with a larger context budget
# deny_remote_exec = false           # opt OUT of the download-and-execute body lint (default: on)
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
 * Reverse compile: read the agent instruction/rule files a repo already has,
 * measure what each costs, show where they have drifted apart, and synthesize a
 * single KSF skill so `kitbash compile` can regenerate them all from one source.
 * This is the on-ramp for a repo already carrying the copy-per-agent mess.
 */
export async function cmdImport(args: string[]): Promise<number> {
  const root = process.cwd();
  const write = args.includes("--write");
  const nameArg = flagValue(args, "--name");

  const sources = collectImports(root);
  if (!sources.length) {
    console.log("no existing agent instruction files found (CLAUDE.md, AGENTS.md, .cursor/rules/, .clinerules, …).");
    console.log("  nothing to import — author a skill instead: kitbash init && kitbash install <source>");
    return 0;
  }

  console.log(`found ${plural(sources.length, "agent config file")}:`);
  for (const s of sources) {
    console.log(`  ${s.file}  → ${s.agent}  (~${s.tokens} tok, ${s.loading})`);
  }
  const eager = sources.filter((s) => s.loading === "eager").reduce((sum, s) => sum + s.tokens, 0);
  console.log(`standing cost of the always-on files: ~${eager} tokens every session`);

  // Drift is the hook: do the copies actually say the same thing?
  const groups = driftGroups(sources);
  if (groups.length === 1) {
    console.log(`\n✓ all ${sources.length} carry the same rules — no drift.`);
  } else {
    console.log(`\n⚠ these ${sources.length} files have drifted into ${groups.length} different versions:`);
    groups.forEach((g, i) => console.log(`  version ${i + 1}: ${g.files.join(", ")}`));
    console.log("  the canonical version below is the one the most agents agree on.");
  }

  // Synthesize one skill from the de-facto canonical body (largest drift group).
  const canonical = groups[0]!;
  const name = deriveImportName(nameArg, root);
  if (!NAME_RE.test(name)) {
    console.error(`invalid skill name "${name}" — use --name <a-z, digits, hyphens, 2–41 chars>`);
    return 1;
  }
  const bodyTokens = estimateTokens(canonical.body);
  const budget = Math.min(20000, Math.max(500, Math.ceil((bodyTokens * 1.2) / 100) * 100));
  const desc = `Imported from ${sources.length} existing agent config file${sources.length === 1 ? "" : "s"} (${sources.map((s) => s.agent).filter((a, i, arr) => arr.indexOf(a) === i).slice(0, 4).join(", ")})`;
  const manifest = [
    `[skill]`,
    `name = "${name}"`,
    `version = "0.1.0"`,
    `description = ${JSON.stringify(desc.slice(0, 200))}`,
    ``,
    `[context]`,
    `budget = ${budget}`,
    `standing = 100`,
    `disclosure = "lazy"`,
    ``,
  ].join("\n");
  const skillMd = groups.length > 1
    ? `<!-- imported by kitbash from drifted sources; this is the version most agents agreed on. Review before compiling. -->\n\n${canonical.body}\n`
    : `${canonical.body}\n`;

  if (!write) {
    console.log(`\n— proposed skill "${name}" (budget ${budget}) —\n`);
    console.log(manifest);
    console.log(`# SKILL.md (${bodyTokens} tok, first lines):`);
    console.log(canonical.body.split("\n").slice(0, 8).join("\n"));
    console.log(`\nre-run with --write to save it to ${SKILLS_DIR}/${name}/, then: kitbash compile`);
    return 0;
  }

  const dest = join(root, SKILLS_DIR, name);
  if (existsSync(dest)) {
    console.error(`${SKILLS_DIR}/${name}/ already exists — pass --name <other> or remove it first.`);
    return 1;
  }
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "skill.toml"), manifest);
  writeFileSync(join(dest, "SKILL.md"), skillMd);
  if (!existsSync(join(root, CONFIG))) writeFileSync(join(root, CONFIG), INIT_CONFIG);
  upsertLock(root, { name, version: "0.1.0", source: "import:local", integrity: integrityOf(dest) });
  console.log(`\nwrote ${SKILLS_DIR}/${name}/ (skill.toml + SKILL.md), pinned in ${LOCK_FILE}`);
  console.log(`next: kitbash preview ${name}   (see it per agent + the token cost)`);
  console.log(`then: kitbash compile           (regenerate every target from this one source — ends the drift)`);
  return 0;
}

/** Derive a valid skill name from --name or the repo directory. */
function deriveImportName(nameArg: string | undefined, root: string): string {
  if (nameArg) return nameArg;
  const base = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "");
  const candidate = `${base || "project"}-rules`.slice(0, 41);
  return NAME_RE.test(candidate) ? candidate : "project-rules";
}

/** Value following a `--flag` token, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
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

/**
 * Fetch a source to a readable directory without installing it. Prints its own
 * errors and returns null on failure. When `cleanup` is set the caller must
 * rmSync it after use (it is a temp clone).
 */
function fetchSource(source: string, root: string): { dir: string; cleanup?: string; nameHint?: string | undefined } | null {
  const normalized = normalizeSource(source, root);
  if (normalized.kind === "local") {
    if (!existsSync(normalized.value)) {
      console.error(`local path not found: ${normalized.value}`);
      return null;
    }
    return { dir: normalized.value, nameHint: basename(normalized.value) };
  }

  const m = normalized.value.match(/^([^/@]+)\/([^/@]+)(?:\/([^@]+))?(?:@(.+))?$/);
  if (!m) {
    console.error(`invalid source "${source}".`);
    console.error("  expected: gh:owner/repo, owner/repo, owner/repo/path/to/skill, or owner/repo@ref");
    return null;
  }
  if (!hasGit()) {
    console.error("git is required to fetch from GitHub but was not found on PATH.");
    console.error("  install git, or use a local source: file:./path/to/skill");
    return null;
  }
  const [, owner, repo, subpath, ref] = m;
  const cleanup = mkdtempSync(join(tmpdir(), "kitbash-"));
  const fail = (lines: string[]): null => {
    rmSync(cleanup, { recursive: true, force: true });
    for (const l of lines) console.error(l);
    return null;
  };
  const url = `https://github.com/${owner}/${repo}.git`;
  const cloneArgs = ref ? ["clone", "--quiet", url, cleanup] : ["clone", "--quiet", "--depth", "1", url, cleanup];
  try {
    execFileSync("git", cloneArgs, { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    return fail([
      `could not clone https://github.com/${owner}/${repo}.`,
      "  check the repo exists and is public, the name is spelled right, and you're online.",
    ]);
  }
  if (ref) {
    try {
      execFileSync("git", ["-C", cleanup, "checkout", "--quiet", ref], { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      return fail([`ref "${ref}" not found in ${owner}/${repo} (not a branch, tag, or commit).`]);
    }
  }
  let dir = cleanup;
  if (subpath) {
    const resolved = resolveSubpath(cleanup, subpath);
    if (!resolved) {
      return fail([
        `invalid subpath "${subpath}": it escapes the repository.`,
        "  use a path inside the repo, e.g. owner/repo/skills/my-skill.",
      ]);
    }
    if (!existsSync(resolved)) {
      return fail([
        `path "${subpath}" not found in ${owner}/${repo}.`,
        "  point at the folder that contains skill.toml (or SKILL.md).",
      ]);
    }
    dir = resolved;
  }
  // The clone's own .git is never part of the skill. Left in place it gets copied
  // into .kitbash/skills/ for a repo-root install, and since git's index and reflog
  // differ between two clones of the same commit, every later update would see
  // permanent drift and dump .git/… entries into the review diff.
  rmSync(join(cleanup, ".git"), { recursive: true, force: true });
  return { dir, cleanup, nameHint: subpath ? basename(subpath) : repo };
}

function confirm(question: string): Promise<boolean> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      res(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function cmdInstall(args: string[]): Promise<number> {
  const source = args.find((a) => !a.startsWith("-"));
  const yes = args.includes("--yes") || args.includes("-y");
  if (!source) {
    console.error("usage: kitbash install <gh:owner/repo[/path][@ref] | owner/repo | file:path> [--yes]");
    return 1;
  }
  const root = process.cwd();
  const fetched = fetchSource(source, root);
  if (!fetched) return 1;
  try {
    const skill = loadSkill(fetched.dir, fetched.nameHint);
    const { name, version, description } = skill.manifest.skill;
    const dest = join(root, SKILLS_DIR, name);
    if (existsSync(dest)) {
      console.error(`${name} is already installed. To reinstall: kitbash remove ${name} && kitbash install ${source}`);
      return 1;
    }

    // Review before install (spec §2: permissions are surfaced at install review).
    const m = skill.manifest;
    console.log(`review: ${name}@${version} — ${description}`);
    console.log(`  budget ${m.context.budget} tok · standing ${m.context.standing} tok/session · ${m.context.disclosure} disclosure · mode ${m.targets.mode}`);
    console.log(`  permissions: tools [${m.permissions.tools.join(", ") || "none"}] · network ${m.permissions.network ? "YES" : "no"} · write ${m.permissions.write ? "YES" : "no"}`);
    if (m.targets.requires.length) console.log(`  requires: ${m.targets.requires.join(", ")}`);
    if (skill.bare) console.log(`  ⚠ unmanifested (SKILL.md only) — defaults applied, no permissions or budget declared by the author`);
    const checks = staticChecks(skill);
    for (const c of checks.filter((c) => c.ok && c.warn)) {
      console.log(`  ⚠ lint: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }

    const policy = loadPolicy(root);

    // The three safety lints in staticChecks scan only SKILL.md, but install copies
    // the whole directory — a curl|sh in scripts/setup.sh, or hidden text in a
    // sibling .md, would sail through and script-capable adapters point the agent
    // straight at it. Scan every other non-binary file the same way.
    const fileHits = scanSkillFiles(fetched.dir);
    checks.push(...fileHits);

    // Failed SAFETY lints are a hard gate — not bypassable by --yes, and enforced
    // even with no kitbash.toml (loadPolicy returns null then). These catch hidden
    // instructions and download-and-execute payloads before one skill fans out to
    // nine files. Schema/quality failures (a malformed artifact ref, a non-slash
    // command) are NOT gated here — they surface at `kitbash test`. A policy may
    // opt out of the remote-exec block for a trusted internal skill; the
    // visibility checks are never optional.
    const hardFails = filterHardFails(checks, policy);
    if (hardFails.length) {
      for (const c of hardFails) console.error(`  ✗ lint: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      console.error("blocked — this skill fails a non-bypassable safety lint. Read it before installing (kitbash lint <source>).");
      return 1;
    }

    // Policy is a hard gate: --yes does not bypass it.
    if (policy) {
      const violations = [
        ...sourceViolations(policy, source, root),
        ...manifestViolations(policy, skill),
      ];
      if (violations.length) {
        for (const v of violations) console.error(`  ✗ policy: ${v}`);
        console.error(`blocked by [policy] in ${CONFIG}.`);
        return 1;
      }
    }

    if (!yes && process.stdin.isTTY && process.stdout.isTTY) {
      const ok = await confirm(`install ${name}@${version}? [y/N] `);
      if (!ok) {
        console.error("aborted — nothing installed.");
        return 1;
      }
    }

    mkdirSync(dirname(dest), { recursive: true });
    cpSync(fetched.dir, dest, { recursive: true, filter: notGitDir });
    upsertLock(root, { name, version, source, integrity: integrityOf(dest) });

    console.log(`installed ${name}@${version}`);
    console.log(`  pinned in ${LOCK_FILE}`);
    console.log("next: kitbash compile");
    return 0;
  } finally {
    if (fetched.cleanup) rmSync(fetched.cleanup, { recursive: true, force: true });
  }
}

/**
 * The non-bypassable subset of failed checks: the SAFETY_LINTS, minus
 * remote-exec when a [policy] consciously exempts it. Shared by install and
 * update — a skill must clear the same gate to change on disk as to arrive.
 */
function filterHardFails(checks: Check[], policy: Policy | null): Check[] {
  const remoteExecExempt = policy && !policy.denyRemoteExec;
  return checks.filter((c) => !c.ok && SAFETY_LINTS.has(c.name) && !(c.name === "remote-exec" && remoteExecExempt));
}

/**
 * Print the full review diff between an installed skill directory and its
 * replacement: manifest field deltas (escalations flagged), the changed file
 * list, then a unified diff per readable file. Returns true when anything
 * differs. `aSkill` is null when the installed copy no longer loads — the
 * file-level diff still prints, so even repairing a broken skill shows what
 * changes on disk.
 */
function printSkillDiff(aDir: string, aSkill: LoadedSkill | null, bSkill: LoadedSkill): boolean {
  const delta = aSkill ? manifestDelta(aSkill.manifest, bSkill.manifest) : [];
  const changes = fileChanges(aDir, bSkill.dir);
  if (!delta.length && !changes.length) return false;

  const from = aSkill ? `${aSkill.manifest.skill.name}@${aSkill.manifest.skill.version}` : "(unloadable)";
  console.log(`diff: ${from} → ${bSkill.manifest.skill.name}@${bSkill.manifest.skill.version}`);
  if (!aSkill) console.log("  ⚠ installed copy no longer loads — manifest delta unavailable, file diff below");
  if (delta.length) {
    console.log("manifest:");
    for (const d of delta) console.log(`  ${d}`);
  }
  if (changes.length) {
    console.log("files:");
    for (const c of changes) {
      const sym = c.kind === "added" ? "+" : c.kind === "removed" ? "-" : "~";
      console.log(`  ${sym} ${c.path}${c.opaque ? " (binary or symlink — not line-diffed)" : ""}`);
    }
    for (const c of changes) {
      if (c.opaque) continue;
      // A removed file is diffed against "" like an added one is: deleting the
      // script a SKILL.md points at changes behavior as much as adding one, and
      // the reviewer has to see what left.
      const before = c.kind === "added" ? "" : textOf(aDir, c.path);
      const after = c.kind === "removed" ? "" : textOf(bSkill.dir, c.path);
      const d = unifiedDiff(before, after, `a/${c.path}`, `b/${c.path}`);
      if (d) console.log(`\n${d}`);
    }
  }
  return true;
}

export async function cmdDiff(args: string[]): Promise<number> {
  const targets = args.filter((a) => !a.startsWith("-"));
  const [aTarget, bTarget] = targets;
  if (!aTarget) {
    console.error("usage: kitbash diff <skill-name> [<skill-name | path | source>]");
    console.error("  one argument: diff the installed skill against a fresh fetch of its pinned source");
    console.error("  two arguments: diff any two skills (installed name, path, or gh:/file: source)");
    return 2;
  }
  const root = process.cwd();
  const cleanups: string[] = [];
  try {
    const a = loadSkillTarget(aTarget, root);
    if (!a) return 2;
    if (a.cleanup) cleanups.push(a.cleanup);

    let bSkill: LoadedSkill;
    if (bTarget) {
      const b = loadSkillTarget(bTarget, root);
      if (!b) return 2;
      if (b.cleanup) cleanups.push(b.cleanup);
      bSkill = b.skill;
    } else {
      const entry = readLock(root).find((e) => e.name === aTarget);
      if (!entry) {
        console.error(`${aTarget} is not pinned in ${LOCK_FILE} — install it first, or pass two targets to compare.`);
        return 2;
      }
      const fetched = fetchSource(entry.source, root);
      if (!fetched) return 2;
      if (fetched.cleanup) cleanups.push(fetched.cleanup);
      try {
        bSkill = loadSkill(fetched.dir, fetched.nameHint);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 2;
      }
    }

    if (!printSkillDiff(a.skill.dir, a.skill, bSkill)) {
      console.log(`no differences: ${a.skill.manifest.skill.name}@${a.skill.manifest.skill.version}`);
      return 0;
    }
    return 1; // diff(1) semantics: 0 identical, 1 different, 2 trouble
  } finally {
    for (const c of cleanups) rmSync(c, { recursive: true, force: true });
  }
}

export async function cmdUpdate(args: string[]): Promise<number> {
  const only = args.find((a) => !a.startsWith("-"));
  const yes = args.includes("--yes") || args.includes("-y");
  const root = process.cwd();
  let lock = readLock(root);
  if (only) {
    const all = lock;
    lock = lock.filter((e) => e.name === only);
    if (!lock.length) {
      console.error(`${only} is not pinned in ${LOCK_FILE}.`);
      console.error(all.length ? `  pinned: ${all.map((e) => e.name).join(", ")}` : "  no skills installed yet.");
      return 1;
    }
  }
  if (!lock.length) {
    console.log("no skills installed — nothing to update.");
    return 0;
  }

  const policy = loadPolicy(root);
  let updated = 0;
  let current = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of lock) {
    const dest = join(root, SKILLS_DIR, entry.name);
    if (!existsSync(dest)) {
      console.error(`✗ ${entry.name}: pinned in ${LOCK_FILE} but not installed — kitbash install ${entry.source}`);
      failed++;
      continue;
    }
    const fetched = fetchSource(entry.source, root);
    if (!fetched) {
      failed++;
      continue;
    }
    try {
      let next: LoadedSkill;
      try {
        next = loadSkill(fetched.dir, fetched.nameHint);
      } catch (e) {
        console.error(`✗ ${entry.name}: source no longer loads — ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
        failed++;
        continue;
      }
      if (next.manifest.skill.name !== entry.name) {
        console.error(`✗ ${entry.name}: the source now names itself "${next.manifest.skill.name}" — kitbash remove ${entry.name} && kitbash install ${entry.source}`);
        failed++;
        continue;
      }

      const installedIntegrity = integrityOf(dest);
      if (installedIntegrity === integrityOf(fetched.dir)) {
        console.log(`${entry.name}@${entry.version} is up to date`);
        current++;
        continue;
      }

      // The review. Local drift means the baseline being diffed is the edited
      // copy — say so, since applying will overwrite those edits.
      let installedSkill: LoadedSkill | null = null;
      try {
        installedSkill = loadSkill(dest);
      } catch {
        // unloadable installed copy: printSkillDiff handles the null
      }
      if (installedIntegrity !== entry.integrity) {
        console.log(`⚠ ${entry.name}: local edits detected (integrity drift) — updating overwrites them; the diff below starts from the edited files`);
      }
      printSkillDiff(dest, installedSkill, next);

      // Same non-bypassable gate as install: a skill must clear it to change on disk.
      const hardFails = filterHardFails([...staticChecks(next), ...scanSkillFiles(fetched.dir)], policy);
      if (hardFails.length) {
        for (const c of hardFails) console.error(`  ✗ lint: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
        console.error(`✗ ${entry.name}: blocked — the update fails a non-bypassable safety lint; nothing was changed.`);
        failed++;
        continue;
      }
      if (policy) {
        const violations = [...sourceViolations(policy, entry.source, root), ...manifestViolations(policy, next)];
        if (violations.length) {
          for (const v of violations) console.error(`  ✗ policy: ${v}`);
          console.error(`✗ ${entry.name}: blocked by [policy] in ${CONFIG}; nothing was changed.`);
          failed++;
          continue;
        }
      }

      if (!yes) {
        if (!(process.stdin.isTTY && process.stdout.isTTY)) {
          // Unlike install, update never auto-applies in a pipe: its whole
          // contract is that a human saw the diff above and said yes.
          console.error(`${entry.name}: not applied — non-interactive session; rerun with --yes to apply.`);
          skipped++;
          continue;
        }
        const ok = await confirm(`update ${entry.name} to ${next.manifest.skill.version}? [y/N] `);
        if (!ok) {
          console.log(`skipped ${entry.name} — nothing changed.`);
          skipped++;
          continue;
        }
      }

      rmSync(dest, { recursive: true });
      cpSync(fetched.dir, dest, { recursive: true, filter: notGitDir });
      upsertLock(root, { name: entry.name, version: next.manifest.skill.version, source: entry.source, integrity: integrityOf(dest) });
      console.log(`updated ${entry.name}@${next.manifest.skill.version}`);
      console.log(`  re-pinned in ${LOCK_FILE}`);
      updated++;
    } finally {
      if (fetched.cleanup) rmSync(fetched.cleanup, { recursive: true, force: true });
    }
  }

  const parts = [`${updated} updated`, `${current} up to date`];
  if (skipped) parts.push(`${skipped} not applied`);
  if (failed) parts.push(`${failed} failed`);
  console.log(parts.join(" · "));
  if (updated) console.log("next: kitbash compile");
  return failed || skipped ? 1 : 0;
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
    console.log(`${m.skill.name}@${m.skill.version}  budget=${m.context.budget}tok  standing=${m.context.standing}tok/session  mode=${m.targets.mode}${bare}  — ${m.skill.description}`);
  }
  return 0;
}

export async function cmdDoctor(): Promise<number> {
  const root = process.cwd();
  const detected = ADAPTERS.filter((a) => a.detect(root)).length;
  console.log(`detected targets (${detected} of ${ADAPTERS.length} in this repo):`);
  for (const a of ADAPTERS) {
    const found = a.detect(root);
    const note = a.id === "agentsmd" ? " (floor: Codex, Gemini CLI, anything reading AGENTS.md)" : "";
    // `·` = not present in this repo (not a failure); `✗` is reserved for real problems below.
    console.log(`  ${found ? "✓" : "·"} ${a.id}${note}`);
  }

  const { skills, failures } = loadInstalledSkillsSafe(root);
  const standing = skills.reduce((sum, s) => sum + estimateTokens(standingStub(s.body)), 0);
  const active = skills.reduce((sum, s) => sum + s.manifest.context.budget, 0);
  console.log(`installed skills: ${skills.length}`);
  console.log(`standing context cost: ~${standing} tokens (stubs); worst-case active: ${active} tokens (budgets)`);

  let problems = 0;
  // A skill whose manifest no longer loads (hand-edited, or the exact tamper doctor
  // exists to catch). Count it, don't throw — the integrity loop below must still run.
  for (const f of failures) {
    console.error(`  ✗ ${f.name}: failed to load — ${f.message.split("\n")[0]}`);
    problems++;
  }

  // Skills installed but no lockfile at all — nothing is pinned.
  if ((skills.length || failures.length) && !existsSync(join(root, LOCK_FILE))) {
    console.error(`  ✗ ${skills.length + failures.length} skill(s) installed but ${LOCK_FILE} is missing — nothing is pinned. Reinstall to regenerate it.`);
    return 1;
  }

  const lock = readLock(root);
  const pinned = new Set(lock.map((e) => e.name));
  for (const entry of lock) {
    const dir = join(root, SKILLS_DIR, entry.name);
    if (!existsSync(dir)) {
      console.log(`  ⚠ ${entry.name}: in ${LOCK_FILE} but not installed`);
      continue;
    }
    if (integrityOf(dir) !== entry.integrity) {
      console.error(`  ✗ ${entry.name}: integrity drift — installed files differ from ${LOCK_FILE}`);
      problems++;
    }
  }
  // Installed but never pinned (manual copy, leftover, or dropped lock entry).
  for (const s of skills) {
    if (!pinned.has(s.manifest.skill.name)) {
      console.error(`  ✗ ${s.manifest.skill.name}: installed but not pinned in ${LOCK_FILE} — reinstall to pin it.`);
      problems++;
    }
  }
  // Recheck [policy] against what is already installed — catches skills that
  // predate the policy or were copied in outside `kitbash install`.
  const policy = loadPolicy(root);
  let policyProblems = 0;
  if (policy) {
    const sources = new Map(lock.map((e) => [e.name, e.source]));
    for (const s of skills) {
      const src = sources.get(s.manifest.skill.name);
      const violations = [
        ...(src ? sourceViolations(policy, src, root) : []),
        ...manifestViolations(policy, s),
      ];
      for (const v of violations) {
        console.error(`  ✗ policy: ${v}`);
        policyProblems++;
      }
    }
  }

  if (problems || policyProblems) {
    if (problems) console.error(`${problems} integrity problem(s) — reinstall or investigate`);
    if (policyProblems) console.error(`${policyProblems} policy violation(s) — see [policy] in ${CONFIG}`);
    return 1;
  }
  console.log("lock integrity: ok");
  if (policy) console.log("policy: ok");
  return 0;
}

/**
 * Project-level install policy from kitbash.toml `[policy]` — the org-allowlist
 * layer: which sources may be installed and what installed skills may declare.
 * Enforced at install (hard error, not bypassable) and rechecked by doctor.
 */
interface Policy {
  allowSources: string[];
  denyNetwork: boolean;
  denyWrite: boolean;
  maxBudget?: number | undefined;
  /** The remote-exec lint is a hard fail by default; a policy may consciously exempt it. */
  denyRemoteExec: boolean;
}

function loadPolicy(root: string): Policy | null {
  const p = join(root, CONFIG);
  if (!existsSync(p)) return null;
  const raw = parseToml(readFileSync(p, "utf8"));
  const t = raw["policy"];
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const tbl = t as Record<string, unknown>;
  const allowSources = Array.isArray(tbl["allow_sources"])
    ? (tbl["allow_sources"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return {
    allowSources,
    denyNetwork: tbl["deny_network"] === true,
    denyWrite: tbl["deny_write"] === true,
    maxBudget: typeof tbl["max_budget"] === "number" ? (tbl["max_budget"] as number) : undefined,
    // Absent means true — you must opt OUT of the remote-exec block explicitly.
    denyRemoteExec: tbl["deny_remote_exec"] !== false,
  };
}

/** Glob match where `*` spans any run of characters, including `/`. */
function sourceMatches(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return re.test(value);
}

/**
 * Patterns are matched against the CANONICAL source only (gh:owner/repo…,
 * file:/abs/path). Matching the raw string too was an escape hatch: `*` spans
 * `/`, so `file:/srv/approved/../untrusted/evil` matched an allowlist of
 * `file:/srv/approved/*` while resolving somewhere else entirely — and the
 * un-normalized string was then persisted as the lockfile source, so doctor kept
 * reporting "policy: ok" and update kept refetching from outside the allowlist.
 */
function sourceViolations(policy: Policy, rawSource: string, root: string): string[] {
  if (!policy.allowSources.length) return [];
  const n = normalizeSource(rawSource, root);
  const canonical = n.kind === "gh" ? `gh:${n.value}` : `file:${n.value}`;
  const allowed = policy.allowSources.some((p) => sourceMatches(p, canonical));
  const shown = canonical === rawSource ? `"${rawSource}"` : `"${rawSource}" (${canonical})`;
  return allowed ? [] : [`source ${shown} is not in allow_sources (${policy.allowSources.join(", ")})`];
}

function manifestViolations(policy: Policy, skill: LoadedSkill): string[] {
  const out: string[] = [];
  const m = skill.manifest;
  const name = m.skill.name;
  if (policy.denyNetwork && m.permissions.network) out.push(`${name} declares network permission and deny_network = true`);
  if (policy.denyWrite && m.permissions.write) out.push(`${name} declares write permission and deny_write = true`);
  if (policy.maxBudget !== undefined && m.context.budget > policy.maxBudget) {
    out.push(`${name} budget ${m.context.budget} exceeds max_budget ${policy.maxBudget}`);
  }
  return out;
}

/**
 * Resolve a lint/explain/preview target: an existing local path, an installed
 * skill name, or an uninstalled source (gh:owner/repo[/path][@ref], owner/repo,
 * file:path) — fetched to a temp dir so skills are reviewable before install.
 * Caller must rmSync `cleanup` when set.
 */
function loadSkillTarget(target: string, root: string): { skill: LoadedSkill; cleanup?: string | undefined } | null {
  const asPath = resolve(root, target);
  if (existsSync(asPath)) {
    try {
      return { skill: loadSkill(asPath, basename(asPath)) };
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
  const installed = loadInstalledSkills(root);
  const found = installed.find((s) => s.manifest.skill.name === target);
  if (found) return { skill: found };

  if (target.startsWith("gh:") || target.startsWith("file:") || /^[\w.-]+\/[\w.-]+/.test(target)) {
    const fetched = fetchSource(target, root);
    if (!fetched) return null;
    try {
      return { skill: loadSkill(fetched.dir, fetched.nameHint), cleanup: fetched.cleanup };
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      if (fetched.cleanup) rmSync(fetched.cleanup, { recursive: true, force: true });
      return null;
    }
  }

  console.error(`${target}: not found as a path or installed skill name (or pass a source: gh:owner/repo, file:path)`);
  if (installed.length) console.error(`  installed: ${installed.map((s) => s.manifest.skill.name).join(", ")}`);
  return null;
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
  const { skills, failures } = loadInstalledSkillsSafe(root);

  const adaptersOrError = configuredAdapters(root);
  if (typeof adaptersOrError === "string") {
    console.error(adaptersOrError);
    return 1;
  }
  const adapters = adaptersOrError;
  // No adapters but skills present (e.g. `targets = []` in kitbash.toml) would run the
  // prune pass and delete every previously-generated file while writing nothing back.
  // Refuse rather than silently wipe output.
  if (adapters.length === 0 && skills.length > 0) {
    console.error(`no compile targets resolved, but ${skills.length} skill(s) are installed — refusing to compile (it would delete all generated output).`);
    console.error(`  add a detectable agent dir (.claude/, .cursor/, …) or set [project].targets in ${CONFIG}.`);
    return 1;
  }
  // A skill whose manifest no longer loads is still installed. Compiling around it
  // silently — dropping it from the count and pruning its AGENTS.md section while
  // it sits on disk, still pinned — is how an agent loses instructions with nobody
  // told. Its directory name counts as installed so nothing of its is pruned, its
  // existing output is left exactly as it was, and the command exits non-zero.
  for (const f of failures) console.error(`✗ ${f.name}: failed to load — ${f.message.split("\n")[0]}`);
  const installedNames = new Set([...skills.map((s) => s.manifest.skill.name), ...failures.map((f) => f.name)]);
  const keepPaths = new Set(failures.flatMap((f) => managedPathsFor(f.name)));

  const files = new Map<string, string>();
  const owners = new Map<string, string>(); // non-merge path → skill that wrote it, for conflict detection
  const warnings: string[] = []; // actionable — fail --strict
  const notes: string[] = []; // informational (measured standing cost) — never fail --strict
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

    // Spec §2: declared permissions must be enforced natively or compiled into the
    // instructions. No target enforces natively, so compile them into the body — the
    // teammate who pulls the generated file sees the same limits the installer did.
    // Appended after the budget check so kitbash's own note isn't charged to the author.
    const emitBody = body + permissionsNote(skill.manifest);

    for (const adapter of adapters) {
      const out = adapter.emit(skill, emitBody, root);
      warnings.push(...out.warnings);
      if (out.notes) notes.push(...out.notes);
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
  // Every emitted path must land inside the project. Adapters build filenames from
  // manifest values, so a containment check here is the last line before a write:
  // nothing a skill declares may address a file outside the repo it was installed in.
  const escaping = written.filter((f) => !resolveSubpath(root, f.path));
  if (escaping.length) {
    for (const f of escaping) console.error(`✗ refusing to write outside the project: ${f.path}`);
    console.error("  a skill's declared name or trigger command produced an escaping path — nothing was written.");
    return 1;
  }
  for (const f of written) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content.endsWith("\n") ? f.content : `${f.content}\n`);
    console.log(`→ ${f.path}`);
  }
  // Shared marker files not rewritten this compile still need stale sections pruned.
  // Nothing wrote to this file, so none of its kitbash sections are current — whether
  // the last skill writing there was removed, the target was dropped from kitbash.toml,
  // or the adapter moved to a skills directory (gemini and copilot did, in 0.8.0).
  // Only kitbash's own marked sections are touched; user content is never disturbed.
  for (const rel of MANAGED_SHARED_FILES) {
    if (files.has(rel) || !existsSync(join(root, rel))) continue;
    const before = readFileSync(join(root, rel), "utf8");
    const after = pruneSections(before, new Set());
    if (after !== before) {
      writeFileSync(join(root, rel), after.endsWith("\n") ? after : `${after}\n`);
      console.log(`✂ pruned stale section(s) from ${rel}`);
    }
  }
  for (const pruned of pruneStaleOutputs(root, new Set([...files.keys(), ...keepPaths]))) console.log(`✂ ${pruned}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const n of notes) console.log(`ℹ ${n}`); // the measurement — informational, not a failure
  if (!skills.length && !failures.length) {
    console.log("no skills installed — kitbash install <source> to add one");
    return 0;
  }
  console.log(`compiled ${plural(skills.length, "skill")} for ${plural(adapters.length, "target")}`);
  if (failures.length) {
    console.error(`${plural(failures.length, "installed skill")} could not be loaded and ${failures.length === 1 ? "was" : "were"} skipped — their existing output is untouched. Fix the manifest or reinstall.`);
    return 1;
  }
  // The pitch is "every agent" — a partial fan-out on a fresh repo looks like a shortfall.
  if (adapters.length < ADAPTERS.length && !hasExplicitTargets(root)) {
    const missing = ADAPTERS.filter((a) => !adapters.includes(a)).map((a) => a.id);
    console.log(`  ${ADAPTERS.length - adapters.length} more target(s) available — add ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""} under [project].targets in ${CONFIG}, or create their agent dirs.`);
  }
  if (strict && warnings.length) {
    console.error(`--strict: failing on ${plural(warnings.length, "warning")}`);
    return 1;
  }
  return 0;
}

/** English pluralization for count lines — replaces the terse "1 skill(s)". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** True when kitbash.toml explicitly sets [project].targets (so a partial set is intentional). */
function hasExplicitTargets(root: string): boolean {
  const p = join(root, CONFIG);
  if (!existsSync(p)) return false;
  const raw = parseToml(readFileSync(p, "utf8"));
  const project = raw["project"];
  return !!(project && typeof project === "object" && !Array.isArray(project) && Array.isArray((project as Record<string, unknown>)["targets"]));
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
  // Behavioral directives a distributed skill should not carry — a fan-out chokepoint
  // surfaces them for review (warn, not block: a defensive skill may quote them).
  { re: /(?:always|automatically)\s+(?:report|say|respond|mark)\s+(?:it\s+)?(?:ok|success|successful|passed|clean|as\s+safe)|(?:remove|suppress|hide)\s+(?:the\s+|all\s+)?(?:warnings|findings|errors)/i, label: "output-suppression directive" },
  { re: /(?:automatically|silently)\s+(?:install|run|execute)|without\s+(?:asking|prompting|confirmation|the\s+user'?s?\s+(?:consent|approval|permission))/i, label: "auto-run / no-consent directive" },
  { re: /(?:collect|gather|dump|harvest)\s+(?:all\s+)?(?:the\s+)?(?:passwords|credentials|secrets|api\s*keys|ssh\s+keys|the\s+database)/i, label: "bulk-credential harvesting" },
  // An injection directive hidden in an HTML comment — invisible in rendered markdown,
  // read by the agent. Requires the comment to actually carry an override phrase, so
  // ordinary tooling comments (<!-- prettier-ignore -->) don't trip it.
  { re: /<!--(?:(?!-->)[\s\S]){0,400}?(?:ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above)\s+instructions|you\s+are\s+now\b|disregard\s+(?:the\s+)?(?:above|previous|system))(?:(?!-->)[\s\S])*?-->/i, label: "hidden directive in HTML comment" },
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
  // The safety scanners run on the raw source when resolution failed. Gating them
  // on a resolved body made every one of them optional: a single unresolvable
  // {{token}} anywhere in SKILL.md made resolveBody throw, and a curl|sh pipeline
  // in the same file then installed cleanly. Budget checks stay gated — measuring
  // an unresolved body would report a number the compiler never emits — but
  // "can a reviewer see this, and does it execute on load" never gets a pass.
  const safetyBody = body ?? skill.body;

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

  // gate-mode skills (spec §4) must be able to produce a deterministic verdict —
  // a scripts/ dir to run or a declared artifact. Neither present = a gate that
  // can't gate. Structural proxy, but it catches the concrete empty case.
  if (m.targets.mode === "gate") {
    const hasVerdict = existsSync(join(skill.dir, "scripts")) || m.artifacts.produces.length > 0;
    checks.push({
      name: "gate-verdict",
      ok: hasVerdict,
      detail: hasVerdict ? "has a scripts/ dir or a declared artifact" : "gate mode but no scripts/ dir and no artifacts.produces — nothing to produce a verdict",
    });
  }

  // artifact refs must be name@version
  const badArtifacts = [...m.artifacts.produces, ...m.artifacts.consumes].filter((a) => !ARTIFACT_RE.test(a));
  if (m.artifacts.produces.length || m.artifacts.consumes.length) {
    checks.push({ name: "artifacts", ok: badArtifacts.length === 0, detail: badArtifacts.length ? `malformed: ${badArtifacts.join(", ")} (want name@version)` : `produces ${m.artifacts.produces.length}, consumes ${m.artifacts.consumes.length}` });
  }

  // Command triggers become filenames (.claude/commands/<cmd>.md), so the shape is
  // load-bearing: anything with a path in it would compile outside the repo.
  const badCommands = m.triggers.commands.filter((c) => !COMMAND_RE.test(c));
  if (badCommands.length) checks.push({ name: "triggers", ok: false, detail: `commands must match ${COMMAND_RE} — a slash and a lowercase name, no paths: ${badCommands.join(", ")}` });

  // schema-conformance lints: unknown tables, unrecognized enum values (warn, per RFC 0002)
  const lints = schemaLints(skill.dir);
  if (lints.length) checks.push({ name: "schema", ok: true, warn: true, detail: lints.join("; ") });

  // injection heuristics (warn only)
  const hits = INJECTION_PATTERNS.filter((p) => p.re.test(safetyBody)).map((p) => p.label);
  if (hits.length) checks.push({ name: "injection", ok: true, warn: true, detail: `heuristic match — review: ${hits.join(", ")}` });

  // Hard failures: instructions a human reviewer cannot see, or that execute
  // before the model reads anything. Kitbash fans one skill out to nine files,
  // several of them always in context, so these never get a pass.
  const invisible = invisibleRuns(safetyBody);
  checks.push({
    name: "visible-text",
    ok: invisible.length === 0,
    detail: invisible.length
      ? `${invisible.length} run(s) of invisible characters (${invisible.join(", ")}) — instructions a reviewer cannot see`
      : "no hidden characters",
  });

  const escapes = [...safetyBody.matchAll(DYNAMIC_CONTEXT_RE)].map((m) => m[0].slice(0, 40));
  if (escapes.length) {
    checks.push({
      name: "dynamic-context",
      ok: false,
      detail: `command substitution in the skill body executes before the model sees it: ${escapes.join(", ")}`,
    });
  }

  // Download-and-execute pipelines hidden in skill prose (a "Prerequisites"
  // section, a code fence) — the ClawHavoc / ClickFix pattern. The fuzzy
  // curl|sh entry in INJECTION_PATTERNS stays a warning (a defensive skill may
  // quote it); the literal download→execute family below is a hard line.
  const remoteExec = remoteExecHits(safetyBody);
  if (remoteExec.length) {
    checks.push({
      name: "remote-exec",
      ok: false,
      detail: `download-and-execute pipeline in the skill body: ${remoteExec.join(", ")}`,
    });
  }

  // A live credential shipped inside a skill — never legitimate.
  const secrets = secretHits(safetyBody);
  if (secrets.length) {
    checks.push({
      name: "secrets",
      ok: false,
      detail: `hardcoded credential in the skill body: ${secrets.join(", ")}`,
    });
  }

  return checks;
}

/**
 * Invisible codepoints used to hide instructions from human review while agents
 * still read them: zero-width characters, bidi overrides, and the Unicode Tags
 * block (U+E0000–U+E007F), which encodes plain ASCII invisibly.
 */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;

/** Backtick command substitution in Claude Code frontmatter/body runs at load time. */
const DYNAMIC_CONTEXT_RE = /!`[^`\n]+`/g;

function invisibleRuns(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(INVISIBLE_RE)) {
    const cp = m[0].codePointAt(0)!;
    found.add(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return [...found];
}

/**
 * Download-and-execute pipelines a skill body might try to get a user (or the
 * agent) to run. This targets the *shape* — fetch remote content, pipe it to a
 * shell — not one string, since the payload is the same whatever the URL. It is
 * a heuristic, not a proof: `c=curl; $c url | sh` slips past a regex on prose.
 * It raises attacker cost and catches the copy-paste ClickFix/ClawHavoc family
 * at the install chokepoint, where one skill fans out to nine files.
 */
const REMOTE_EXEC: { re: RegExp; label: string }[] = [
  { re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i, label: "curl|sh" },
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:python3?|node|perl|ruby)\b/i, label: "curl|interpreter" },
  { re: /\b(?:eval|exec)\s+["'`]?\$\((?:curl|wget|fetch)\b/i, label: "eval $(curl …)" },
  { re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*source\b/i, label: "curl|source" },
  { re: /\bbase64\b[^\n|]*(?:-d|--decode)[^\n|]*\|\s*(?:ba|z)?sh\b/i, label: "base64 -d|sh" },
  { re: /\b(?:iex|invoke-expression)\b[^\n]*\b(?:iwr|invoke-webrequest|new-object\s+net\.webclient|downloadstring)\b/i, label: "powershell iex(download)" },
  { re: /\b(?:iwr|invoke-webrequest|curl|wget)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i, label: "powershell download|iex" },
  // Save to a file (-o/-O), then make it executable or run it directly — the
  // classic dropper. Requires the fetch AND an execution signal, not either alone.
  { re: /\b(?:curl|wget)\b[^\n]*\s-[oO]\b[\s\S]{0,120}?(?:chmod\s+\+x|\.\/[\w.-]+|\b(?:ba|z)?sh\s+[\w./-]+)/i, label: "download → run" },
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:tar|unzip|bsdtar)\b/i, label: "remote archive → extract" },
];

function remoteExecHits(body: string): string[] {
  const found = new Set<string>();
  for (const p of REMOTE_EXEC) if (p.re.test(body)) found.add(p.label);
  return [...found];
}

/**
 * Live credentials that must never ship inside a distributed skill. Each pattern
 * keys on a provider's exact key SHAPE (prefix + real length + character class),
 * not the prefix alone, so a placeholder (`sk-ant-...`, `sk-ant-xxxx`) or an
 * env-var reference (`${ANTHROPIC_API_KEY}`) doesn't match — those are too short
 * or don't contain a key body. Adopted from the field-tested prefix set that
 * agent-config scanners settled on. `secretsExcluded()` drops obvious example
 * values so a skill that documents a fake key isn't blocked for teaching.
 */
const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
  { re: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{80,}/, label: "Anthropic API key" },
  { re: /\bsk-proj-[A-Za-z0-9_-]{40,}/, label: "OpenAI project key" },
  { re: /\bsk-[A-Za-z0-9]{48}\b/, label: "OpenAI key" },
  { re: /\bghp_[A-Za-z0-9]{36}\b/, label: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{60,}/, label: "GitHub fine-grained token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "Google API key" },
  { re: /\bsk_live_[A-Za-z0-9]{24,}/, label: "Stripe live key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{12,}/, label: "Slack token" },
  { re: /\blin_api_[A-Za-z0-9]{40,}/, label: "Linear API key" },
  // Connection string carrying an inline password (user:secret@host). An env-ref
  // password (user:${DB_PASS}@) is excluded by the ${ guard in PLACEHOLDER_RE.
  { re: /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqp):\/\/[^:@\s/]+:[^@\s/]{6,}@/, label: "DB connection secret" },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: "private key" },
];

/** Obvious non-secret example values — a matched string carrying one is documentation, not a leak. */
const PLACEHOLDER_RE = /EXAMPLE|XXXX|YOUR[_-]?|PLACEHOLDER|REDACTED|\.\.\.|<[A-Za-z]|\$\{/i;

function secretHits(text: string): string[] {
  const found = new Set<string>();
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(text);
    if (m && !PLACEHOLDER_RE.test(m[0])) found.add(p.label);
  }
  return [...found];
}

/** cpSync filter: a source's own .git is never part of the skill. */
function notGitDir(src: string): boolean {
  return basename(src) !== ".git";
}

/**
 * Is this a real binary (an image, a compiled artifact) rather than text an agent
 * will read? Decided by the density of control characters, not by the presence of
 * a single NUL: `buf.includes(0)` let one stray NUL byte — invisible in a terminal,
 * in a markdown renderer, and to the model — exempt an entire file from every
 * safety scanner while it stayed perfectly readable prose.
 */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (!sample.length) return false;
  let control = 0;
  for (const byte of sample) {
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127);
    if (!printable) control++;
  }
  return control / sample.length > 0.1;
}

/**
 * Run the three safety scanners over every non-binary file in a fetched skill
 * EXCEPT SKILL.md (staticChecks already covers that). Returns failed Checks named
 * from SAFETY_LINTS so the install hard-gate and the remote-exec exemption apply,
 * with the offending file in the detail. A symlink is itself flagged — it can point
 * anywhere and cpSync copies it verbatim.
 */
function scanSkillFiles(dir: string): Check[] {
  const out: Check[] = [];
  for (const { path: rel, symlink } of walk(dir, "")) {
    if (rel === "SKILL.md") continue;
    if (symlink) {
      out.push({ name: "visible-text", ok: false, detail: `symlink at ${rel} — points outside the reviewed files` });
      continue;
    }
    const buf = readFileSync(join(dir, rel));
    if (looksBinary(buf)) continue;
    // NULs are stripped rather than honored: they render as nothing, so
    // `cu\0rl … | sh` reads as curl|sh to everything downstream and must to the
    // scanners too. A NUL in an otherwise-textual file is itself hidden text.
    const raw = buf.toString("utf8");
    const text = raw.replace(/\0/g, "");
    if (text !== raw) out.push({ name: "visible-text", ok: false, detail: `${rel}: NUL byte(s) inside a text file — characters a reviewer cannot see` });
    const invisible = invisibleRuns(text);
    if (invisible.length) out.push({ name: "visible-text", ok: false, detail: `${rel}: invisible characters (${invisible.join(", ")})` });
    if (text.match(DYNAMIC_CONTEXT_RE)) out.push({ name: "dynamic-context", ok: false, detail: `${rel}: command substitution that runs at load time` });
    const remote = remoteExecHits(text);
    if (remote.length) out.push({ name: "remote-exec", ok: false, detail: `${rel}: download-and-execute pipeline (${remote.join(", ")})` });
    const secrets = secretHits(text);
    if (secrets.length) out.push({ name: "secrets", ok: false, detail: `${rel}: hardcoded credential (${secrets.join(", ")})` });
  }
  return out;
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
    // An empty set vacuously passes — matches compile/list, so CI scripting is consistent.
    console.log("no skills installed — nothing to test.");
    return 0;
  }

  const { failed, warned } = reportChecks(skills);

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

export async function cmdLint(args: string[]): Promise<number> {
  const strict = args.includes("--strict");
  const target = args.find((a) => !a.startsWith("-"));
  const root = process.cwd();

  let skills: LoadedSkill[];
  let cleanup: string | undefined;
  if (target) {
    const loaded = loadSkillTarget(target, root);
    if (!loaded) return 1;
    skills = [loaded.skill];
    cleanup = loaded.cleanup;
  } else {
    skills = loadInstalledSkills(root);
    if (!skills.length) {
      // Empty set vacuously passes (matches compile/test); pass a path to lint an uninstalled skill.
      console.log("no skills installed — nothing to lint (pass a path to lint an uninstalled skill).");
      return 0;
    }
  }

  try {
    const { failed, warned } = reportChecks(skills);
    console.log(`\nlinted ${skills.length} skill(s) · ${failed} failure(s) · ${warned} warning(s)`);
    if (failed) return 1;
    if (strict && warned) {
      console.error(`--strict: failing on ${warned} warning(s)`);
      return 1;
    }
    return 0;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

/** Run staticChecks over each skill, print the per-check report, return totals. */
function reportChecks(skills: LoadedSkill[]): { failed: number; warned: number } {
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
  return { failed, warned };
}

export async function cmdExplain(args: string[]): Promise<number> {
  const target = args[0];
  const adapterName = args[1];
  if (!target || !adapterName) {
    console.error("usage: kitbash explain <skill-name-or-path-or-source> <adapter>");
    console.error(`  adapters: ${ADAPTERS.map((a) => a.id).join(", ")}`);
    return 1;
  }
  const root = process.cwd();

  const loaded = loadSkillTarget(target, root);
  if (!loaded) return 1;
  const { skill, cleanup } = loaded;
  try {
    const adapter = ADAPTERS.find((a) => a.id === adapterName);
    if (!adapter) {
      console.error(`unknown adapter "${adapterName}". known: ${ADAPTERS.map((a) => a.id).join(", ")}`);
      return 1;
    }

    const skillName = skill.manifest.skill.name;
    // Target-specific constraints first: a skill the target refuses to load at all
    // makes "no capability degradation" a true statement that reads as a false one.
    const rejected = adapter.lint?.(skill) ?? [];
    for (const r of rejected) console.log(`✗ ${r}`);

    const missing = skill.manifest.targets.requires.filter((r) => !adapter.capabilities.includes(r));
    if (!missing.length) {
      console.log(`${skillName} → ${adapterName}: no capability degradation`);
    } else {
      console.log(`${skillName} → ${adapterName}: degraded`);
      for (const cap of missing) {
        console.log(`  ✗ requires "${cap}" — not supported by ${adapterName}; compiled instruction-only`);
      }
    }
    if (adapter.loading === "eager" && skill.manifest.context.disclosure === "lazy") {
      let body: string;
      try {
        body = resolveBody(skill);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      console.log(`  ⚠ loading: ${adapterName} is eager — skill costs ~${estimateTokens(body)} tokens standing every session (declared limit: ${skill.manifest.context.standing})`);
    }
    return 0;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

export async function cmdPreview(args: string[]): Promise<number> {
  const target = args.find((a) => !a.startsWith("-"));
  if (!target) {
    console.error("usage: kitbash preview <skill-name-or-path-or-source>");
    return 1;
  }
  const root = process.cwd();

  const loaded = loadSkillTarget(target, root);
  if (!loaded) return 1;
  const { skill, cleanup } = loaded;
  try {
    let body: string;
    try {
      body = resolveBody(skill);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }

    const { name, version } = skill.manifest.skill;
    console.log(`preview: ${name}@${version}\n`);
    // Preview must show what compile emits, incl. the compiled permissions note,
    // so its token numbers match `compile` and the benchmark for the same skill.
    body = body + permissionsNote(skill.manifest);

    // Mirror compile: a bad [project].targets is an error, not a silent fall back
    // to every adapter (which would preview output the repo will never generate).
    const adaptersOrError = configuredAdapters(root);
    if (typeof adaptersOrError === "string") {
      console.error(adaptersOrError);
      return 1;
    }
    const adapters = adaptersOrError;

    for (const adapter of adapters) {
      const out = adapter.emit(skill, body, root);
      const bodyTokens = out.files.reduce((sum, f) => sum + estimateTokens(f.content), 0);
      const standingLabel = adapter.loading === "eager" ? `~${bodyTokens} tok standing` : `lazy (0 tok standing)`;
      console.log(`─── ${adapter.id} [${adapter.loading}] ${standingLabel} ───`);
      for (const w of out.warnings) console.log(`⚠ ${w}`);
      for (const n of out.notes ?? []) console.log(`ℹ ${n}`);
      for (const f of out.files) {
        console.log(`\n  → ${f.path}\n`);
        console.log(f.content);
      }
    }
    return 0;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

/**
 * A prose permissions block compiled into every target's output when a skill
 * declares anything beyond the defaults (tools=[], network=false, write=false).
 * Not native enforcement — the KSF tool grammar ("bash:git *") is provisional and
 * differs from each agent's own syntax — but it travels with the compiled file so a
 * reader who never ran install still sees the declared limits (spec §2).
 */
function permissionsNote(m: LoadedSkill["manifest"]): string {
  const p = m.permissions;
  if (!p.tools.length && !p.network && !p.write) return "";
  const lines: string[] = [];
  if (p.tools.length) lines.push(`Permitted tools: ${p.tools.join(", ")}.`);
  lines.push(`Network access: ${p.network ? "allowed" : "denied"}.`);
  lines.push(`File writes: ${p.write ? "allowed" : "denied"}.`);
  return `\n\n---\n\n**Declared permissions (kitbash).** ${lines.join(" ")} Operate within these unless the user explicitly overrides.\n`;
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
const MANAGED_SHARED_FILES = ["AGENTS.md", "GEMINI.md", "CONVENTIONS.md"];

const MANAGED_DIRS: { dir: string; suffix: string; wholeDir?: boolean }[] = [
  { dir: ".claude/skills", suffix: "/SKILL.md", wholeDir: true },
  { dir: ".claude/commands", suffix: ".md" },
  { dir: ".agents/skills", suffix: "/SKILL.md", wholeDir: true },
  { dir: ".gemini/skills", suffix: "/SKILL.md", wholeDir: true },
  { dir: ".github/skills", suffix: "/SKILL.md", wholeDir: true },
  { dir: ".cursor/rules", suffix: ".mdc" },
  { dir: ".clinerules", suffix: ".md" },
  { dir: ".windsurf/rules", suffix: ".md" },
  { dir: ".devin/rules", suffix: ".md" },
  { dir: ".github/instructions", suffix: ".instructions.md" },
];

/**
 * The managed paths a skill of this name would own. Used to protect the output of
 * a skill that failed to load this run: it is still installed, so its generated
 * files are current, not stale.
 */
function managedPathsFor(name: string): string[] {
  return MANAGED_DIRS.map((loc) => `${loc.dir}/${name}${loc.suffix}`);
}

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
        if (loc.wholeDir) {
          // Remove only the generated SKILL.md, then the directory ONLY if it is now
          // empty — never rmSync the whole dir, which would take a user file colocated
          // there (a NOTES.md, a hand-added script) along with it.
          rmSync(marker);
          if (readdirSync(removeTarget).length === 0) rmSync(removeTarget, { recursive: true });
        } else {
          rmSync(removeTarget);
        }
        pruned.push(`removed ${loc.wholeDir ? rel : rel} (stale)`);
      }
    }
  }
  return pruned;
}
