# SetupGuard

> Clone. Open. Know what's broken.

SetupGuard is a local, deterministic diagnostic for **repository development
readiness**: it checks whether someone who clones this repository right now
could actually prepare and run it, following only what the repository itself
declares.

Repositories drift. A script is renamed and the README still tells people to
run the old one; `.nvmrc` says 18 while `engines` demands 22; a pull request
starts reading `PAYMENTS_API_URL` and nobody adds it to `.env.example`. Each one
costs the next contributor an afternoon. SetupGuard finds them by reading the
repository's own files — no AI, no heuristics that change between runs, and it
never executes anything from the project.

This repository is at **v0.1**. Three interfaces share one engine and one set of
checks:

| Interface | State |
| --- | --- |
| CLI (`packages/cli`) | implemented and tested |
| VS Code extension (`packages/vscode`) | implemented and tested; **not** published to any marketplace |
| GitHub Action (`action.yml`, `packages/github-action`) | implemented; tested against a controlled API, against real public pull requests, and on GitHub Actions on this repository's own pull request; **no release tag yet**, not on the GitHub Marketplace |

The product specification lives in [`Notes/`](Notes/README.md) and is the
source of truth for scope and decisions.

## On pull requests: the GitHub Action

The action tells a maintainer which readiness problems **a pull request
introduces** — not every problem the repository already had.

```yaml
# .github/workflows/setupguard.yml
name: SetupGuard
on:
  pull_request:
permissions:
  contents: read
  pull-requests: read
jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5; keep the default ref
        with:
          persist-credentials: false
      - uses: Jovinull/SetupGuard@<commit-sha>   # see "Versions" below
```

No release has been tagged yet, so pin a full commit SHA from `main`. A `@v1`
reference does not exist and will not resolve.

### What it does

1. Diagnoses the checked-out pull request with the same engine as the CLI,
   static level only.
2. Uses the **GitHub REST API** to learn exactly what the pull request changed
   and what the base looked like:
   `GET /repos/{o}/{r}/pulls/{n}` (identity and head SHA, read twice to detect a
   pull request that moved during the run), `GET /repos/{o}/{r}/git/commits/{sha}`
   (the merge commit's parents, i.e. the real base),
   `GET /repos/{o}/{r}/pulls/{n}/files` (paginated list of changed files), and
   `GET /repos/{o}/{r}/contents/{path}?ref={base}` for the base version of a
   changed file — **only** for files a check actually reads.
3. Diagnoses the base the same way and compares. A finding is **new** only if
   the base does not have it, or had it at a lower severity — a warning the
   pull request turns into an error is reported as raised by the pull request.
   Moving a README paragraph does not make an old problem new.
4. Reports through the runner: error/warning annotations on the diff for new
   problems, a job summary with every finding (new, already on the base, not
   comparable), and the list of API requests in the log.

| Result | Exit | When |
| --- | --- | --- |
| `fail` | 1 | the pull request introduces an error (or a warning, with `fail-on: warning`) |
| `incomplete` | 1 | anything that prevented a full answer: API failure, a check that could not conclude, a base that could not be reproduced, an unsupported project. **Never reported as a pass** |
| `pass` | 0 | nothing at the threshold was introduced; problems already on the base are listed, not failed |

Outside pull requests (`push`, `workflow_dispatch`, ...) it diagnoses the whole
checkout, like the CLI.

Inputs: `token` (default: the workflow's `GITHUB_TOKEN`), `path` (subdirectory
to analyse, default `.`), `fail-on` (`error` or `warning`). Outputs: `result`,
`readiness`, `new-errors`, `new-warnings`.

### Security and permissions

- **`pull_request` only.** On a fork the token is read-only and no secret is
  exposed. `pull_request_target` is refused: it checks out the base branch,
  not the pull request, and carries a privileged token.
- **Two read permissions**, `contents: read` and `pull-requests: read`. No
  `checks: write`, no comments on the pull request, no personal access token.
- **Nothing from the pull request runs.** No `npm install`, no scripts, no
  config file is evaluated, and not even `git`: the checked-out commit is read
  from `.git/HEAD` as a file.
- **Pull request content is data.** Annotations are escaped like
  `@actions/core` escapes them, the log is printed inside a per-run
  `stop-commands` region, the summary entity-encodes every character HTML or
  Markdown would act on, and outputs are restricted to fixed values. File paths
  from the API with `..`, `.git`, control characters or backslashes stop the
  comparison rather than being used.
- **The code that runs is the code in this repository.** `action.yml` runs
  `packages/github-action/dist/index.cjs`, a committed bundle. CI rebuilds it
  and fails if one byte differs; to check it yourself:
  `pnpm install --frozen-lockfile && pnpm --filter @setupguard/github-action run bundle && git diff --exit-code packages/github-action/dist`.

### Limitations

- Static checks only: the runner is not the contributor's machine, so Node
  version, `PATH` and local `.env` checks do not run in CI.
- The comparison needs the default `actions/checkout` ref (the merge commit) or
  the pull request head; any other checkout is reported `incomplete`.
- Pull requests with more than 3000 changed files are `incomplete`: that is the
  most the files endpoint lists. A run is capped at 400 API requests.
- Large repositories can exceed the engine's scan limits (50 files under
  `docs/`, source depth 8) and get `incomplete`. The job says which check and
  why; `ignore:` in `.setupguard.yml` narrows the scan.
