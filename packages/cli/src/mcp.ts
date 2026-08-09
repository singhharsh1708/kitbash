/**
 * MCP (Model Context Protocol) server declarations.
 *
 * A skill can declare the MCP servers it needs; `compile` writes those into the
 * native configuration each agent reads. Two things make this different from
 * every other thing Kitbash compiles, and both shape the code below.
 *
 * 1. **A declared MCP server is arbitrary third-party code the user will run.**
 *    It is a heavier request than anything in a SKILL.md body, so it is gated at
 *    install like one: the lints here are hard failures, not warnings.
 *
 * 2. **Most targets cannot honor it.** Of the eleven compile targets, only three
 *    have a dedicated, project-scoped, primary-source-confirmed config file.
 *    The rest either have no MCP mechanism at all (aider, agentsmd), no project
 *    scope (cline, windsurf), or need a merge into a shared settings file that
 *    also holds unrelated user config (zed, gemini). Emitting a plausible-looking
 *    file for those would produce something that reads as configured and does
 *    nothing — the exact silent failure Kitbash exists to prevent. They get a
 *    typed warning naming the reason instead, and no file.
 *
 * Client config dialects genuinely disagree (the HTTP transport is spelled
 * `streamable-http` by Agent Plugins, `http` by Claude Code and Copilot; timeouts
 * are ms in some clients and seconds in others), so the manifest field is
 * `transport` and every emitter TRANSLATES. Nothing is passed through verbatim.
 */

import type { LoadedSkill } from "./ksf.js";
import type { TomlTable } from "./toml.js";

/** The MCP spec's transport identifiers — the manifest's vocabulary, not any one client's. */
export type McpTransport = "stdio" | "streamable-http" | "sse";

export interface McpServer {
  /** server name as declared: [mcp.servers.<name>] */
  name: string;
  transport: McpTransport;
  /** stdio: a single executable token (no shell string) */
  command?: string;
  args: string[];
  /** streamable-http / sse */
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Deny-by-default tool allowlist. Required — see mcpLints. `["*"]` is legal but loud. */
  tools: string[];
  timeoutMs?: number;
}

export interface McpConfig {
  servers: McpServer[];
  /** How a target that cannot honor the declaration behaves. No "skip": that would be silent degradation. */
  onUnsupported: "warn" | "error";
}

/** A `${VAR}` reference — the only way a secret may appear in a manifest. */
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** A whole value that is exactly one reference. */
const WHOLE_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function hasRef(v: string): boolean {
  REF_RE.lastIndex = 0;
  return REF_RE.test(v);
}

/** Every `${VAR}` name mentioned anywhere in a server declaration. */
export function refsOf(s: McpServer): string[] {
  const out = new Set<string>();
  const scan = (v: string) => {
    for (const m of v.matchAll(REF_RE)) out.add(m[1]!);
  };
  if (s.command) scan(s.command);
  s.args.forEach(scan);
  if (s.url) scan(s.url);
  Object.values(s.env).forEach(scan);
  Object.values(s.headers).forEach(scan);
  return [...out].sort();
}

const TRANSPORTS: McpTransport[] = ["stdio", "streamable-http", "sse"];
/** Server names become JSON object keys and appear in tool ids — keep them boring. */
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function strMap(t: TomlTable, key: string): Record<string, string> {
  const v = t[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as TomlTable)) if (typeof val === "string") out[k] = val;
  return out;
}

/**
 * Read `[mcp]` out of a parsed manifest. Shape problems are reported by mcpLints
 * rather than thrown here: a malformed declaration should surface as a readable
 * lint failure at install, not a parse error with no context.
 */
