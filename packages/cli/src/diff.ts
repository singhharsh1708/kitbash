/**
 * Skill-to-skill comparison for `kitbash diff` and `kitbash update`: manifest
 * field deltas, changed-file detection, and a line-level unified diff. The
 * v0.2 exit criterion lives here — no skill's instructions change on disk
 * without a human being able to see exactly what changed.
 */

import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { walk } from "./lock.js";
import type { SkillManifest } from "./ksf.js";

/**
 * Field-level manifest changes as printable `field: old → new` lines.
 * Permission escalations (new tools, network/write flipping on, budget growth)
 * carry a ⚠ marker — those are the changes an update review exists to catch.
 */
export function manifestDelta(a: SkillManifest, b: SkillManifest): string[] {
  const out: string[] = [];
  const field = (name: string, av: string, bv: string, escalation = false) => {
    if (av !== bv) out.push(`${name}: ${av} → ${bv}${escalation ? "  ⚠ escalation" : ""}`);
  };
  const yn = (v: boolean) => (v ? "YES" : "no");
  const list = (v: string[]) => (v.length ? v.join(", ") : "none");

  field("version", a.skill.version, b.skill.version);
  field("description", JSON.stringify(a.skill.description), JSON.stringify(b.skill.description));
  field("budget", `${a.context.budget} tok`, `${b.context.budget} tok`, b.context.budget > a.context.budget);
  field("standing", `${a.context.standing} tok/session`, `${b.context.standing} tok/session`, b.context.standing > a.context.standing);
  field("disclosure", a.context.disclosure, b.context.disclosure, a.context.disclosure === "lazy" && b.context.disclosure === "eager");
  field("mode", a.targets.mode, b.targets.mode);
  field("permissions.network", yn(a.permissions.network), yn(b.permissions.network), !a.permissions.network && b.permissions.network);
  field("permissions.write", yn(a.permissions.write), yn(b.permissions.write), !a.permissions.write && b.permissions.write);
  const addedTools = b.permissions.tools.filter((t) => !a.permissions.tools.includes(t));
  field("permissions.tools", list(a.permissions.tools), list(b.permissions.tools), addedTools.length > 0);
  field("requires", list(a.targets.requires), list(b.targets.requires));
  field("commands", list(a.triggers.commands), list(b.triggers.commands));
  field("events", list(a.triggers.events), list(b.triggers.events));
  field("artifacts.produces", list(a.artifacts.produces), list(b.artifacts.produces));
  field("artifacts.consumes", list(a.artifacts.consumes), list(b.artifacts.consumes));
  const depstr = (d: Record<string, string>) => list(Object.entries(d).map(([k, v]) => `${k}@${v}`));
  field("dependencies", depstr(a.dependencies), depstr(b.dependencies));
  out.push(...mcpDelta(a, b));
  return out;
}

/**
 * MCP changes, reported server by server rather than as one diffed blob.
 *
 * A version that adds an MCP server is the largest escalation a skill can make:
 * it is asking to run a new program with the agent's permissions, which outranks
 * `permissions.network: no → YES`. Just as important and easier to miss, a
 * server that keeps its name while its `command`, `args` or `url` change is the
 * rug-pull shape — the thing you approved is not the thing that will run. Both
 * are marked as escalations so neither passes an update review unseen.
 */
function mcpDelta(a: SkillManifest, b: SkillManifest): string[] {
  const out: string[] = [];
  const before = new Map(a.mcp.servers.map((s) => [s.name, s]));
  const after = new Map(b.mcp.servers.map((s) => [s.name, s]));
  // What will actually run — the identity that matters for review.
  const runs = (s: { transport: string; command?: string; args: string[]; url?: string }) =>
    s.transport === "stdio" ? [s.command ?? "", ...s.args].join(" ").trim() : (s.url ?? "");

  for (const [name, s] of after) {
    const prev = before.get(name);
    if (!prev) {
      out.push(`mcp.servers.${name}: (absent) → ${s.transport} ${runs(s)}  ⚠ escalation — a new MCP server will run with your agent's permissions`);
      continue;
    }
    if (runs(prev) !== runs(s)) {
      out.push(`mcp.servers.${name}: ${runs(prev)} → ${runs(s)}  ⚠ escalation — same server name, different program`);
    }
    if (prev.transport !== s.transport) out.push(`mcp.servers.${name}.transport: ${prev.transport} → ${s.transport}`);
    const widened = s.tools.includes("*") ? !prev.tools.includes("*") : s.tools.some((t) => !prev.tools.includes(t));
    if (JSON.stringify(prev.tools) !== JSON.stringify(s.tools)) {
      out.push(`mcp.servers.${name}.tools: ${prev.tools.join(", ") || "none"} → ${s.tools.join(", ") || "none"}${widened ? "  ⚠ escalation — the tool allowlist grew" : ""}`);
    }
    // A new env or header key is a new value handed to third-party code.
    const newKeys = [...Object.keys(s.env), ...Object.keys(s.headers)].filter((k) => !(k in prev.env) && !(k in prev.headers));
    if (newKeys.length) out.push(`mcp.servers.${name}: new env/header ${newKeys.join(", ")}  ⚠ escalation — a new value is passed to this server`);
  }
  for (const name of before.keys()) if (!after.has(name)) out.push(`mcp.servers.${name}: removed`);
  return out;
}

export interface FileChange {
  path: string;
  kind: "added" | "removed" | "modified";
  /** Binary or symlink — listed, never line-diffed. */
  opaque: boolean;
}

