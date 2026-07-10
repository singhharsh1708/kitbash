#!/usr/bin/env node
/**
 * kitbash — the package manager and compiler for AI agent skills.
 *
 * Zero-runtime-dependency CLI. Command implementations land per the roadmap
 * (docs/roadmap.md); this skeleton fixes the command surface so docs, spec,
 * and implementation grow against the same interface.
 */

const VERSION = "0.0.1";

type Command = {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
};

function todo(name: string, milestone: string) {
  return async (_args: string[]): Promise<number> => {
    console.error(`kitbash ${name}: not implemented yet (lands in ${milestone} — see docs/roadmap.md)`);
    return 2;
  };
}

const commands: Command[] = [
  { name: "init", summary: "Set up kitbash in this repository (kitbash.toml)", run: todo("init", "v0.1") },
  { name: "install", summary: "Install a skill: gh:owner/repo, file:path, or an index short name", run: todo("install", "v0.1") },
  { name: "remove", summary: "Remove an installed skill", run: todo("remove", "v0.1") },
  { name: "list", summary: "List installed skills with versions and context cost", run: todo("list", "v0.1") },
  { name: "compile", summary: "Emit native formats for every detected assistant", run: todo("compile", "v0.1") },
  { name: "doctor", summary: "Detect assistants, report total standing context cost", run: todo("doctor", "v0.1") },
  { name: "update", summary: "Update skills, showing instruction diffs before applying", run: todo("update", "v0.2") },
  { name: "lint", summary: "Schema, context budgets, dead references, injection heuristics", run: todo("lint", "v0.2") },
  { name: "test", summary: "Run a skill's evals (static, audit, behavioral tiers)", run: todo("test", "v0.3") },
  { name: "gate", summary: "Run a gate-mode skill with a deterministic exit code", run: todo("gate", "v0.3") },
  { name: "search", summary: "Search the community index", run: todo("search", "v0.4") },
  { name: "publish", summary: "Validate and publish a skill to the index", run: todo("publish", "v0.4") },
  { name: "lore", summary: "Build, query, and curate repo intelligence", run: todo("lore", "v0.5") },
  { name: "run", summary: "Run a declared pipeline (e.g. kitbash run ship)", run: todo("run", "v0.5") },
];

function usage(): void {
  console.log(`kitbash ${VERSION} — write a skill once, run it in every coding agent\n`);
  console.log("Usage: kitbash <command> [args]\n");
  const pad = Math.max(...commands.map((c) => c.name.length));
  for (const c of commands) {
    console.log(`  ${c.name.padEnd(pad)}  ${c.summary}`);
  }
  console.log("\nDocs: https://github.com/singhharsh1708/kitbash");
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  const command = commands.find((c) => c.name === cmd);
  if (!command) {
    console.error(`kitbash: unknown command "${cmd}"\n`);
    usage();
    return 1;
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
