import type { CheckResult, CheckStatus, Finding, Report } from '@setupguard/core';
import { describe, expect, it } from 'vitest';

import { compareReports, decidePullRequest } from '../src/index.js';

/** The regression policy, on hand-built reports for the cases fixtures cannot reach cheaply. */

function finding(message: string, line: number, extra: Partial<Finding> = {}): Finding {
  return {
    checkId: 'node/docs-script-drift',
    code: 'node/docs-script-not-found',
    severity: 'error',
    confidence: 'high',
    message,
    evidence: [{ file: 'README.md', line, excerpt: message }],
    ...extra,
  };
}

function report(findings: Finding[], status: CheckStatus = findings.length ? 'error' : 'pass', valid = true): Report {
  const result: CheckResult = {
    checkId: 'node/docs-script-drift',
    title: 'Docs',
    category: 'documentation',
    level: 'static',
    status,
    findings,
    durationMs: 0,
  };
  return {
    schemaVersion: 1,
    generatedAt: '',
    root: '/r',
    readiness: findings.length ? 'BLOCKED' : 'READY',
    levelsRequested: ['static'],
    adapters: [],
    results: [result],
    summary: {
      errors: findings.length,
      warnings: 0,
      infos: 0,
      passed: 0,
      skipped: 0,
      notApplicable: 0,
      inconclusive: 0,
      internalErrors: 0,
      conclusive: 1,
    },
    config: { valid, diagnostics: [] },
    hasInternalErrors: false,
    durationMs: 0,
  };
}

const classes = (head: Report, base: Report) => compareReports(head, base).findings.map((f) => f.classification);

describe('compareReports', () => {
  it('ignores line numbers when deciding identity', () => {
    expect(classes(report([finding('run "npm x"', 40)]), report([finding('run "npm x"', 3)]))).toEqual(['preexisting']);
  });

  it('flags only the surplus when an existing problem gains a second occurrence', () => {
    const base = report([finding('run "npm x"', 3)]);
    const head = report([
      { ...finding('run "npm x"', 1), evidence: [{ file: 'README.md', line: 1, excerpt: 'new place' }] },
      finding('run "npm x"', 9),
    ]);
    // The occurrence whose evidence matches the base is the old one, wherever it moved.
    expect(classes(head, base)).toEqual(['new', 'preexisting']);
  });

  it('counts a problem whose severity the pull request raised as new, and records from what', () => {
    const base = report([finding('run "npm x"', 3, { severity: 'warning' })]);
    const comparison = compareReports(report([finding('run "npm x"', 3)]), base);
    expect(comparison.findings.map((f) => [f.classification, f.escalatedFrom])).toEqual([['new', 'warning']]);
  });

  it('keeps a problem whose severity was lowered as pre-existing', () => {
    const base = report([finding('run "npm x"', 3)]);
    const comparison = compareReports(report([finding('run "npm x"', 3, { severity: 'warning' })]), base);
    expect(comparison.findings.map((f) => [f.classification, f.escalatedFrom])).toEqual([['preexisting', undefined]]);
  });

  it('matches an unchanged error to the base error, not to a less severe twin', () => {
    const base = report([finding('run "npm x"', 3, { severity: 'warning' }), finding('run "npm x"', 3)]);
    const head = report([finding('run "npm x"', 3)]);
    expect(compareReports(head, base).findings.map((f) => f.classification)).toEqual(['preexisting']);
  });

  it.each<CheckStatus>(['inconclusive', 'internal-error', 'skipped'])(
    'leaves findings unclassified when the base check was %s',
    (status) => {
      const comparison = compareReports(report([finding('run "npm x"', 3)]), report([], status));
      expect(comparison.findings.map((f) => f.classification)).toEqual(['unclassified']);
      expect(comparison.gaps[0]).toContain(status);
    },
  );

  it('treats a check that did not apply on the base as a clean base', () => {
    expect(classes(report([finding('run "npm x"', 3)]), report([], 'not-applicable'))).toEqual(['new']);
  });

  it('refuses to compare against a base whose configuration could not be applied', () => {
    const comparison = compareReports(report([finding('run "npm x"', 3)]), report([finding('run "npm x"', 3)], 'error', false));
    expect(comparison.findings.map((f) => f.classification)).toEqual(['unclassified']);
  });
});

describe('decidePullRequest', () => {
  const info = { baseRef: 'b'.repeat(40), checkout: 'merge' as const, changedFiles: 1, relevantPaths: 1 };

  it('makes an unclassified blocker INCOMPLETE, never a pass', () => {
    const head = report([finding('run "npm x"', 3)]);
    const base = report([], 'inconclusive');
    const compared = { base, info, ...compareReports(head, base) };
    const analysis = decidePullRequest(head, compared, 'error', '', [], 1);
    expect(analysis.result).toBe('incomplete');
  });

  it('lets a proven new blocker outrank a gap, like the engine does', () => {
    const head = report([finding('run "npm x"', 3)]);
    const headPartial: Report = {
      ...head,
      results: [...head.results, { ...head.results[0]!, checkId: 'node/env-contract', status: 'inconclusive', findings: [] }],
    };
    const base = report([]);
    const analysis = decidePullRequest(headPartial, { base, info, ...compareReports(headPartial, base) }, 'error', '', [], 1);
    expect(analysis.result).toBe('fail');
    expect(analysis.reasons[0]).toContain('introduces 1 blocking problem');
    expect(analysis.reasons).toContainEqual(expect.stringMatching(/^node\/env-contract \(inconclusive\)/));
  });

  it('passes an unclassified warning when only errors fail the job', () => {
    const head = report([finding('run "npm x"', 3, { severity: 'warning' })]);
    const base = report([], 'inconclusive');
    expect(decidePullRequest(head, { base, info, ...compareReports(head, base) }, 'error', '', [], 1).result).toBe('pass');
    expect(decidePullRequest(head, { base, info, ...compareReports(head, base) }, 'warning', '', [], 1).result).toBe('incomplete');
  });
});
