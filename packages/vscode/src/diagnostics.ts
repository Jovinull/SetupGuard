import { allFindings, type Finding, type Report, type Severity } from '@setupguard/core';

/**
 * Editor-facing projection of a report.
 *
 * This package deliberately does **not** depend on the `vscode` module. The
 * mapping from findings to diagnostics is pure data — ranges, severities,
 * messages — so it can be unit-tested without an extension host, and the
 * extension itself becomes a thin shell that converts these records into
 * `vscode.Diagnostic` objects and publishes them.
 *
 * v0.1 stops here on purpose: the milestone is the engine, not the UI
 * (`Notes/07-extensao-vscode.md`).
 */

/** Mirrors `vscode.DiagnosticSeverity`. */
export const DIAGNOSTIC_SEVERITY = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITY)[keyof typeof DIAGNOSTIC_SEVERITY];

/** 0-based, like `vscode.Position`. */
export interface DiagnosticPosition {
  readonly line: number;
  readonly character: number;
}

export interface DiagnosticRange {
  readonly start: DiagnosticPosition;
  readonly end: DiagnosticPosition;
}

export interface EditorDiagnostic {
  /** Workspace-relative POSIX path the diagnostic belongs to. */
  readonly file: string;
  readonly range: DiagnosticRange;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Stable finding code, shown in the Problems panel. */
  readonly code: string;
  readonly source: 'SetupGuard';
  readonly checkId: string;
}

/** Findings with no file evidence cannot be placed in the editor. */
export interface DiagnosticsProjection {
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly unplaced: readonly Finding[];
}

const SEVERITY_MAP: Record<Severity, DiagnosticSeverity> = {
  error: DIAGNOSTIC_SEVERITY.Error,
  warning: DIAGNOSTIC_SEVERITY.Warning,
  info: DIAGNOSTIC_SEVERITY.Information,
};

export function toDiagnostics(report: Report): DiagnosticsProjection {
  const diagnostics: EditorDiagnostic[] = [];
  const unplaced: Finding[] = [];

  for (const finding of allFindings(report)) {
    const located = finding.evidence.find((evidence) => evidence.file !== undefined);
    if (!located?.file) {
      unplaced.push(finding);
      continue;
    }

    diagnostics.push({
      file: located.file,
      range: toRange(located.line, located.column, located.endLine, located.endColumn),
      severity: SEVERITY_MAP[finding.severity],
      message: buildMessage(finding),
      code: finding.code,
      source: 'SetupGuard',
      checkId: finding.checkId,
    });
  }

  return { diagnostics, unplaced };
}

/**
 * Convert SetupGuard's 1-based positions into the editor's 0-based ones.
 * A finding that names only a file is anchored to the start of that file.
 */
function toRange(
  line?: number,
  column?: number,
  endLine?: number,
  endColumn?: number,
): DiagnosticRange {
  const startLine = Math.max(0, (line ?? 1) - 1);
  const startCharacter = Math.max(0, (column ?? 1) - 1);
  const finishLine = Math.max(startLine, (endLine ?? line ?? 1) - 1);
  const finishCharacter =
    endColumn !== undefined ? Math.max(0, endColumn - 1) : Number.MAX_SAFE_INTEGER;

  return {
    start: { line: startLine, character: startCharacter },
    end: { line: finishLine, character: finishCharacter },
  };
}

/**
 * Problems-panel message: the headline, then the expectation gap, in the shape
 * the product notes describe for documentation drift.
 */
function buildMessage(finding: Finding): string {
  const lines = [finding.message];
  if (finding.expected !== undefined) lines.push(`Expected: ${finding.expected}`);
  if (finding.actual !== undefined) lines.push(`Found: ${finding.actual}`);
  return lines.join('\n');
}
