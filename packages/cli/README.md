# kitbash

The package manager and compiler for AI agent skills. Write a skill once — run it in Claude Code, Cursor, Codex, and every agent that reads AGENTS.md.

```bash
npm install -g kitbash

cd your-repo
kitbash init
kitbash install gh:singhharsh1708/kitbash/examples/skills/prereview
kitbash compile
```

- One open format ([KSF](https://github.com/singhharsh1708/kitbash/blob/main/spec/SPEC.md)): manifest with token budgets, permissions, typed artifacts — compiled to each agent's native format.
- Installs are pinned by content hash in `kitbash.lock`; `kitbash doctor` detects drift.
- SKILL.md-only skills (the skills.sh / Claude Skills convention) install too — flagged as unmanifested.
- Zero runtime dependencies.

Full docs, spec, and manifesto: **https://github.com/singhharsh1708/kitbash**
