/**
 * Deploy-time site build. Keeps the site in lockstep with the repo:
 *
 * 1. Stamps the current CLI version (packages/cli/package.json) into every
 *    `<span data-version>` in site/*.html.
 * 2. Renders CHANGELOG.md into site/changelog.html between the
 *    `<!-- changelog:begin/end -->` markers.
 *
 * Runs in the pages workflow on every push and release, so the site can't go
 * stale. Also runnable locally: node site/build.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(fileURLToPath(import.meta.url));
/** --check verifies the committed output is current instead of rewriting it (CI gate). */
const checkOnly = process.argv.includes("--check");
const stale = [];
const repoRoot = resolve(site, "..");

const version = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8")).version;

// ---- inline markdown (escape first, then transform) ----
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Code spans are swapped for placeholders first so markers inside backticks stay
// literal — while bold/em can still wrap whole code spans (**`x` and `y`**).
const inline = (s) => {
  const codes = [];
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\x00${codes.length - 1}\x00`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\x00(\d+)\x00/g, (_, i) => `<code>${codes[+i]}</code>`);
};

// ---- parse CHANGELOG.md ----
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const sections = changelog.split(/^## /m).slice(1); // drop the file preamble

const releases = [];
for (const sec of sections) {
  const lines = sec.split("\n");
  const head = lines[0].trim();
  const m = head.match(/^\[([^\]]+)\](?:\s*—\s*(.+))?$/);
  if (!m) continue;
  const [, name, date] = m;
  const body = [];
  let list = null;
  const flush = () => { if (list) { body.push(`<ul>${list.join("")}</ul>`); list = null; } };
  for (const raw of lines.slice(1)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("### ")) { flush(); body.push(`<h3 class="group">${inline(line.slice(4))}</h3>`); }
    else if (/^- /.test(line.trim())) { (list ??= []).push(`<li>${inline(line.trim().slice(2))}</li>`); }
    else { flush(); body.push(`<p class="release-intro">${inline(line)}</p>`); }
  }
  flush();
  if (name.toLowerCase() === "unreleased" && !body.length) continue;
  releases.push({ name, date: date ?? "", body: body.join("\n") });
}

let firstVersion = true;
const html = releases
  .map((r) => {
    const isVersion = /^\d/.test(r.name);
    const id = isVersion ? `v${r.name}` : "unreleased";
    const latest = isVersion && firstVersion ? '<span class="release-tag">latest</span>' : "";
    if (isVersion) firstVersion = false;
    const title = isVersion ? `v${r.name}` : "Unreleased";
    const unreleasedTag = isVersion ? "" : '<span class="release-tag soon">on main, unreleased</span>';
    return `<article class="release" id="${id}">
  <div class="release-head">
    <h2><a href="#${id}">${title}</a></h2>
    ${r.date ? `<span class="release-date">${esc(r.date)}</span>` : ""}${latest}${unreleasedTag}
  </div>
${r.body}
</article>`;
  })
  .join("\n\n");

// ---- write changelog.html between markers ----
const clPath = join(site, "changelog.html");
const page = readFileSync(clPath, "utf8");
const re = /(<!-- changelog:begin -->)[\s\S]*?(<!-- changelog:end -->)/;
if (!re.test(page)) throw new Error("changelog.html is missing the changelog:begin/end markers");
const nextChangelog = page.replace(re, `$1\n${html}\n$2`);
if (nextChangelog !== page) {
  if (checkOnly) stale.push("site/changelog.html (CHANGELOG.md has changed)");
  else writeFileSync(clPath, nextChangelog);
}

// ---- stamp version into every page (site/ and subdirectories) ----
for (const e of readdirSync(site, { recursive: true, withFileTypes: false })) {
  const rel = String(e);
  if (!rel.endsWith(".html")) continue;
  const p = join(site, rel);
  const src = readFileSync(p, "utf8");
  const out = src.replace(/(<span data-version>)[^<]*(<\/span>)/g, `$1v${version}$2`);
  if (out === src) continue;
  if (checkOnly) stale.push(`site/${rel} (version is not v${version})`);
  else writeFileSync(p, out);
}

if (checkOnly && stale.length) {
  console.error("site is stale — run `node site/build.mjs` and commit the result:");
  for (const s of stale) console.error(`  ${s}`);
  process.exit(1);
}

console.log(
  checkOnly
    ? `site is current: v${version}, ${releases.length} changelog section(s)`
    : `site built: v${version}, ${releases.length} changelog section(s)`,
);
