import { allFindings, type CheckStatus, type Finding, type Report, type Severity } from '@setupguard/core';

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
 * problem, it does not create it. Severity is not part of the identity
 * either, but it is compared once two occurrences are matched: when the base
 * had the problem at a **lower** severity, the pull request is what raised it
 * — for example by rewriting `pnpm dev` (a warning) as `pnpm run dev` (an
 * error), which the engine describes with the same message. Such a finding
 * counts as new at its new severity and carries `escalatedFrom`. A lowered
 * severity is still pre-existing.
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
  /** Set when the base had the same problem at this lower severity. */
  readonly escalatedFrom?: Severity;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

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
  const escalated = new Map<Finding, Severity>();
  // Matched to a base occurrence: pre-existing, unless the base was less severe.
  const matched = (finding: Finding, base: Finding): void => {
    if (RANK[finding.severity] > RANK[base.severity]) {
      classification.set(finding, 'new');
      escalated.set(finding, base.severity);
    } else {
      classification.set(finding, 'preexisting');
    }
  };
  // Among equivalent base occurrences, take the most severe, so an unchanged
  // error is never reported as raised just because a warning came first.
  const take = (candidates: Finding[], accept: (candidate: Finding) => boolean): Finding | undefined => {
    let best = -1;
    candidates.forEach((candidate, index) => {
      if (accept(candidate) && (best < 0 || RANK[candidate.severity] > RANK[candidates[best]!.severity])) best = index;
    });
    return best < 0 ? undefined : candidates.splice(best, 1)[0];
  };
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
      const base = take(unmatchedBase, (candidate) => evidenceKey(candidate) === evidenceKey(finding));
      if (base) matched(finding, base);
      else pending.push(finding);
    }
    // Pass 2: same identity, different evidence — still the same problem, as
    // long as the base has occurrences left to account for it.
    for (const finding of pending) {
      const base = take(unmatchedBase, () => true);
      if (base) matched(finding, base);
      else classification.set(finding, 'new');
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
    findings: findings.map((finding) => {
      const from = escalated.get(finding);
      return { finding, classification: classification.get(finding)!, ...(from ? { escalatedFrom: from } : {}) };
    }),
    gaps,
  };
}
