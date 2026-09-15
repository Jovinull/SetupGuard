import { describe, expect, it } from 'vitest';

import { SHOW_REPORT_COMMAND, summarise, toStatusBarState } from 'setupguard';

import { reportFor, summaryOf, syntheticReport } from './support.js';

/**
 * The status bar is the only part of SetupGuard most people look at, so the
 * rule it has to obey is narrow: it may never be greener than the report.
 */

describe('toStatusBarState', () => {
  it('says nothing is open when there is no folder', () => {
    const state = toStatusBarState({ phase: 'settled', reports: [], noWorkspace: true });
    expect(state.text).toBe('$(circle-slash) SetupGuard');
    expect(state.background).toBe('none');
  });

  it('spins while the first run is pending', () => {
    for (const phase of ['idle', 'running'] as const) {
      expect(toStatusBarState({ phase, reports: [] }).text).toBe('$(sync~spin) SetupGuard');
    }
  });

  it('shows Ready for a healthy project', async () => {
    const state = toStatusBarState({ phase: 'settled', reports: [await reportFor('healthy-pnpm')] });
    expect(state.text).toBe('$(pass) SetupGuard: Ready');
    expect(state.background).toBe('none');
  });

  it('shows Blocked with an error background', async () => {
    const state = toStatusBarState({
      phase: 'settled',
      reports: [await reportFor('broken-node-project')],
    });
    expect(state.text).toBe('$(error) SetupGuard: Blocked');
    expect(state.background).toBe('error');
  });

  it('shows Warnings for a project that runs but will bite later', async () => {
    const report = await reportFor('warnings-only');
    expect(report.readiness).toBe('WARNINGS');

    const state = toStatusBarState({ phase: 'settled', reports: [report] });
    expect(state.text).toBe('$(warning) SetupGuard: Warnings');
    expect(state.background).toBe('warning');
  });

  it('never presents an incomplete diagnosis as a pass', async () => {
    const report = await reportFor('empty-dir');
    expect(report.readiness).toBe('INCOMPLETE');

    const state = toStatusBarState({ phase: 'settled', reports: [report] });
    expect(state.text).toBe('$(question) SetupGuard: Incomplete');
    expect(state.text).not.toContain('Ready');
  });

  it('blames itself, not the project, when the extension fails', () => {
    const state = toStatusBarState({ phase: 'settled', reports: [], error: 'EACCES' });
    expect(state.text).toBe('$(question) SetupGuard: Incomplete');
    expect(state.tooltip).toContain('could not finish');
    expect(state.tooltip).toContain('EACCES');
  });

  it('prefers the extension error over a stale report', () => {
    const state = toStatusBarState({
      phase: 'settled',
      reports: [syntheticReport('READY')],
      error: 'EACCES',
    });
    expect(state.text).toBe('$(question) SetupGuard: Incomplete');
  });

  it('always points at the report command', () => {
    expect(toStatusBarState({ phase: 'settled', reports: [] }).command).toBe(SHOW_REPORT_COMMAND);
    expect(SHOW_REPORT_COMMAND).toBe('setupguard.showReport');
  });

  it('uses only Codicon names, never an emoji or an image', () => {
    const inputs = [
      { phase: 'settled', reports: [], noWorkspace: true },
      { phase: 'running', reports: [] },
      { phase: 'settled', reports: [syntheticReport('READY')] },
      { phase: 'settled', reports: [syntheticReport('WARNINGS')] },
      { phase: 'settled', reports: [syntheticReport('BLOCKED')] },
      { phase: 'settled', reports: [syntheticReport('INCOMPLETE')] },
    ] as const;

    for (const input of inputs) {
      const { text } = toStatusBarState(input);
      expect(text, text).toMatch(/^\$\([a-z-]+(~spin)?\) SetupGuard(: [A-Z][a-z]+)?$/);
    }
  });

  it('counts inconclusive and internal errors in the tooltip', () => {
    const state = toStatusBarState({
      phase: 'settled',
      reports: [
        syntheticReport('INCOMPLETE', {
          summary: summaryOf({ inconclusive: 2, internalErrors: 1, conclusive: 3 }),
        }),
      ],
    });
    expect(state.tooltip).toContain('2 inconclusive');
    expect(state.tooltip).toContain('1 failed internally');
  });
});

describe('summarise across a multi-root workspace', () => {
  it('reports the worst readiness, not the first', () => {
    expect(summarise([syntheticReport('READY'), syntheticReport('BLOCKED')]).readiness).toBe('BLOCKED');
    expect(summarise([syntheticReport('BLOCKED'), syntheticReport('READY')]).readiness).toBe('BLOCKED');
    expect(summarise([syntheticReport('WARNINGS'), syntheticReport('INCOMPLETE')]).readiness).toBe(
      'INCOMPLETE',
    );
    // "Not checked" outranks "checked, only warnings": one of them is a fact
    // about the project, the other is the absence of one.
    expect(summarise([syntheticReport('INCOMPLETE'), syntheticReport('WARNINGS')]).readiness).toBe(
      'INCOMPLETE',
    );
  });

  it('adds the counts up across folders', () => {
    const summary = summarise([
      syntheticReport('WARNINGS', { summary: summaryOf({ warnings: 2, conclusive: 4 }) }),
      syntheticReport('BLOCKED', { summary: summaryOf({ errors: 1, conclusive: 3 }) }),
    ]);

    expect(summary).toMatchObject({ errors: 1, warnings: 2, conclusive: 7, readiness: 'BLOCKED' });
  });

  it('counts configuration problems separately from project findings', () => {
    const summary = summarise([
      syntheticReport('INCOMPLETE', {
        config: {
          source: '.setupguard.yml',
          valid: false,
          diagnostics: [
            { code: 'config/version-missing', message: 'version is required', file: '.setupguard.yml' },
          ],
        },
      }),
    ]);

    expect(summary.configProblems).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it('is READY only when every folder is', () => {
    expect(summarise([syntheticReport('READY'), syntheticReport('READY')]).readiness).toBe('READY');
    expect(summarise([]).readiness).toBe('READY');
  });
});