- A changed file that is a symlink on the base cannot be reproduced through the
  API and makes the run `incomplete` when a check reads it.

Design record and evidence: [Notes/17](Notes/17-github-action-implementada.md).

### Versions

There is no tag yet. Until one exists, pin a full commit SHA; a SHA cannot be
moved, a tag can. Release tags (`v0.x.y` plus a moving major tag) are planned
but not published.

## Try it

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js .
node packages/cli/dist/bin.js fixtures/broken-node-project
```

### In VS Code

```bash
pnpm --filter setupguard run package
code --install-extension packages/vscode/setupguard-0.1.0.vsix
```

Open a repository: the status bar tells you where it stands, the Problems panel
points at the files, and `SetupGuard: Show Report` explains the whole diagnosis.
The extension starts no process — see
[Notes/16](Notes/16-extensao-vscode-implementada.md).

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
- send anything anywhere. The CLI and the extension make no network request.
  The GitHub Action makes read-only `GET` requests to the GitHub API of the
  repository it runs in, and nothing else; every request is listed in its log.

## Layout

```text
packages/
  core/          engine: model, adapter/check contracts, config, pipeline, report schema
  adapter-node/  Node.js/TypeScript ecosystem: facts and checks
  cli/           `setupguard` command
  vscode/        the VS Code extension (`setupguard`)
  github-action/ the GitHub Action; dist/index.cjs is the committed bundle action.yml runs
action.yml       metadata of the GitHub Action
schemas/         generated JSON Schema for .setupguard.yml
fixtures/        real project directories used by the tests
testing/         shared test helpers
Notes/           product specification and decision log
```

## Development

```bash
pnpm install
pnpm check      # lint + typecheck + test
pnpm run serve  # TEMPORARY REGRESSION: no such script (negative test, do not merge)
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
(22.13.0) and the current LTS (24), plus a dependency audit, the VSIX package
check and the GitHub Action bundle check. `.github/workflows/setupguard.yml`
runs the action on this repository's own pull requests.

Production dependencies have no known advisory (`pnpm audit --prod`). The full
audit carries **one accepted exception**, not a fix: `minimatch`
GHSA-g3hv-75wg-m249 (moderate), in development tooling only (ESLint,
typescript-eslint, `@vscode/vsce`). No released version of those tools uses the
fixed `minimatch` yet; the vulnerable code needs `optimizationLevel >= 2`,
which none of them sets, and `minimatch` is not in the action bundle or the
VSIX. The exception is scoped to that one advisory in `pnpm-workspace.yaml`,
and `scripts/check-audit-exceptions.mjs` fails CI once its review date
(2026-11-30) passes. Analysis and run history:
[Notes/17](Notes/17-github-action-implementada.md).

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

## Reporting bugs and getting help

- **Bugs and false positives:** open an issue at
  <https://github.com/Jovinull/SetupGuard/issues>. Include the finding's code
  (e.g. `node/docs-script-not-found`), the file and line it points at, and
  what you expected. For the action, the job summary and the list of API
  requests from the log are the most useful attachments.
- **Security problems:** do not open a public issue; see [SECURITY.md](SECURITY.md).
- **Support e-mail:** not set up yet. Until there is one, the issue tracker is
  the only support channel.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `pnpm check` must pass, a
bug fix comes with a test that fails without it, and the engine stays
deterministic — no network, no AI, nothing executed from the analysed project.

SetupGuard is an independent project. It is not affiliated with or endorsed by
GitHub.

## Licence

MIT (see [`LICENSE`](LICENSE)).
