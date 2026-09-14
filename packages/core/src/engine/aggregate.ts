import type { CheckResult, Readiness, ReportSummary, Severity } from '../model/types.js';

/**
 * Aggregation policy. The order below **is** the precedence, and it is the
 * only place readiness is decided.
 *
 * ```text
 * 1. any error finding        -> BLOCKED      a confirmed defect in the project
 * 2. any internal-error       -> INCOMPLETE   SetupGuard failed; the run is partial
 * 3. any inconclusive         -> INCOMPLETE   a check ran but could not decide
 * 4. any warning finding      -> WARNINGS     degraded, but the project runs
 * 5. no conclusive check      -> INCOMPLETE   nothing was verified at all
 * 6. otherwise                -> READY
 * ```
 *
 * `BLOCKED` outranks `INCOMPLETE` because an error finding is evidence that was
 * actually gathered: a partial diagnosis that already found a blocker is still a
 * blocker. Everything else yields to `INCOMPLETE`, including warnings — a
 * warning must never mask the fact that part of the diagnosis did not happen.
 *
 * `READY` requires **positive evidence** and **no gaps**: at least one check
 * that reached a conclusion (`pass`, `warning`, `error`), and no check that
 * failed or gave up. Without that, an empty directory, an unsupported
 * ecosystem, a mistyped CI path, a level with no checks, an unreadable `.nvmrc`
 * or a crashed check would all read as success. In CI a false green is worse
 * than a false red.
 *
 * `INCOMPLETE` is not a verdict about the repository: it says the diagnosis is
 * partial. It covers both "nothing ran" and "most of it ran, but something
 * could not be checked" — {@link incompleteReason} says which.
 */
export function aggregateReadiness(results: readonly CheckResult[]): Readiness {
  const counts = countStatuses(results);

  if (counts.errorFindings > 0) return 'BLOCKED';
  if (counts.internalErrors > 0) return 'INCOMPLETE';
  if (counts.inconclusive > 0) return 'INCOMPLETE';
  if (counts.warningFindings > 0) return 'WARNINGS';
  if (counts.conclusive === 0) return 'INCOMPLETE';
  return 'READY';
}

/**
 * Why readiness came out `INCOMPLETE`. Mirrors the precedence in
 * {@link aggregateReadiness}, so the sentence always names the reason that
 * actually decided the state.
 */
export function incompleteReason(results: readonly CheckResult[]): string | undefined {
  const counts = countStatuses(results);

  if (counts.errorFindings > 0) return undefined;

  if (counts.internalErrors > 0) {
    return `${counts.internalErrors} check(s) failed inside SetupGuard, so the diagnosis is partial`;
  }
  if (counts.inconclusive > 0) {
    return `${counts.inconclusive} check(s) could not reach a conclusion, so part of the contract is unverified`;
  }
  if (counts.warningFindings > 0) return undefined;

  if (counts.conclusive === 0) {
    return results.length === 0
      ? 'No check ran: no supported project was detected in this directory'
      : 'No check reached a conclusion about this project';
  }
  return undefined;
}

interface StatusCounts {
  readonly errorFindings: number;
  readonly warningFindings: number;
  readonly conclusive: number;
  readonly inconclusive: number;
  readonly internalErrors: number;
}

function countStatuses(results: readonly CheckResult[]): StatusCounts {
  let errorFindings = 0;
  let warningFindings = 0;
  let conclusive = 0;
  let inconclusive = 0;
  let internalErrors = 0;

  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === 'error') errorFindings += 1;
      else if (finding.severity === 'warning') warningFindings += 1;
    }
    switch (result.status) {
      case 'pass':
      case 'warning':
      case 'error':
        conclusive += 1;
        break;
      case 'inconclusive':
        inconclusive += 1;
        break;
      case 'internal-error':
        internalErrors += 1;
        break;
      case 'skipped':
      case 'not-applicable':
        break;
    }
  }

  return { errorFindings, warningFindings, conclusive, inconclusive, internalErrors };
}

export function summarize(results: readonly CheckResult[]): ReportSummary {
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let passed = 0;
  let skipped = 0;
  let notApplicable = 0;
  let inconclusive = 0;
  let internalErrors = 0;
  let conclusive = 0;

  for (const result of results) {
    for (const finding of result.findings) bySeverity[finding.severity] += 1;
    switch (result.status) {
      case 'pass':
        passed += 1;
        conclusive += 1;
        break;
      case 'skipped':
        skipped += 1;
        break;
      case 'not-applicable':
        notApplicable += 1;
        break;
      case 'inconclusive':
        inconclusive += 1;
        break;
      case 'internal-error':
        internalErrors += 1;
        break;
      case 'warning':
      case 'error':
        conclusive += 1;
        break;
    }
  }

  return {
    errors: bySeverity.error,
    warnings: bySeverity.warning,
    infos: bySeverity.info,
    passed,
    skipped,
    notApplicable,
    inconclusive,
    internalErrors,
    conclusive,
  };
}

/** Derive a check status from the findings it produced. */
export function statusFromFindings(
  findings: readonly { severity: Severity }[],
): CheckResult['status'] {
  if (findings.some((finding) => finding.severity === 'error')) return 'error';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'pass';
}
