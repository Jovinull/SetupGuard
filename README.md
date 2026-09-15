# SetupGuard

> Clone. Open. Know what's broken.

SetupGuard is a local, deterministic diagnostic for **repository development
readiness**: it checks whether someone who clones this repository right now
could actually prepare and run it, following only what the repository itself
declares.

This repository is at **v0.1 (foundation)**. The engine, the Node.js adapter and
the CLI exist and are tested; the VS Code extension and the GitHub Action do
not. The product specification lives in [`Notes/`](Notes/README.md) and is the
source of truth for scope and decisions.

## Try it

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js .
node packages/cli/dist/bin.js fixtures/broken-node-project
```

## What it checks today

| Check | Level | Finds |
| --- | --- | --- |
| `node/package-json` | static | missing, unparseable or non-object manifest |
| `node/package-manager` | static | missing lockfile, several lockfiles, lockfile that contradicts `packageManager` |
| `node/node-version-declaration` | static | no declared Node version; declarations that contradict each other |
| `node/scripts` | static | empty scripts; a script calling another that is not declared |
| `node/env-contract` | static | variables read by the code but absent from `.env.example` |
| `node/docs-script-drift` | static | documentation telling you to run a script that does not exist |
| `node/package-manager-available` | environment | the required package manager is not on `PATH` |
| `node/node-version-runtime` | environment | the local Node.js version does not satisfy the declared range |
| `node/env-local-file` | environment | documented variables that are missing, or declared empty, locally |

Results aggregate into four states:

| State | Exit | Meaning |
| --- | --- | --- |
| `BLOCKED` | 1 | someone following the repository's own instructions is stuck |
| `INCOMPLETE` | 3 | the diagnosis is **partial**: something could not be checked, nothing was checked at all, or `.setupguard.yml` could not be applied. Not a pass, and not a failure of the project |
| `WARNINGS` | 0 | the contract is degraded but the project can still run |
| `READY` | 0 | every check that applied reached a conclusion, and none of them found anything |

The table is in precedence order. `BLOCKED` outranks `INCOMPLETE` because an
error finding is evidence that was actually gathered. Everything else yields to
`INCOMPLETE`, including warnings — a warning must not mask the fact that part of
the diagnosis did not happen.

`READY` therefore requires positive evidence *and* no gaps: at least one check
that concluded, and no check that gave up or crashed. An empty directory, a
mistyped path, an unsupported ecosystem, an unreadable `.nvmrc` or a level with
no checks all exit 3, not 0.

## Configuration

Optional. Without `.setupguard.yml` nothing changes — zero-config is the
default, and the file exists only so a project can declare an exception it has
already thought about.

```yaml
version: 1

checks:
  node/docs-script-drift:
    severity: warning   # error | warning | off

env:
  optional:
    - SENTRY_DSN        # exact names; never a pattern, never a value

ignore:
  - docs/generated/**   # narrows the source and documentation scans only
```

An unknown check id, an invalid severity or a pattern that escapes the
workspace is a configuration error, not something quietly ignored: the run then
reports `INCOMPLETE` rather than a verdict it was not asked for.

Full reference, including where `ignore` applies and where it deliberately does
not: [Notes/15-configuracao.md](Notes/15-configuracao.md). Machine-readable
schema: [`schemas/setupguard.schema.json`](schemas/setupguard.schema.json).

## What it will not do

- run `build`, `test`, migrations, `docker compose up`, or any other command
  with side effects — not even to "verify" something;
- follow a path out of the directory you point it at — `..`, an absolute path,
  or a symlink committed in the repository. A hard link created locally is the
  one gap, and it is documented in the threat model rather than half-guarded;
- print the value of an environment variable or any other secret — every
  free-text field and every file path in a report is sanitised centrally before
  it is written or rendered (identifiers such as check ids and the workspace
  root you passed in are structural and are left as-is);
- modify your files;
- send anything anywhere. Everything runs locally.

## Layout

```text
packages/
  core/          engine: model, adapter/check contracts, config, pipeline, report schema
  adapter-node/  Node.js/TypeScript ecosystem: facts and checks
  cli/           `setupguard` command
  vscode/        report -> editor diagnostics projection (no extension host yet)
schemas/         generated JSON Schema for .setupguard.yml
fixtures/        real project directories used by the tests
testing/         shared test helpers
Notes/           product specification and decision log
```

## Development

```bash
pnpm install
pnpm check      # lint + typecheck + test
```

CI runs the same commands on Linux, macOS and Windows against Node 22.13 and 24,
plus `pnpm audit`. See [Continuous integration](#continuous-integration) for
what has actually been verified.

Architectural decisions belong in [`Notes/`](Notes/README.md) — see
[14-implementacao-v0.1.md](Notes/14-implementacao-v0.1.md) for what the current
code actually implements, and
[13-decisoes-e-questoes-em-aberto.md](Notes/13-decisoes-e-questoes-em-aberto.md)
for what is still open.

## Continuous integration

`.github/workflows/ci.yml` runs lint, typecheck, tests and a self-diagnosis on
Ubuntu, macOS and Windows, against the lowest Node this project supports
(22.13.0) and the current LTS (24), plus a separate dependency audit.

**All seven jobs pass** — 368 tests on three operating systems and two Node
versions.

One thing a green matrix still does not prove:

- the symlink-confinement tests skip themselves on Windows, where creating a
  link needs elevation, so that boundary stays unverified there.

The built CLI runs a static self-diagnosis on every matrix leg, proving that it
starts on the minimum supported runtime. The full diagnosis, which also checks
the runner environment, runs on Node 24 — the version `.nvmrc` recommends. On
22.13 the environment check correctly reports that the runner is not on the
recommended runtime, so treating that full diagnosis as an expected pass would
hide a true finding.

Node 20 is deliberately not supported: it reached end of life on 2026-04-30,
and shipping support for a runtime without security patches would contradict
what this tool is for.

## Licence

MIT (see [`LICENSE`](LICENSE)).
