# Security policy

## What counts

SetupGuard reads repositories that may be hostile, so these are security
problems:

- a report, log, annotation or job summary that contains the value of an
  environment variable or another secret;
- a read that escapes the analysed directory (`..`, absolute paths, symlinks);
- anything from the analysed repository being executed, or interpreted as a
  workflow command by the GitHub Actions runner;
- the GitHub Action using its token for anything other than the read-only
  requests listed in its log, or the token appearing in any output.

## How to report

Please do **not** open a public issue for these.

A private reporting channel has not been set up yet. Until it exists, open an
issue at <https://github.com/Jovinull/SetupGuard/issues> that says only that you
have a security report and asks for a private contact — no details, no proof of
concept.

## Dependency advisories

`pnpm audit` runs on every push and pull request and weekly on the default
branch. An advisory can be accepted only as a recorded, dated exception (see
CONTRIBUTING.md); exceptions are listed in `pnpm-workspace.yaml` and fail CI
once their review date passes. Accepting an advisory is not fixing it.

## Supported versions

Only the latest commit on `main`. No release has been tagged yet.