/** Read an entry for comparison: symlinks compare by target, binaries verbatim, text CRLF-normalized. */
function contentOf(dir: string, rel: string, symlink: boolean): { text: string | null; raw: Buffer } {
  if (symlink) {
    const target = readlinkSync(join(dir, rel));
    return { text: null, raw: Buffer.from(`symlink → ${target}`) };
  }
  const raw = readFileSync(join(dir, rel));
  if (raw.includes(0)) return { text: null, raw }; // NUL byte ⇒ binary
  return { text: raw.toString("utf8").replace(/\r\n/g, "\n"), raw };
}

/** Compare two skill directories file-by-file, in the lockfile's walk order. */
export function fileChanges(dirA: string, dirB: string): FileChange[] {
  const aEntries = new Map(walk(dirA, "").map((e) => [e.path, e.symlink]));
  const bEntries = new Map(walk(dirB, "").map((e) => [e.path, e.symlink]));
  const out: FileChange[] = [];
  for (const [rel, aLink] of aEntries) {
    if (!bEntries.has(rel)) {
      out.push({ path: rel, kind: "removed", opaque: aLink || contentOf(dirA, rel, aLink).text === null });
      continue;
    }
    const a = contentOf(dirA, rel, aLink);
    const b = contentOf(dirB, rel, bEntries.get(rel)!);
    if (a.text !== null && b.text !== null ? a.text !== b.text : !a.raw.equals(b.raw)) {
      out.push({ path: rel, kind: "modified", opaque: a.text === null || b.text === null });
    }
  }
  for (const [rel, bLink] of bEntries) {
    if (!aEntries.has(rel)) out.push({ path: rel, kind: "added", opaque: bLink || contentOf(dirB, rel, bLink).text === null });
  }
  return out;
}

/** Text of a file in a skill dir, normalized the way fileChanges compares it ("" for a side that lacks it). */
export function textOf(dir: string, rel: string): string {
  const entry = walk(dir, "").find((e) => e.path === rel);
  if (!entry) return "";
  return contentOf(dir, rel, entry.symlink).text ?? "";
}

type Op = { tag: " " | "-" | "+"; line: string };

/**
 * Unified diff between two texts. Returns "" when identical. LCS on the lines
 * between the common prefix and suffix; if that middle region is degenerate
 * (over ~4M DP cells — no skill body is), it falls back to one whole-block
 * replace hunk rather than an O(n·m) table.
 */
export function unifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string, context = 3): string {
  if (aText === bText) return "";
  const a = splitLines(aText);
  const b = splitLines(bText);

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;

  const aMid = a.slice(pre, a.length - post);
  const bMid = b.slice(pre, b.length - post);

  const ops: Op[] = a.slice(0, pre).map((line) => ({ tag: " " as const, line }));
  if (aMid.length * bMid.length > 4_000_000) {
    for (const line of aMid) ops.push({ tag: "-", line });
    for (const line of bMid) ops.push({ tag: "+", line });
  } else {
    ops.push(...lcsOps(aMid, bMid));
  }
  ops.push(...a.slice(a.length - post).map((line) => ({ tag: " " as const, line })));

  return renderHunks(ops, aLabel, bLabel, context);
}

/**
 * Newline-terminated lines: "a\n" is one line, "" is zero. The presence of a
 * final newline is not tracked — for reviewing markdown instructions the
 * distinction is noise, and rendering it would put a bare "+"/"-" on every diff.
 */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // len[i][j] = LCS length of a[i..] and b[j..], flattened row-major.
  const len = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * (m + 1) + j] =
        a[i] === b[j] ? len[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(len[(i + 1) * (m + 1) + j]!, len[i * (m + 1) + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i]! });
      i++;
      j++;
    } else if (len[(i + 1) * (m + 1) + j]! >= len[i * (m + 1) + j + 1]!) {
      ops.push({ tag: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ tag: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ tag: "-", line: a[i++]! });
  while (j < m) ops.push({ tag: "+", line: b[j++]! });
  return ops;
}

function renderHunks(ops: Op[], aLabel: string, bLabel: string, context: number): string {
  // Indices of changed ops; hunks group changes whose gaps are ≤ 2·context.
  const changed = ops.map((op, idx) => (op.tag !== " " ? idx : -1)).filter((idx) => idx >= 0);
  if (!changed.length) return "";

  const hunks: { start: number; end: number }[] = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length, changed[0]! + context + 1);
  for (const idx of changed.slice(1)) {
    if (idx - context <= end) {
      end = Math.min(ops.length, idx + context + 1);
    } else {
      hunks.push({ start, end });
      start = Math.max(0, idx - context);
      end = Math.min(ops.length, idx + context + 1);
    }
  }
  hunks.push({ start, end });

  const lines: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];
  // Running old/new line numbers as we pass over ops.
  let aLine = 1;
  let bLine = 1;
  let cursor = 0;
  for (const h of hunks) {
    for (; cursor < h.start; cursor++) {
      const t = ops[cursor]!.tag;
      if (t !== "+") aLine++;
      if (t !== "-") bLine++;
    }
    const slice = ops.slice(h.start, h.end);
    const aCount = slice.filter((o) => o.tag !== "+").length;
    const bCount = slice.filter((o) => o.tag !== "-").length;
    lines.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (; cursor < h.end; cursor++) {
      const op = ops[cursor]!;
      lines.push(`${op.tag}${op.line}`);
      if (op.tag !== "+") aLine++;
      if (op.tag !== "-") bLine++;
    }
  }
  return lines.join("\n");
}