export function parseMcp(raw: TomlTable): McpConfig {
  const mcp = raw["mcp"];
  const empty: McpConfig = { servers: [], onUnsupported: "warn" };
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return empty;
  const table = mcp as TomlTable;
  const serversRaw = table["servers"];
  const onUnsupported = table["on_unsupported"] === "error" ? "error" : "warn";
  if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) return { servers: [], onUnsupported };

  const servers: McpServer[] = [];
  for (const [name, defRaw] of Object.entries(serversRaw as TomlTable)) {
    if (!defRaw || typeof defRaw !== "object" || Array.isArray(defRaw)) continue;
    const def = defRaw as TomlTable;
    const transport = typeof def["transport"] === "string" ? (def["transport"] as McpTransport) : ("stdio" as McpTransport);
    const arr = (k: string): string[] => (Array.isArray(def[k]) ? (def[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
    servers.push({
      name,
      transport,
      ...(typeof def["command"] === "string" ? { command: def["command"] as string } : {}),
      args: arr("args"),
      ...(typeof def["url"] === "string" ? { url: def["url"] as string } : {}),
      env: strMap(def, "env"),
      headers: strMap(def, "headers"),
      tools: arr("tools"),
      ...(typeof def["timeout_ms"] === "number" ? { timeoutMs: def["timeout_ms"] as number } : {}),
    });
  }
  servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { servers, onUnsupported };
}

// ── lints ────────────────────────────────────────────────────────────────────

/** Shell metacharacters in an argv element mean someone expects a shell that isn't there. */
const SHELL_META_RE = /[;&|><`$(){}\[\]!*?~\n]/;
/** A version range where an exact pin belongs — the rug-pull surface. */
const UNPINNED_RE = /(?:@latest|@\^|@~|@>=|@>|:latest|@\*)/;
/** Value shapes that are a credential rather than a reference to one. */
const SECRET_SHAPE: { re: RegExp; what: string }[] = [
  { re: /^(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}$/, what: "an API key" },
  { re: /^gh[pousr]_[A-Za-z0-9]{16,}$/, what: "a GitHub token" },
  { re: /^xox[abprs]-[A-Za-z0-9-]{10,}$/, what: "a Slack token" },
  { re: /^AKIA[0-9A-Z]{12,}$/, what: "an AWS access key id" },
  { re: /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: "a JWT" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
];
/** Keys whose value is a credential by name, so a literal there is a leak regardless of shape. */
const SECRET_KEY_RE = /(?:token|secret|password|passwd|api[_-]?key|credential|auth)/i;

/**
 * Hard failures. Every one of these blocks install — an MCP declaration is a
 * request to run third-party code, so "probably fine" is not a category.
 * Returned as messages; the caller renders them as failed checks.
 */
export function mcpLints(cfg: McpConfig): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of cfg.servers) {
    const at = `mcp.servers.${s.name}`;
    if (!SERVER_NAME_RE.test(s.name)) out.push(`${at}: server name must match ${SERVER_NAME_RE}`);
    if (seen.has(s.name.toLowerCase())) out.push(`${at}: duplicate server name (names are case-insensitive across clients)`);
    seen.add(s.name.toLowerCase());

    if (!TRANSPORTS.includes(s.transport)) {
      out.push(`${at}: transport "${s.transport}" must be one of ${TRANSPORTS.join(", ")}`);
      continue;
    }

    // A tool allowlist is required: it is the one field Kitbash cannot synthesize,
    // Copilot marks it required, and deny-by-default is the whole point.
    if (!s.tools.length) out.push(`${at}: tools is required — list the tools this server may expose, or ["*"] to allow all (which the install gate will show prominently)`);

    if (s.transport === "stdio") {
      if (!s.command) out.push(`${at}: stdio transport requires a command`);
      if (s.url) out.push(`${at}: stdio transport must not declare a url`);
      if (s.command && /\s/.test(s.command)) out.push(`${at}: command must be a single executable, not a shell string — put arguments in args`);
      if (s.command && SHELL_META_RE.test(s.command)) out.push(`${at}: command contains shell metacharacters; it is executed directly, with no shell`);
      for (const a of s.args) {
        if (SHELL_META_RE.test(a) && !hasRef(a)) out.push(`${at}: arg "${a}" contains shell metacharacters; args are passed directly, with no shell`);
        if (UNPINNED_RE.test(a)) out.push(`${at}: arg "${a}" is not pinned to an exact version — an unpinned server can change under you between runs`);
      }
    } else {
      if (!s.url) out.push(`${at}: ${s.transport} transport requires a url`);
      if (s.command) out.push(`${at}: ${s.transport} transport must not declare a command`);
      if (s.url) out.push(...urlLints(at, s.url));
    }

    if (s.timeoutMs !== undefined && (!Number.isInteger(s.timeoutMs) || s.timeoutMs <= 0)) out.push(`${at}: timeout_ms must be a positive integer`);

    out.push(...secretLints(at, "env", s.env));
    out.push(...secretLints(at, "headers", s.headers));
  }
  return out;
}

function urlLints(at: string, url: string): string[] {
  const out: string[] = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [`${at}: url "${url}" is not a valid absolute URL`];
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") out.push(`${at}: url scheme "${u.protocol}" is not allowed — use https (or http on loopback)`);
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]";
  if (u.protocol === "http:" && !loopback) out.push(`${at}: url uses plain http off-loopback — credentials and tool traffic would cross the network in the clear`);
  // Credentials in the URL leak into process lists, logs and config files.
  if (u.username || u.password) out.push(`${at}: url must not embed credentials (user:password@) — use headers with a \${VAR} reference`);
  return out;
}

/**
 * A secret must be a `${VAR}` reference, never a literal. Two ways to be wrong:
 * the value looks like a credential, or the key says it is one and the value is
 * not a reference.
 */
function secretLints(at: string, where: string, map: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    for (const { re, what } of SECRET_SHAPE) {
      if (re.test(v)) {
        out.push(`${at}: ${where}.${k} looks like ${what} committed in plain text — use a \${VAR} reference instead`);
        break;
      }
    }
    if (SECRET_KEY_RE.test(k) && v && !hasRef(v)) {
      out.push(`${at}: ${where}.${k} is named as a credential but holds a literal — use a \${VAR} reference so nothing secret is committed`);
    }
  }
  return out;
}

/** Non-fatal notes worth showing at the trust gate. */
export function mcpWarnings(cfg: McpConfig): string[] {
  const out: string[] = [];
  for (const s of cfg.servers) {
    if (s.tools.includes("*")) out.push(`mcp.servers.${s.name}: tools = ["*"] — every tool this server exposes is allowed, including ones added in a later version`);
  }
  return out;
}

// ── emitters ─────────────────────────────────────────────────────────────────

/** Why a target gets no MCP output. Typed so the message is specific, not "unsupported". */
export type UnsupportedReason = "no-mcp-surface" | "no-project-scope" | "unconfirmed-path" | "needs-shared-file-merge";

const UNSUPPORTED: Record<string, { reason: UnsupportedReason; detail: string }> = {
  aider: { reason: "no-mcp-surface", detail: "aider has no MCP mechanism; CONVENTIONS.md is prose with no configuration" },
  agentsmd: { reason: "no-mcp-surface", detail: "AGENTS.md is a prose instruction file with no configuration mechanism" },
  agents: { reason: "unconfirmed-path", detail: "the vendor-neutral .agents/ convention has no confirmed MCP file; the only candidate is a third-party draft no client reads" },
  cline: { reason: "no-project-scope", detail: "Cline's MCP settings are global-only, so a repo-committed declaration cannot represent them" },
  windsurf: { reason: "no-project-scope", detail: "Windsurf/Devin documents only a user-global MCP config, and its documented page covers the legacy agent" },
  zed: { reason: "needs-shared-file-merge", detail: "Zed keeps MCP servers in .zed/settings.json alongside unrelated user settings; merging into it needs its own consent path" },
  gemini: { reason: "needs-shared-file-merge", detail: "Gemini keeps MCP servers in .gemini/settings.json alongside unrelated user settings; merging into it needs its own consent path" },
  cursor: { reason: "needs-shared-file-merge", detail: "Cursor's .cursor/mcp.json cannot express a tools allowlist, so a declaration would be silently widened" },
};

export interface McpEmit {
  files: { path: string; content: string }[];
  warnings: string[];
}

/**
 * Emit the MCP configuration for one target, given every declared server across
 * all installed skills. Returns no files (and a specific warning) for targets
 * that cannot honor a declaration.
 */
export function emitMcp(targetId: string, servers: McpServer[], pluginRoot: string): McpEmit {
  if (!servers.length) return { files: [], warnings: [] };

  const un = UNSUPPORTED[targetId];
  if (un) {
    return {
      files: [],
      warnings: [`${targetId}: cannot honor ${plural(servers.length)} (${un.reason}) — ${un.detail}. Nothing was written; configure ${servers.length === 1 ? "it" : "them"} in that client directly.`],
    };
  }

  switch (targetId) {
    case "agent-plugins":
      return emitAgentPlugins(servers, pluginRoot);
    case "claude-code":
      return emitClaudeCode(servers);
    case "copilot":
      return emitCopilot(servers);
    default:
      return { files: [], warnings: [] };
  }
}

function plural(n: number): string {
  return `${n} declared MCP server${n === 1 ? "" : "s"}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Agent Plugins v1.0 — `<plugin-root>/mcp.json`. The schema is closed
 * (`additionalProperties: false`, `$schema` is a const), so only the two
 * top-level keys may appear and the version must be byte-exact.
 *
 * The spec defines no credential reference and performs no variable expansion,
 * so a server needing a `${VAR}` is not expressible here: it is omitted with a
 * warning rather than emitted with the reference inert (which would look
 * configured and fail at run time) or the literal inlined (which would commit
 * a secret).
 */
export const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function emitAgentPlugins(servers: McpServer[], pluginRoot: string): McpEmit {
  const warnings: string[] = [];
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    const refs = refsOf(s);
    if (refs.length) {
      warnings.push(
        `agent-plugins: skipped MCP server "${s.name}" — it references ${refs.map((r) => `\${${r}}`).join(", ")}, and the Agent Plugins format defines no credential reference and expands no variables. Emitting it would produce a server that cannot start.`,
      );
      continue;
    }
    const entry: Record<string, unknown> = { type: s.transport };
    if (s.transport === "stdio") {
      entry["command"] = s.command;
      if (s.args.length) entry["args"] = s.args;
      if (Object.keys(s.env).length) entry["env"] = s.env;
    } else {
      entry["url"] = s.url;
      if (Object.keys(s.headers).length) entry["headers"] = s.headers;
    }
    out[s.name] = entry;
  }
  // Fields the format has no home for. Dropping them silently would be the
  // capability loss the spec forbids, so say it once, per field.
  for (const s of servers) {
    if (!refsOf(s).length) {
      if (s.tools.length && !s.tools.includes("*")) warnings.push(`agent-plugins: "${s.name}" declares a tools allowlist, which the Agent Plugins mcp.json has no field for — the client will expose every tool the server offers.`);
      if (s.timeoutMs !== undefined) warnings.push(`agent-plugins: "${s.name}" declares timeout_ms, which the Agent Plugins mcp.json has no field for — dropped.`);
    }
  }
  if (!Object.keys(out).length) return { files: [], warnings };
  return {
    files: [{ path: `${pluginRoot}/mcp.json`, content: json({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: out }) }],
    warnings,
  };
}

/**
 * Claude Code — `.mcp.json` at the project root. `type` is always emitted: a
 * `url` with no `type` is a documented hard error, and a typeless entry is read
 * as stdio. Claude Code's HTTP spelling is `http`, not `streamable-http`.
 */
function emitClaudeCode(servers: McpServer[]): McpEmit {
  const warnings: string[] = [];
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    const entry: Record<string, unknown> = { type: s.transport === "streamable-http" ? "http" : s.transport };
    if (s.transport === "stdio") {
      entry["command"] = s.command;
      if (s.args.length) entry["args"] = s.args;
      if (Object.keys(s.env).length) entry["env"] = s.env;
    } else {
      entry["url"] = s.url;
      if (Object.keys(s.headers).length) entry["headers"] = s.headers;
    }
    out[s.name] = entry;
    if (s.tools.length && !s.tools.includes("*")) {
      warnings.push(`claude-code: "${s.name}" declares a tools allowlist, which .mcp.json has no field for — it belongs in .claude/settings.json permissions, which Kitbash does not write. The allowlist is not enforced here.`);
    }
  }
  if (servers.length) {
    warnings.push(
      "claude-code: a project .mcp.json prompts for approval in an interactive session, but is loaded without any prompt under `claude -p`, the Agent SDK and cloud sessions — in CI, the install gate you just passed is the only review these servers get.",
    );
  }
  return { files: [{ path: ".mcp.json", content: json({ mcpServers: out }) }], warnings };
}

/**
 * GitHub Copilot — `.github/mcp.json`, the repo-committed shared config. `tools`
 * is required here, which is why the manifest requires it too. Copilot's HTTP
 * spelling is `http`.
 */
function emitCopilot(servers: McpServer[]): McpEmit {
  const warnings: string[] = [];
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    const entry: Record<string, unknown> = { type: s.transport === "streamable-http" ? "http" : s.transport };
    if (s.transport === "stdio") {
      entry["command"] = s.command;
      if (s.args.length) entry["args"] = s.args;
      if (Object.keys(s.env).length) entry["env"] = s.env;
    } else {
      entry["url"] = s.url;
      if (Object.keys(s.headers).length) entry["headers"] = s.headers;
    }
    entry["tools"] = s.tools;
    if (s.timeoutMs !== undefined) entry["timeout"] = s.timeoutMs;
    out[s.name] = entry;
  }
  return { files: [{ path: ".github/mcp.json", content: json({ mcpServers: out }) }], warnings };
}

