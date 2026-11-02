# Contributing to SetupGuard

Thank you for helping. A few rules keep the tool trustworthy.

## Setup

Node.js >= 22.13 (`.nvmrc` pins 24) and pnpm 11 (`packageManager` in
`package.json`; Corepack picks it up).

```bash
pnpm install --frozen-lockfile
pnpm check        # lint + typecheck + tests
```

## Rules

1. **The engine is deterministic.** Same files, same report. No network calls
   from checks, no AI, no randomness, no dependence on the order the
   filesystem returns entries in.
2. **Nothing from the analysed project is executed.** No package manager, no
   scripts, no config file evaluated as code. Checks read files through
   `WorkspaceFs` and never touch `node:fs` directly.
3. **A gap is never a pass.** If a check cannot reach a conclusion it returns
   `inconclusive`, and the run is `INCOMPLETE` — not `READY`.
4. **No secret in a report.** Names of environment variables are fine; values
   never are. Reports are sanitised centrally, but do not lean on that.
5. **A bug fix comes with a test that fails without it.** Do not change a test
   only to make it pass.
6. **Docs follow the code.** If a change makes a statement in `README.md` or
   `Notes/` untrue, update it in the same pull request.

## The GitHub Action bundle

`action.yml` runs `packages/github-action/dist/index.cjs`, which is committed.
After changing anything the action depends on (including `packages/core` and
`packages/adapter-node`), rebuild it and commit the result:

```bash
pnpm --filter @setupguard/github-action run bundle
```

CI rebuilds the bundle and fails if it differs from the committed file.

## Where things are decided

Product and architecture decisions are recorded in [`Notes/`](Notes/README.md),
in Portuguese. Code, commit messages and public documentation are in English.
