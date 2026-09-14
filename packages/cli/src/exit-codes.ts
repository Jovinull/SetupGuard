import type { Report } from '@setupguard/core';

import type { FailOn } from './args.js';

/**
 * Exit-code contract for v0.1 (`Notes/06-cli.md`).
 *
 * Kept deliberately small and stable, because CI configuration depends on it.
 */
export const EXIT_CODES = {
  /** No finding at or above the configured threshold. */
  OK: 0,
  /** The project has findings at or above the threshold. */
  FINDINGS: 1,
  /** The command line was invalid, or the path cannot be analysed. */
  USAGE: 2,
  /**
   * The diagnosis did not happen: no supported project, no check applicable to
   * the requested levels, or a SetupGuard failure. Never means the project is
   * broken — and never means it is fine either.
   */
  INCOMPLETE: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Map a report to an exit code.
 *
 * An incomplete diagnosis is never reported as a broken project: it yields
 * `INCOMPLETE`, and only when no finding already failed the run.
 *
 * `--fail-on never` suppresses failures caused by *findings*. It deliberately
 * does not suppress code 3: "I could not check anything" is not a finding the
 * user chose to tolerate, and in CI a silent zero there is a false pass.
 */
export function exitCodeFor(report: Report, failOn: FailOn): ExitCode {
  const failing =
    failOn === 'never'
      ? 0
      : failOn === 'warning'
        ? report.summary.errors + report.summary.warnings
        : report.summary.errors;

  if (failing > 0) return EXIT_CODES.FINDINGS;
  if (report.readiness === 'INCOMPLETE') return EXIT_CODES.INCOMPLETE;
  return EXIT_CODES.OK;
}
