# SetupGuard

Answers one question about the repository you just opened: **can it actually be
developed in right now, and if not, what is missing?**

Open a folder and SetupGuard analyses it. The status bar tells you where you
stand, the Problems panel points at the files, and `SetupGuard: Show Report`
explains the whole thing in one document.

## What it checks

- `package.json` exists, parses, and declares what it claims to
- the package manager is declared, and the lockfile matches it
- the required Node.js version, from `engines`, `.nvmrc` or `.node-version`
- the scripts documentation refers to actually exist
- `.env.example` against the variables the code reads
- documentation that points at scripts the project does not have

## What it never does

SetupGuard does not run your project. It starts no process: no `install`, no
build, no test, no migration, no container. It reads repository files and
inspects the local machine, which is why it is safe in an untrusted workspace
and why opening a folder stays a read-only act.

It sends nothing anywhere. No network calls, no telemetry, no account.

Values are never reported. Where SetupGuard needs to talk about an environment
variable, a flag or a URL, the value is replaced before it reaches the screen —
names are enough to explain a problem.

## Status bar

| Status | Meaning |
| --- | --- |
| `$(pass) SetupGuard: Ready` | every check concluded and nothing is wrong |
| `$(warning) SetupGuard: Warnings` | it works, but something will bite later |
| `$(error) SetupGuard: Blocked` | something stops the project from running |
| `$(question) SetupGuard: Incomplete` | part of the diagnosis did not happen — not a pass |

`Incomplete` is deliberate. A diagnosis that could not finish is not the same as
a clean one, and SetupGuard will not report the difference as success.

## Commands

- **SetupGuard: Run Diagnosis** — analyse now, without waiting for a file change
- **SetupGuard: Show Report** — open the full report as a read-only document

The analysis also re-runs on its own when a file that could change the answer is
written: manifests, lockfiles, `.env` files, documentation, source files and
`.setupguard.yml`.

## Configuration

A repository declares its own exceptions in `.setupguard.yml`, committed
alongside the code, so everyone on the team gets the same diagnosis:

```yaml
version: 1

checks:
  node/docs-drift:
    severity: warning

env:
  optional:
    - SENTRY_DSN

ignore:
  - examples/**
```

The extension contributes no settings of its own. Anything worth configuring
belongs in the file the whole team shares, not in one developer's
`settings.json`.

A broken `.setupguard.yml` is reported as a problem with the configuration, in
the configuration file, and the result is `Incomplete` — never a pass.

## Multi-root workspaces

Each folder is analysed on its own and keeps its own report. The Problems panel
shows all of them; the status bar shows the worst.

## Requirements

VS Code 1.90 or newer, on a local filesystem.

## Licence

MIT.
