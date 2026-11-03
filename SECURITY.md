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

Please do **not** open a public issue, discussion or pull request for these.

Report them privately through GitHub's private vulnerability reporting:
<https://github.com/Jovinull/SetupGuard/security/advisories/new> (also reachable
from the repository's **Security** tab, "Report a vulnerability"). Only the
maintainer and you can see the report.

Please include what you ran, what you expected, what happened, and the
smallest repository or input that reproduces it. If you cannot use GitHub's
form, write to <felipejovinogamerplay@gmail.com> with "SetupGuard security" in
the subject, and say so before sending details.

What to expect: an acknowledgement as soon as the maintainer sees the report,
a fix or a decision discussed with you in the private advisory, and credit in
the published advisory unless you prefer otherwise. SetupGuard is maintained
by one person; there is no guaranteed response time.

## Dependency advisories

`pnpm audit` runs on every pull request, on every push to `main`, and weekly
on `main`. An advisory can be accepted only as a recorded, dated exception (see
CONTRIBUTING.md); exceptions are listed in `pnpm-workspace.yaml` and fail CI
once their review date passes. Accepting an advisory is not fixing it.

## Supported versions

The latest release and the latest commit on `main`. Fixes are not backported
to earlier 0.x releases; upgrade instead.