/** Targets that can carry an MCP declaration today, for `doctor` and the docs. */
export const MCP_TARGETS = ["agent-plugins", "claude-code", "copilot"];

/** One line per target explaining its MCP status — the support matrix, printed. */
export function mcpSupportMatrix(): string[] {
  const out: string[] = [];
  for (const id of MCP_TARGETS) {
    const path = id === "agent-plugins" ? "<plugin-root>/mcp.json" : id === "claude-code" ? ".mcp.json" : ".github/mcp.json";
    out.push(`✓ ${id.padEnd(14)} ${path}`);
  }
  for (const [id, u] of Object.entries(UNSUPPORTED)) out.push(`· ${id.padEnd(14)} no output — ${u.reason}: ${u.detail}`);
  return out;
}

/** Aggregate every declared server across skills, rejecting cross-skill name collisions. */
export function collectServers(skills: LoadedSkill[]): { servers: McpServer[]; conflicts: string[] } {
  const byName = new Map<string, { server: McpServer; skill: string }>();
  const conflicts: string[] = [];
  for (const skill of skills) {
    for (const s of skill.manifest.mcp.servers) {
      const prev = byName.get(s.name);
      if (prev && prev.skill !== skill.manifest.skill.name) {
        conflicts.push(`MCP server "${s.name}" is declared by both "${prev.skill}" and "${skill.manifest.skill.name}" — one config key cannot hold both. Rename one.`);
        continue;
      }
      byName.set(s.name, { server: s, skill: skill.manifest.skill.name });
    }
  }
  const servers = [...byName.values()].map((v) => v.server).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { servers, conflicts };
}

/** True when a value is exactly one `${VAR}` and nothing else. */
export function isWholeRef(v: string): boolean {
  return WHOLE_REF_RE.test(v);
}
