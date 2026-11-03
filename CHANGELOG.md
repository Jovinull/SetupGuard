# Changelog

All notable changes to SetupGuard. Versions follow [Semantic Versioning](https://semver.org/);
while the major version is 0, a minor release may change behaviour.

## 0.1.0 — release candidate, not yet released

No tag and no published package exist yet. This section describes what the
first release will contain; [RELEASING.md](RELEASING.md) is the procedure.

### Engine (`@setupguard/core`, `@setupguard/adapter-node`)

- Deterministic, read-only diagnosis of Node.js / TypeScript repositories:
  package manifest, package manager and lockfile, declared Node.js versions,
  scripts that call missing scripts, documentation that tells the reader to run
  a missing script, environment variables read by the code but absent from
  `.env.example`.
- Environment checks against the local machine: package manager on `PATH`,
  Node.js version, local `.env` values (names only, never values).
- Four aggregate states: `READY`, `WARNINGS`, `BLOCKED`, and `INCOMPLETE`,
  which is never a pass.
- Optional `.setupguard.yml` (severity overrides, optional variables, scan
  ignores) with a published JSON Schema.
- Writing to `process.env` (`=`, `??=`, `||=`, `delete`) is not reported as
  depending on the variable.

### CLI (`@setupguard/cli`)

- `setupguard [doctor|check] [path]` with `--level`, `--fail-on`, `--json`,
  `--verbose`; exit codes 0 / 1 / 2 / 3 (3 = incomplete).
- Installed from source for now (the package is not published to npm).

### VS Code extension (`setupguard`)

- Status bar, Problems panel and a full report, updated as relevant files
  change. Starts no process; supported in untrusted workspaces.
- Distributed as a `.vsix` for manual installation; not on any marketplace.

### GitHub Action (`action.yml`)

- Reports the readiness problems **a pull request introduces**, compared with
  its base through the GitHub REST API; problems already on the base are
  listed, not failed. A problem the pull request raises from warning to error
  counts as introduced.
- `pass` / `fail` / `incomplete`; `incomplete` always fails the job.
- `pull_request` only (`pull_request_target` is refused); needs
  `contents: read` and `pull-requests: read`; executes nothing from the
  repository it analyses.
- Ships as a committed, byte-reproducible bundle.

### Distribution and security

- The action bundle and the VSIX carry `THIRD_PARTY_NOTICES.txt` for the code
  they inline (`semver`, `yaml`, both ISC).
- One accepted audit exception, `minimatch` GHSA-g3hv-75wg-m249 (development
  tooling only), due for review on 2026-11-30 and enforced by CI and a weekly
  scheduled audit.
