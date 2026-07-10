# Why AI Skills Need an Open Standard

## Prompts are code

The instructions you feed a coding agent decide what lands in your codebase. They have authors, versions, bugs, regressions, and security implications. They are code — except today they're treated like sticky notes: pasted from gists, edited in place, shared in screenshots, updated silently, tested never.

We version, review, test, and pin every other artifact that touches production. The text that *steers the thing writing the code* deserves at least the same rigor.

## The fragmentation tax

Every assistant invented its own extension format: `.claude/skills/`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `AGENTS.md`, `.windsurfrules`, `.clinerules`, `CONVENTIONS.md`, `GEMINI.md`. Same intent, nine dialects.

The cost lands on teams. Your reviewer skill works for the half of the team on one agent and is dead weight for the rest. Rule files drift apart. Knowledge gets encoded once per vendor or not at all. Every viral skill maintains N hand-copied variants — the surest sign that a compiler is missing.

We've watched this movie: browsers before web standards, package management before lockfiles, containers before OCI. It ends with an open format and tooling that targets it. It never ends with one vendor's dialect winning.

## Portability is leverage

Your team's skills encode your conventions, your review standards, your hard-won architectural decisions. That investment should compound for years — not evaporate when a better agent ships and you switch.

An open, assistant-agnostic format means your workflows outlive any single AI vendor. Switching agents should cost one `compile`, not a migration project. Vendors compete on their agents; your skills stay yours.

## Context is a resource

Every installed rule burns tokens on every request, forever. Nobody measures it. Thirty accumulated rules quietly tax every interaction — slower, costlier, and worse, because context is finite and noise crowds out signal.

Prompts should ship with budgets the way binaries ship with size limits: declared, measured against compiled output, enforced at build time. If a skill can't say what it costs, it doesn't know what it costs.

## Trust must be earned

Installing a skill means injecting unreviewed instructions into the tool that edits your code — a prompt-injection supply chain nobody is scanning. The fix is boring and proven: content hashes in a lockfile, human-readable diffs before any update takes effect, permission manifests you can audit at install, signatures when the stakes demand them.

No skill should ever change your agent's behavior silently. That is the entire trust model, and it's non-negotiable.

## Tested, or it's a vibe

Everyone shares prompts; nobody tests them. Version 1.3 of a skill can be quietly worse than 1.2 and no one will know, because there's nothing to fail. Skills need evals the way code needs tests: static checks that are free, behavioral runs against fixture repos that prove the skill still does its job. Measured beats popular.

## Composition beats monoliths

A skill that emits a typed artifact — a plan, findings, verification evidence — can feed the next skill. That's stdin/stdout for agents: small tools, sharp edges, piped together. The alternative is monolithic mega-prompts that do everything badly and compose with nothing.

## What follows

If you believe the above, the conclusion is mechanical: an open skill format, a compiler that targets every agent, a lockfile, permission manifests, evals, and typed artifacts. Not another prompt collection. Not another agent. The infrastructure layer in between — open, boring, and owned by no vendor.

That's [Kitbash](README.md). The spec is a draft and this is the moment to shape it: [spec/SPEC.md](spec/SPEC.md).

*Your skills should outlive your agent.*
