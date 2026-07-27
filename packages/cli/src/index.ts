#!/usr/bin/env node
/**
 * kitbash — the package manager and compiler for AI agent skills.
 *
 * Zero-runtime-dependency CLI. Command implementations land per the roadmap
 * (docs/roadmap.md); this skeleton fixes the command surface so docs, spec,
 * and implementation grow against the same interface.
 */

import { createRequire } from "node:module";
import { cmdCompile, cmdDoctor, cmdInit, cmdInstall, cmdList, cmdRemove, cmdTest, cmdLint, cmdExplain, cmdPreview } from "./commands.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

type Command = {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
  /** Listed for shape, not yet implemented — surfaced separately in help. */
  planned?: boolean;
};

function todo(name: string) {
  return async (_args: string[]): Promise<number> => {
    console.error(`kitbash ${name}: not implemented yet — planned, see the roadmap:`);
    console.error("  https://github.com/singhharsh1708/kitbash/blob/main/docs/roadmap.md");
    return 7; // reserved exit code for a recognized-but-unbuilt command
  };
}

const commands: Command[] = [
  { name: "init", summary: "Set up kitbash in this repository (kitbash.toml)", run: cmdInit },
  { name: "install", summary: "Install a skill with pre-install review: gh:owner/repo[/path][@ref], owner/repo, or file:path (--yes; [policy] enforced)", run: cmdInstall },
  { name: "remove", summary: "Remove an installed skill", run: cmdRemove },
  { name: "list", summary: "List installed skills with versions and context cost", run: cmdList },
  { name: "compile", summary: "Emit native formats for every detected assistant (--strict)", run: cmdCompile },
  { name: "doctor", summary: "Detect assistants, report total standing context cost", run: cmdDoctor },
  { name: "lint", summary: "Static checks: schema, budgets, dead refs, safety lints (--strict; name, path, or uninstalled source)", run: cmdLint },
  { name: "preview", summary: "Render each target's output with per-agent token counts — works on uninstalled sources", run: cmdPreview },
  { name: "explain", summary: "Why a compilation degraded on a given target (name, path, or uninstalled source)", run: cmdExplain },
  { name: "test", summary: "Run a skill's static evals (schema, budgets, dead refs, safety lints; --strict)", run: cmdTest },
  { name: "update", summary: "Update skills, showing instruction diffs before applying", run: todo("update"), planned: true },
  { name: "diff", summary: "Instruction/permission/budget diff between two skill versions", run: todo("diff"), planned: true },
  { name: "audit", summary: "Scan installed skills: permission drift, unsigned sources", run: todo("audit"), planned: true },
  { name: "gate", summary: "Run a gate-mode skill with a deterministic exit code", run: todo("gate"), planned: true },
  { name: "search", summary: "Search the community index", run: todo("search"), planned: true },
  { name: "publish", summary: "Validate and publish a skill to the index", run: todo("publish"), planned: true },
  { name: "lore", summary: "Build, query, and curate repo intelligence", run: todo("lore"), planned: true },
  { name: "run", summary: "Run a declared pipeline (e.g. kitbash run ship)", run: todo("run"), planned: true },
];

const HELP_FOOTER = "\nGlobal: kitbash --version · kitbash --help · kitbash help <command>\nDocs: https://kitbash.vercel.app/docs";

function usage(out: (s: string) => void = console.log): void {
  out(`kitbash ${VERSION} — write a skill once, run it in every coding agent\n`);
  out("Usage: kitbash <command> [args]\n");
  const working = commands.filter((c) => !c.planned);
  const planned = commands.filter((c) => c.planned);
  const pad = Math.max(...commands.map((c) => c.name.length));
  for (const c of working) out(`  ${c.name.padEnd(pad)}  ${c.summary}`);
  if (planned.length) {
    out("\nPlanned (not yet implemented):");
    for (const c of planned) out(`  ${c.name.padEnd(pad)}  ${c.summary}`);
  }
  out(HELP_FOOTER);
}

/** Nearest command name within edit distance 2, for did-you-mean. */
function nearestCommand(input: string): string | undefined {
  const dist = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  let best: { name: string; d: number } | undefined;
  for (const c of commands) {
    const d = dist(input, c.name);
    if (!best || d < best.d) best = { name: c.name, d };
  }
  return best && best.d <= 2 ? best.name : undefined;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    // `kitbash help <command>` prints that command's summary.
    const topic = cmd === "help" ? args[0] : undefined;
    if (topic) {
      const c = commands.find((x) => x.name === topic);
      if (c) {
        console.log(`kitbash ${c.name}${c.planned ? " (planned — not yet implemented)" : ""}\n  ${c.summary}`);
        return 0;
      }
      console.error(`kitbash: no such command "${topic}"`);
      return 2;
    }
    usage();
    return 0;
  }
  if (cmd === "--version") {
    console.log(VERSION);
    return 0;
  }
  const command = commands.find((c) => c.name === cmd);
  if (!command) {
    console.error(`kitbash: unknown command "${cmd}"`);
    const near = nearestCommand(cmd);
    if (near) console.error(`  did you mean "${near}"?`);
    console.error("  run 'kitbash help' to see all commands.");
    return 2;
  }
  // Per-command help: `kitbash install --help`.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`kitbash ${command.name}${command.planned ? " (planned — not yet implemented)" : ""}\n  ${command.summary}`);
    return 0;
  }
  return command.run(args);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
