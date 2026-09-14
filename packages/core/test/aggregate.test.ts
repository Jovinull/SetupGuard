import { describe, expect, it } from 'vitest';

import {
  aggregateReadiness,
  incompleteReason,
  summarize,
  type CheckResult,
  type CheckStatus,
  type Readiness,
  type Severity,
} from '@setupguard/core';

/** Build a result in the given status, with matching findings where relevant. */
function result(status: CheckStatus, index = 0): CheckResult {
  const finding = (severity: Severity) => ({
    checkId: `demo/${index}`,
    code: `demo/${severity}`,
    severity,
    confidence: 'high' as const,
    message: `a ${severity}`,
    evidence: [],
  });

  return {
    checkId: `demo/${index}`,
    title: `demo ${index}`,
    category: 'project',
    level: 'static',
    status,
    findings:
      status === 'error' ? [finding('error')] : status === 'warning' ? [finding('warning')] : [],
    durationMs: 0,
    ...(status === 'pass' || status === 'warning' || status === 'error'
      ? {}
      : { reason: `because ${status}` }),
  };
}

function readiness(...statuses: CheckStatus[]): Readiness {
  return aggregateReadiness(statuses.map((status, index) => result(status, index)));
}

describe('aggregateReadiness precedence', () => {
  // The table is the specification. Every row states which single status
  // decides the outcome, in the documented order:
  //   error > internal-error > inconclusive > warning > nothing-conclusive
  const cases: readonly [CheckStatus[], Readiness, string][] = [
    [[], 'INCOMPLETE', 'no results at all'],
    [['pass'], 'READY', 'one clean check is enough evidence'],
    [['pass', 'pass'], 'READY', 'several clean checks'],
    [['pass', 'not-applicable'], 'READY', 'not-applicable does not reduce evidence'],
    [['pass', 'skipped'], 'READY', 'a skipped level does not reduce evidence'],
    [['skipped'], 'INCOMPLETE', 'everything skipped means nothing verified'],
    [['not-applicable'], 'INCOMPLETE', 'nothing applied, so nothing was verified'],
    [['warning'], 'WARNINGS', 'a warning with no gaps'],
    [['pass', 'warning'], 'WARNINGS', 'warnings survive alongside passes'],
    [['error'], 'BLOCKED', 'a confirmed defect'],
    [['warning', 'error'], 'BLOCKED', 'error outranks warning'],
    [['inconclusive'], 'INCOMPLETE', 'a check that could not decide'],
    [['internal-error'], 'INCOMPLETE', 'a SetupGuard failure'],

    // The four rows the re-QA found wrong.
    [['pass', 'inconclusive'], 'INCOMPLETE', 'a pass must not paper over an unverified check'],
    [['pass', 'internal-error'], 'INCOMPLETE', 'a pass must not paper over a crash'],
    [['warning', 'internal-error'], 'INCOMPLETE', 'a warning must not hide a SetupGuard failure'],
    [['warning', 'inconclusive'], 'INCOMPLETE', 'a warning must not hide an unverified check'],

    // BLOCKED still wins: an error finding is evidence that was gathered, so a
    // partial diagnosis that already found a blocker is still a blocker.
    [['error', 'inconclusive'], 'BLOCKED', 'error outranks an unverified check'],
    [['error', 'internal-error'], 'BLOCKED', 'error outranks a crash'],
  ];

  for (const [statuses, expected, why] of cases) {
    it(`${statuses.length === 0 ? '(nothing)' : statuses.join(' + ')} -> ${expected} — ${why}`, () => {
      expect(readiness(...statuses)).toBe(expected);
    });
  }
});

describe('incompleteReason', () => {
  it('names the status that actually decided the outcome', () => {
    expect(incompleteReason([])).toMatch(/no supported project was detected/i);
    expect(incompleteReason([result('skipped')])).toMatch(/No check reached a conclusion/);
    expect(incompleteReason([result('pass'), result('inconclusive', 1)])).toMatch(
      /could not reach a conclusion/,
    );
    expect(incompleteReason([result('pass'), result('internal-error', 1)])).toMatch(
      /failed inside SetupGuard/,
    );
  });

  it('prefers the crash over the unverified check, matching the precedence', () => {
    expect(incompleteReason([result('internal-error'), result('inconclusive', 1)])).toMatch(
      /failed inside SetupGuard/,
    );
  });

  it('is absent when readiness is not INCOMPLETE', () => {
    expect(incompleteReason([result('error')])).toBeUndefined();
    expect(incompleteReason([result('warning')])).toBeUndefined();
    expect(incompleteReason([result('pass')])).toBeUndefined();
  });
});

describe('summarize', () => {
  it('counts conclusive checks separately from the rest', () => {
    const summary = summarize([
      result('pass'),
      result('warning', 1),
      result('error', 2),
      result('skipped', 3),
      result('not-applicable', 4),
      result('inconclusive', 5),
      result('internal-error', 6),
    ]);

    expect(summary).toEqual({
      errors: 1,
      warnings: 1,
      infos: 0,
      passed: 1,
      skipped: 1,
      notApplicable: 1,
      inconclusive: 1,
      internalErrors: 1,
      conclusive: 3,
    });
  });
});
