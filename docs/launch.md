# Launch plan: first five external users

Goal is not stars. Goal: **five people we don't know install Kitbash, write or import one skill, and tell us where it hurt.** Five real users teach more than a week of feature work.

## Prerequisites (blockers)

- [x] `npm publish` — **kitbash@0.3.0 live**: https://www.npmjs.com/package/kitbash
- [x] Demo (animated real session in README)
- [x] skills.sh interop (import path for existing skills)
- [x] Lockfile + drift detection (the trust story is demonstrable)

## The ask (copy-paste for any channel)

> I'm building Kitbash — an open format + compiler for AI agent skills. Write a skill once, `kitbash compile` emits it for Claude Code, Cursor, and anything reading AGENTS.md. Existing skills.sh/Claude skills import directly. Skills declare token budgets and permissions; installs are content-hash pinned.
>
> Looking for 5 people to try it and tell me where it breaks: install it, bring one skill you already use (or write one), run it in two different agents. Fifteen minutes. Brutal feedback wanted.

## Channels, in order of expected signal

1. **skills.sh / agent-skills community** — people who already installed skills; the import path is zero-friction for them. Comment on active issues asking for cross-agent support.
2. **Show HN** — title: "Show HN: Kitbash – write an AI agent skill once, compile it for every coding agent". First comment: the ~5,044-token measurement story (the "compiler, not converter" moment) + honest status (stable spec core via RFC 0002, experimental ecosystem — what works, what doesn't).
3. **r/ClaudeAI, r/cursor** — teams split across agents are the exact wedge persona.
4. **Ponytail/Caveman discussion threads** — users who maintain N hand-copied variants; Kitbash removes that job.

## What to measure

- Time from `npm i -g` to first successful `compile` (target: under 2 minutes).
- Where each of the five stopped or got confused (the funnel's first cliff).
- Whether anyone runs `kitbash doctor` unprompted (is the trust story discoverable?).

## What not to do

- No launch before npm publish. "Clone and build" kills the funnel at step zero.
- No feature work in response to feedback until all five sessions are done — patterns over reactions.
