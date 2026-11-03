# Changelog

## 0.1.0

First installable build.

- Automatic diagnosis of every workspace folder on activation, and again when a
  file that could change the answer is written.
- Status bar item with `Ready`, `Warnings`, `Blocked` and `Incomplete` states,
  aggregated across folders in a multi-root workspace.
- Findings published to the Problems panel, anchored to the file and position
  the evidence names.
- Problems with `.setupguard.yml` reported against the configuration file, kept
  apart from problems with the project.
- `SetupGuard: Run Diagnosis` and `SetupGuard: Show Report` commands.
- Supported in untrusted workspaces: the implemented verification levels start
  no process.
- Writing to `process.env` (`=`, `??=`, `||=`, `delete`) is not reported as
  depending on the variable.
- `out/THIRD_PARTY_NOTICES.txt` carries the licenses of the code bundled into
  the extension (`semver`, `yaml`).
