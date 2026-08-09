/**
 * SARIF 2.1.0 output, so `kitbash lint` results land in GitHub code scanning
 * (Security tab, PR annotations) instead of only a terminal.
 *
 * The point of emitting SARIF here is that one report carries all three things
 * Kitbash checks and other tools split across separate runs: the install-gate
 * safety lints (trust), the declared token budgets (cost), and the manifest /
 * reference integrity that catches drift. Each check becomes a rule so a
 * reviewer can see which class a finding belongs to.
 *
 * Zero dependencies: SARIF is plain JSON with a fixed shape, so it is built here
 * rather than pulled from a package.
 */

/** One lint finding, already evaluated. Mirrors the Check type in commands.ts. */
export interface SarifFinding {
  /** check id, e.g. "budget", "remote-exec" — becomes the SARIF ruleId */
  name: string;
  ok: boolean;
  warn?: boolean;
  detail?: string;
  /** skill this finding belongs to */
  skill: string;
  /** repo-relative file the finding points at */
  file: string;
}

/**
 * What each check means, for the rule metadata GitHub renders. Checks not listed
 * fall back to a generic description — a new check still emits valid SARIF with
 * its own rule rather than being dropped.
 */
const RULE_HELP: Record<string, string> = {
  manifest: "The skill declares a KSF manifest (skill.toml). An unmanifested skill gets conservative defaults and declares no permissions.",
  references: "Every {{template}} token and referenced prompts/ file resolves. A dead reference means the compiled instructions are incomplete.",
  budget: "The skill body fits the token budget it declares. Over budget means the skill costs more context than its author committed to.",
  standing: "The skill's standing stub fits its declared standing limit — the tokens it parks in context every session, before it is ever invoked.",
  "gate-verdict": "A gate-mode skill can actually produce a verdict (a scripts/ dir or a declared artifact).",
  "visible-text": "The skill contains no hidden text (zero-width or bidi characters, NUL bytes) — content an agent reads but a reviewer cannot see.",
  "dynamic-context": "The skill performs no load-time command substitution, which would execute on read rather than on invocation.",
  "remote-exec": "The skill contains no download-and-execute pipeline (curl … | sh).",
  secrets: "The skill carries no leaked credentials or API keys.",
  injection: "The skill contains no prompt-injection shaped directives (instruction overrides, conceal-from-user, output suppression).",
};

const TOOL_URI = "https://github.com/singhharsh1708/kitbash";

/**
 * A failing check is an `error` (it blocks install and fails the build); a
 * warning is a `warning`. Passing checks are not emitted — SARIF is a findings
 * format, and a clean run should show an empty results list, not noise.
 */
export function toSarif(findings: SarifFinding[], version: string): string {
  const problems = findings.filter((f) => !f.ok || f.warn);
  const ruleIds = [...new Set(problems.map((f) => f.name))].sort();

  const sarif = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "kitbash",
            version,
            informationUri: TOOL_URI,
            rules: ruleIds.map((id) => ({
              id,
              name: id,
              shortDescription: { text: `kitbash ${id} check` },
              fullDescription: { text: RULE_HELP[id] ?? `The kitbash "${id}" check.` },
              helpUri: `${TOOL_URI}#readme`,
              properties: { tags: ["kitbash", "agent-skills"] },
            })),
          },
        },
        results: problems.map((f) => ({
          ruleId: f.name,
          level: f.ok ? "warning" : "error",
          message: { text: `${f.skill}: ${f.name}${f.detail ? ` — ${f.detail}` : ""}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                // Line 1: these are whole-file properties (a budget, a manifest
                // field), not a specific line. Claiming a line would be a guess.
                region: { startLine: 1 },
              },
            },
          ],
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
