# Contributing to Kitbash

Pre-alpha. The most valuable contributions right now are **spec review** and **adapter knowledge** — if you know the extension format of an assistant we haven't covered deeply (Windsurf, Cline, Continue, OpenHands, …), open an issue describing its capabilities against the matrix in [docs/design.md](docs/design.md).

## Ground rules

- **Spec changes go through RFC issues** before PRs. The spec is the product; churn there is expensive for everyone downstream.
- **Skills must ship with evals.** A first-party skill PR without at least static-tier coverage and one behavioral eval will be asked for them.
- **No prompt piles.** Skills that a frontier model already performs well from a bare prompt (commit messages, generic doc writing) are out of scope as standalone skills — see the rejection list in [docs/skills-catalog.md](docs/skills-catalog.md).
- **Honesty in degradation.** Adapter PRs must not claim enforcement (permissions, budgets) the target platform can't provide. Advisory is fine; silent is not.

## Dev setup

```bash
cd packages/cli
npm install
npm run check     # typecheck
npm run dev -- doctor
```

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `spec:`). Keep subjects ≤ 72 chars.

## License

Apache-2.0. By contributing you agree your contributions are licensed under it.
