# Contributing to Capka

Thanks for helping build Capka. Contributions to the core are accepted under
the **AGPL-3.0** and a Contributor License Agreement (see below).

## Before you start

- This repo runs a **customized Next.js 16** — read `node_modules/next/dist/docs/`
  before changing framework code. It is not stock Next.js.
- Read `AGENTS.md` and `SECURITY.md`.
- Discuss non-trivial changes in an issue first.

## Development

```bash
npm run docker:dev   # full stack with safe dev defaults (loopback ports, dev secrets)
npm test             # vitest unit tests
RUN_INTEGRATION=1 npm test   # include integration tests
```

After editing the worker, runner, instrumentation, or the Telegram bot, restart
the platform container — HMR does not reload the in-process worker loop.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Include tests for behavior changes.
- Run `npm run lint` and `npm test` before pushing.
- Conventional-commit style messages (`feat:`, `fix:`, `docs:`, `deploy:` …).

## Contributor License Agreement (CLA)

Capka is **open-core**: the core is AGPL-3.0, and some enterprise features ship
under a separate commercial license. To allow that dual-licensing, every
contributor must sign the CLA. A bot will prompt you to sign on your first PR;
signing is a one-time, one-click step recorded in `signatures/cla.json`.

## License of contributions

By contributing you agree your contributions are licensed under AGPL-3.0 for the
core and may be relicensed by the maintainers for the commercial edition, per the
signed CLA.

## Questions

Open an issue, or reach the maintainer at ua.lyo.su@gmail.com.
