import type { Readiness, Report } from '@setupguard/core';

import type { SessionState } from './session.js';

/**
 * The status bar item, derived from session state.
 *
 * Pure, so every transition can be asserted without an Extension Host. Icons
 * are Codicon names, which VS Code renders from `$(name)` — no custom assets.
 */

export interface StatusBarState {
  /** Ready for `StatusBarItem.text`, Codicon markup included. */
  readonly text: string;
  readonly tooltip: string;
  /** Which background VS Code should use. `none` means the default. */
  readonly background: 'none' | 'warning' | 'error';
  readonly command: string;
}

export const SHOW_REPORT_COMMAND = 'setupguard.showReport';

/** Counts merged across every analysed folder. */
export interface AggregateSummary {
  readonly readiness: Readiness;
  readonly errors: number;
  readonly warnings: number;
  readonly conclusive: number;
  readonly inconclusive: number;
  readonly internalErrors: number;
  readonly configProblems: number;
}

/**
 * Worst-first ordering when several folders are analysed.
 *
 * `BLOCKED` leads because a folder that is genuinely blocked is the most
 * actionable fact on screen; `INCOMPLETE` follows because "not checked" must
 * still outrank "checked and only warnings".
 */
const READINESS_RANK: Record<Readiness, number> = {
  BLOCKED: 3,
  INCOMPLETE: 2,
  WARNINGS: 1,
  READY: 0,
};

export function summarise(reports: readonly Report[]): AggregateSummary {
  let readiness: Readiness = 'READY';
  let errors = 0;
  let warnings = 0;
  let conclusive = 0;
  let inconclusive = 0;
  let internalErrors = 0;
  let configProblems = 0;

  for (const report of reports) {
    if (READINESS_RANK[report.readiness] > READINESS_RANK[readiness]) {
      readiness = report.readiness;
    }
    errors += report.summary.errors;
    warnings += report.summary.warnings;
    conclusive += report.summary.conclusive;
    inconclusive += report.summary.inconclusive;
    internalErrors += report.summary.internalErrors;
    configProblems += report.config.diagnostics.length;
  }

  return { readiness, errors, warnings, conclusive, inconclusive, internalErrors, configProblems };
}

export interface StatusInput {
  readonly phase: SessionState['phase'];
  readonly reports: readonly Report[];
  /** Set when the extension itself failed. Never a statement about the project. */
  readonly error?: string;
  /** True when VS Code has no folder open, or none of them is analysable. */
  readonly noWorkspace?: boolean;
}

export function toStatusBarState(input: StatusInput): StatusBarState {
  if (input.noWorkspace) {
    return {
      text: '$(circle-slash) SetupGuard',
      tooltip: 'SetupGuard\nNo folder open to analyse.',
      background: 'none',
      command: SHOW_REPORT_COMMAND,
    };
  }

  if (input.error !== undefined) {
    return {
      text: '$(question) SetupGuard: Incomplete',
      // An extension failure is a SetupGuard problem, and the wording has to
      // keep it from reading as a verdict on the repository.
      tooltip: `SetupGuard could not finish\n${input.error}`,
      background: 'warning',
      command: SHOW_REPORT_COMMAND,
    };
  }

  if (input.phase === 'running' || input.phase === 'idle') {
    return {
      text: '$(sync~spin) SetupGuard',
      tooltip: 'SetupGuard: checking…',
      background: 'none',
      command: SHOW_REPORT_COMMAND,
    };
  }

  const summary = summarise(input.reports);
  const tooltip = buildTooltip(summary);

  switch (summary.readiness) {
    case 'BLOCKED':
      return {
        text: '$(error) SetupGuard: Blocked',
        tooltip,
        background: 'error',
        command: SHOW_REPORT_COMMAND,
      };
    case 'WARNINGS':
      return {
        text: '$(warning) SetupGuard: Warnings',
        tooltip,
        background: 'warning',
        command: SHOW_REPORT_COMMAND,
      };
    case 'INCOMPLETE':
      return {
        text: '$(question) SetupGuard: Incomplete',
        tooltip,
        // Not an error background: nothing has been proven wrong with the
        // project, only that part of the diagnosis did not happen.
        background: 'warning',
        command: SHOW_REPORT_COMMAND,
      };
    case 'READY':
      return {
        text: '$(pass) SetupGuard: Ready',
        tooltip,
        background: 'none',
        command: SHOW_REPORT_COMMAND,
      };
  }
}

function buildTooltip(summary: AggregateSummary): string {
  const lines = [
    plural(summary.errors, 'error'),
    plural(summary.warnings, 'warning'),
    `${summary.conclusive} check${summary.conclusive === 1 ? '' : 's'} concluded`,
  ];
  if (summary.inconclusive > 0) lines.push(`${summary.inconclusive} inconclusive`);
  if (summary.internalErrors > 0) lines.push(`${summary.internalErrors} failed internally`);
  if (summary.configProblems > 0) {
    lines.push(plural(summary.configProblems, 'configuration problem'));
  }
  return lines.join('\n');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
