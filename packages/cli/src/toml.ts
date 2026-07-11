/**
 * Minimal TOML parser covering the subset KSF manifests use:
 * tables ([a.b]), bare keys, basic strings, integers, floats, booleans,
 * and single-line arrays. Deliberately not a full TOML implementation —
 * `kitbash lint` owns strictness; this owns zero runtime dependencies.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = src.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] ?? "").trim();
    if (!line) continue;

    if (line.startsWith("[[")) {
      const m = line.match(/^\[\[\s*([A-Za-z0-9_.\- ]+?)\s*\]\]$/);
      if (!m) throw new TomlError(i + 1, `invalid array-of-tables header: ${line}`);
      current = appendArrayTable(root, splitKeyPath(m[1]!, i + 1), i + 1);
      continue;
    }
    if (line.startsWith("[")) {
      const m = line.match(/^\[\s*([A-Za-z0-9_.\- ]+?)\s*\]$/);
      if (!m) throw new TomlError(i + 1, `invalid table header: ${line}`);
      current = ensureTable(root, splitKeyPath(m[1]!, i + 1), i + 1);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) throw new TomlError(i + 1, `expected "key = value": ${line}`);
    const key = parseKey(line.slice(0, eq).trim(), i + 1);
    current[key] = parseValue(line.slice(eq + 1).trim(), i + 1);
  }
  return root;
}

export class TomlError extends Error {
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

/** A quote at index i is escaped only if an ODD number of backslashes precede it. */
function isEscaped(s: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 1;
}

/** Split a (possibly dotted, possibly space-padded) table name into validated segments. */
function splitKeyPath(name: string, line: number): string[] {
  const parts = name.split(".").map((p) => p.trim());
  for (const p of parts) if (!/^[A-Za-z0-9_-]+$/.test(p)) throw new TomlError(line, `invalid table name segment: "${p}"`);
  return parts;
}

/** Bare keys match [A-Za-z0-9_-]; quoted keys ("x" or 'x') are unwrapped verbatim. */
function parseKey(raw: string, line: number): string {
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new TomlError(line, `invalid key: ${raw}`);
  return raw;
}

// Comment/array scanning tracks strings of both quote styles. Double-quoted strings honor
// backslash escapes; single-quoted literals do not (no escaping in TOML literal strings).
function stripComment(line: string): string {
  let quote = ""; // "", '"', or "'"
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '"' && !isEscaped(line, i)) quote = "";
    } else if (quote === "'") {
      if (ch === "'") quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function ensureTable(root: TomlTable, path: string[], line: number): TomlTable {
  let node = root;
  for (const part of path) {
    const existing = node[part];
    if (existing === undefined) {
      const next: TomlTable = {};
      node[part] = next;
      node = next;
    } else if (isTable(existing)) {
      node = existing;
    } else {
      throw new TomlError(line, `cannot redefine "${part}" as a table`);
    }
  }
  return node;
}

function appendArrayTable(root: TomlTable, path: string[], line: number): TomlTable {
  const parent = ensureTable(root, path.slice(0, -1), line);
  const last = path[path.length - 1]!;
  const existing = parent[last];
  if (existing === undefined) parent[last] = [];
  else if (!Array.isArray(existing)) throw new TomlError(line, `cannot redefine "${last}" as an array of tables`);
  const arr = parent[last] as TomlValue[];
  const entry: TomlTable = {};
  arr.push(entry);
  return entry;
}

function isTable(v: TomlValue): v is TomlTable {
  return typeof v === "object" && !Array.isArray(v);
}

function parseValue(raw: string, line: number): TomlValue {
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw new TomlError(line, `unterminated string: ${raw}`);
    try {
      return JSON.parse(raw) as string;
    } catch {
      throw new TomlError(line, `invalid string escape: ${raw}`);
    }
  }
  if (raw.startsWith("'")) {
    // literal string: no escape processing, verbatim between the quotes
    if (raw.length < 2 || !raw.endsWith("'")) throw new TomlError(line, `unterminated literal string: ${raw}`);
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new TomlError(line, `arrays must be single-line: ${raw}`);
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const items = splitTopLevel(inner, line);
    // A single trailing comma is legal TOML (leaves one empty item); drop it.
    if (items.length > 1 && items[items.length - 1]!.trim() === "") items.pop();
    if (items.some((item) => item.trim() === "")) throw new TomlError(line, `malformed array (empty element): ${raw}`);
    return items.map((item) => parseValue(item.trim(), line));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^[+-]?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  throw new TomlError(line, `unsupported value: ${raw}`);
}

function splitTopLevel(inner: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = ""; // "", '"', or "'"
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote === '"') {
      if (ch === '"' && !isEscaped(inner, i)) quote = "";
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || depth !== 0) throw new TomlError(line, `malformed array: [${inner}]`);
  parts.push(inner.slice(start));
  return parts;
}
