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

    if (line.startsWith("[")) {
      const m = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
      if (!m) throw new TomlError(i + 1, `invalid table header: ${line}`);
      current = ensureTable(root, m[1]!.split("."), i + 1);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) throw new TomlError(i + 1, `expected "key = value": ${line}`);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new TomlError(i + 1, `invalid key: ${key}`);
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

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (ch === "#" && !inString) return line.slice(0, i);
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

function isTable(v: TomlValue): v is TomlTable {
  return typeof v === "object" && !Array.isArray(v);
}

function parseValue(raw: string, line: number): TomlValue {
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw new TomlError(line, `unterminated string: ${raw}`);
    return JSON.parse(raw) as string;
  }
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new TomlError(line, `arrays must be single-line: ${raw}`);
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, line).map((item) => parseValue(item.trim(), line));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  throw new TomlError(line, `unsupported value: ${raw}`);
}

function splitTopLevel(inner: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (inString || depth !== 0) throw new TomlError(line, `malformed array: [${inner}]`);
  parts.push(inner.slice(start));
  return parts;
}
