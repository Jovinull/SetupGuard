import { allFindings, type CheckStatus, type Finding, type Report } from '@setupguard/core';

/**
 * What counts as a regression.
 *
 * A finding on the pull request is **new** only when the base commit, analysed
 * by the same engine with the same rules, does not have it. It is
 * **pre-existing** when the base has it too. It is **unclassified** when the
 * base analysis of that check reached no conclusion, so nobody can say.
 *
 * Identity is `checkId + code + message`. Line numbers are deliberately not
 * part of it: inserting a paragraph above an old README problem moves the
 * problem, it does not create it. Severity is not part of it either: a
 * configuration change that turns an old warning into an error has not
 * introduced the problem.
 *
 * When the same identity occurs more often on the pull request than on the
 * base, only the surplus is new. Which occurrences form the surplus is decided
 * by evidence: occurrences whose file and quoted text match a base occurrence
 * are matched first, so the one flagged as new is the one that is not in the
 * base, wherever the lines moved to.
 */

export type Classification = 'new' | 'preexisting' | 'unclassified';

export interface ClassifiedFinding {
  readonly finding: Finding;
  readonly classification: Classification;
}

export interface Comparison {
  readonly findings: readonly ClassifiedFinding[];
  /** Why some findings could not be classified; empty when all were. */
  readonly gaps: readonly string[];
}

/** Base statuses that are a conclusion about the check, and so can be compared against. */
const COMPARABLE: ReadonlySet<CheckStatus> = new Set(['pass', 'warning', 'error', 'not-applicable']);

export function fingerprint(finding: Finding): string {
  return `${finding.checkId}\u0000${finding.code}\u0000${finding.message}`;
}

function evidenceKey(finding: Finding): string {
  return finding.evidence.map((e) => `${e.file ?? ''}\u0000${e.excerpt ?? ''}\u0000${e.detail ?? ''}`).join('\u0001');
}

export function compareReports(head: Report, base: Report): Comparison {
  const gaps: string[] = [];
  const findings = allFindings(head);

  // A base whose configuration could not be applied ran with defaults; its
  // findings answer a different question than the head's.
  if (!base.config.valid) {
    gaps.push('the configuration on the base commit could not be applied, so the base results are not comparable');
    return { findings: findings.map((finding) => ({ finding, classification: 'unclassified' })), gaps };
  }

  const baseStatus = new Map(base.results.map((result) => [result.checkId, result.status]));
  const baseByFingerprint = new Map<string, Finding[]>();
  for (const finding of allFindings(base)) {
    const key = fingerprint(finding);
    const list = baseByFingerprint.get(key) ?? [];
    list.push(finding);
    baseByFingerprint.set(key, list);
  }

  const classification = new Map<Finding, Classification>();
  const uncomparableChecks = new Set<string>();

  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const status = baseStatus.get(finding.checkId);
    if (status === undefined || !COMPARABLE.has(status)) {
      classification.set(finding, 'unclassified');
      uncomparableChecks.add(finding.checkId);
      continue;
    }
    const key = fingerprint(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    const unmatchedBase = [...(baseByFingerprint.get(key) ?? [])];
    const pending: Finding[] = [];
    // Pass 1: same evidence (file and quoted text), wherever the line moved.
    for (const finding of group) {
      const index = unmatchedBase.findIndex((candidate) => evidenceKey(candidate) === evidenceKey(finding));
      if (index >= 0) {
        unmatchedBase.splice(index, 1);
        classification.set(finding, 'preexisting');
      } else {
        pending.push(finding);
      }
    }
    // Pass 2: same identity, different evidence — still the same problem, as
    // long as the base has occurrences left to account for it.
    for (const finding of pending) {
      if (unmatchedBase.length > 0) {
        unmatchedBase.shift();
        classification.set(finding, 'preexisting');
      } else {
        classification.set(finding, 'new');
      }
    }
  }

  for (const checkId of [...uncomparableChecks].sort()) {
    const status = baseStatus.get(checkId);
    gaps.push(
      status === undefined
        ? `${checkId} did not run on the base commit`
        : `${checkId} was ${status} on the base commit, so its findings cannot be compared`,
    );
  }

  return {
    findings: findings.map((finding) => ({ finding, classification: classification.get(finding)! })),
    gaps,
  };
}
