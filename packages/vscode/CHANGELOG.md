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
