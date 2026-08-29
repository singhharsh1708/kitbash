/**
 * How wrong is `length / 4`?
 *
 * The compiler budgets skills with a character-count estimate, and the
 * benchmark publishes the numbers it produces. This measures those exact
 * artifacts against a real tokenizer (`o200k_base`) so the error bar quoted in
 * docs/benchmarks/README.md is a regenerated number rather than a remembered
 * one — the previous published figure ("about 2-11% high") was wrong in the
 * flattering direction, and nothing in the repo could have caught it.
 *
 * gpt-tokenizer is a devDependency: it runs here and in no shipped code path.
 * Kitbash's runtime dependency count stays zero.
 *
 * Reproduce:  npm run tokencheck   (inside packages/cli)
 */
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { estimateTokens } from "../dist/ksf.js";
import { LOADING, SKILLS, artifactText, stubText, withBenchWorkspace } from "./bench-fixtures.mjs";

const pct = (r) => `${r >= 1 ? "+" : ""}${((r - 1) * 100).toFixed(0)}%`;

withBenchWorkspace((tmp) => {
  const rows = [];
  for (const s of SKILLS) {
    rows.push({ label: `${s.name} stub`, text: stubText(tmp, s.name) });
    // One row per distinct artifact; targets that emit identical bytes collapse.
    const seen = new Map();
    for (const t of Object.keys(LOADING)) {
      const text = artifactText(tmp, t, s.name);
      if (!text || seen.has(text)) continue;
      seen.set(text, t);
      rows.push({ label: `${s.name} body (${t})`, text });
    }
  }

  console.log("estimator (length / 4) vs o200k_base, over the benchmark artifacts\n");
  console.log(`  ${"artifact".padEnd(34)} ${"est".padStart(6)} ${"real".padStart(6)} ${"error".padStart(7)}`);
  console.log(`  ${"-".repeat(34)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(7)}`);

  const ratios = [];
  for (const r of rows) {
    const est = estimateTokens(r.text);
    const real = encode(r.text).length;
    if (!real) continue;
    ratios.push(est / real);
    console.log(`  ${r.label.padEnd(34)} ${String(est).padStart(6)} ${String(real).padStart(6)} ${pct(est / real).padStart(7)}`);
  }

  const lo = Math.min(...ratios);
  const hi = Math.max(...ratios);
  console.log(`\n  range: ${pct(lo)} to ${pct(hi)}`);
  console.log(`  ${lo < 1 ? "NOT uniformly conservative — the estimator under-counts somewhere, so a skill can pass a budget it exceeds" : "conservative throughout — every artifact estimates at or above its real cost"}`);

  console.log("\n  standing-tax ratio, estimated vs real:");
  for (const s of SKILLS) {
    const stub = stubText(tmp, s.name);
    const eagerTarget = Object.keys(LOADING).find((t) => LOADING[t] === "eager");
    const body = artifactText(tmp, eagerTarget, s.name);
    const e = estimateTokens(body) / estimateTokens(stub);
    const a = encode(body).length / encode(stub).length;
    console.log(`    ${s.name.padEnd(18)} ${e.toFixed(1)}x estimated  ${a.toFixed(1)}x real`);
  }
  console.log("\n  docs/benchmarks/README.md quotes these; update it when they move.");
});
