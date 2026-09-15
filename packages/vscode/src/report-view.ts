import type { Report } from '@setupguard/core';

/**
 * The plain-text report shown by `SetupGuard: Show Report`.
 *
 * Text rather than a WebView on purpose: the report is already a document, an
 * `OutputChannel` or a read-only editor renders it with zero new surface, and
 * there is no HTML to get escaping wrong in.
 *
 * Every string here comes from a `Report`, which the engine sanitises on the
 * way out. Nothing is added that the CLI would not print.
 */

export interface RenderReportOptions {
  /** Label for the folder the report belongs to, shown in multi-root setups. */
  readonly folderLabel?: string;
}

export function renderReport(report: Report, options: RenderReportOptions = {}): string {
  const lines: string[] = [];
  const heading = options.folderLabel ? `SetupGuard — ${options.folderLabel}` : 'SetupGuard';

  lines.push(heading, report.root, '');

  if (report.config.diagnostics.length > 0) {
    lines.push('Configuration');
    for (const diagnostic of report.config.diagnostics) {
      lines.push(`  ${diagnostic.message}`);
      lines.push(`    ${diagnostic.code} · ${location(diagnostic.file, diagnostic.line, diagnostic.column)}`);
      if (diagnostic.path) lines.push(`    field: ${diagnostic.path}`);
      if (diagnostic.remediation) lines.push(`    fix: ${diagnostic.remediation}`);
    }
    lines.push('  The run continued with default settings, so this diagnosis is incomplete.', '');
  }

  const withFindings = report.results.filter((result) => result.findings.length > 0);
  for (const result of withFindings) {
    lines.push(`${result.category} · ${result.checkId}`);
    for (const finding of result.findings) {
      lines.push(`  ${finding.severity.padEnd(7)}  ${finding.message}`);
      lines.push(`           ${finding.code} · confidence: ${finding.confidence}`);
      if (finding.explanation) lines.push(`           ${finding.explanation}`);
      if (finding.expected !== undefined) lines.push(`           expected: ${finding.expected}`);
      if (finding.actual !== undefined) lines.push(`           found:    ${finding.actual}`);
      for (const evidence of finding.evidence) {
        const where = location(evidence.file, evidence.line, evidence.column);
        const detail = evidence.detail ? ` — ${evidence.detail}` : '';
        if (where || detail) lines.push(`           at ${where || 'workspace'}${detail}`);
      }
      if (finding.remediation) lines.push(`           fix: ${finding.remediation}`);
      lines.push('');
    }
  }

  const unfinished = report.results.filter(
    (result) => result.status === 'internal-error' || result.status === 'inconclusive',
  );
  if (unfinished.length > 0) {
    lines.push('Not verified');
    for (const result of unfinished) {
      lines.push(`  ${result.checkId}: ${result.reason ?? 'unknown reason'}`);
    }
    lines.push('  These are limits of the diagnosis, not evidence that the project is broken.', '');
  }

  const { errors, warnings, conclusive } = report.summary;
  lines.push(
    [
      `${errors} blocker${errors === 1 ? '' : 's'}`,
      `${warnings} warning${warnings === 1 ? '' : 's'}`,
      `${conclusive} check${conclusive === 1 ? '' : 's'} verified`,
    ].join(' · '),
  );
  lines.push(report.readiness);
  if (report.incompleteReason) lines.push(report.incompleteReason);
  lines.push(`Verified against levels: ${report.levelsRequested.join(', ')}.`);

  return lines.join('\n');
}

/** Join several folders' reports into one document, newest run first. */
export function renderReports(
  entries: readonly { readonly label: string; readonly report: Report }[],
): string {
  if (entries.length === 0) {
    return 'SetupGuard\n\nNo diagnosis has run yet. Run "SetupGuard: Run Diagnosis" to produce one.';
  }
  if (entries.length === 1 && entries[0]) {
    return renderReport(entries[0].report);
  }
  return entries
    .map((entry) => renderReport(entry.report, { folderLabel: entry.label }))
    .join(`\n\n${'-'.repeat(72)}\n\n`);
}

function location(file?: string, line?: number, column?: number): string {
  if (!file) return '';
  if (line === undefined) return file;
  if (column === undefined) return `${file}:${line}`;
  return `${file}:${line}:${column}`;
}
