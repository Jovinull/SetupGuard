import type {
  Category,
  CheckResult,
  Finding,
  Report,
  Severity,
  VerificationLevel,
} from '@setupguard/core';

/** ANSI helpers. Disabled entirely when colour is off, so output stays diffable. */
export interface Theme {
  readonly enabled: boolean;
}

const CODES = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  green: '\u001B[32m',
  blue: '\u001B[34m',
} as const;

function paint(theme: Theme, code: keyof typeof CODES, value: string): string {
  return theme.enabled ? `${CODES[code]}${value}${CODES.reset}` : value;
}

const STATUS_GLYPH: Record<CheckResult['status'], string> = {
  pass: '✓',
  warning: '!',
  error: '✗',
  skipped: '○',
  'not-applicable': '–',
  inconclusive: '?',
  'internal-error': '⚠',
};

/** Width of the severity column, so continuation lines align under the message. */
const LABEL_WIDTH = 7;

const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

const CATEGORY_LABEL: Record<Category, string> = {
  environment: 'Environment',
  dependencies: 'Dependencies',
  configuration: 'Configuration',
  services: 'Services',
  project: 'Project',
  documentation: 'Documentation',
};

const LEVEL_LABEL: Record<VerificationLevel, string> = {
  static: 'Static',
  environment: 'Environment',
  connectivity: 'Connectivity',
  verification: 'Verification',
};

export interface RenderOptions {
  readonly color: boolean;
  /** Also list checks that passed or did not apply. */
  readonly verbose: boolean;
}

/** Render a report for a terminal. */
export function renderHuman(report: Report, options: RenderOptions): string {
  const theme: Theme = { enabled: options.color };
  const lines: string[] = [];

  lines.push(paint(theme, 'bold', 'SetupGuard'));
  lines.push(paint(theme, 'dim', report.root));
  lines.push('');

  lines.push(...renderLevelSummary(report, theme));
  lines.push('');

  const withFindings = report.results.filter((result) => result.findings.length > 0);
  for (const result of withFindings) {
    lines.push(...renderResult(result, theme));
  }

  const unfinished = report.results.filter(
    (result) => result.status === 'internal-error' || result.status === 'inconclusive',
  );
  if (unfinished.length > 0) {
    lines.push(paint(theme, 'bold', 'Not verified'));
    for (const result of unfinished) {
      const glyph = STATUS_GLYPH[result.status];
      lines.push(`  ${glyph} ${result.checkId}: ${result.reason ?? 'unknown reason'}`);
    }
    lines.push(
      paint(
        theme,
        'dim',
        '  These are limits of the diagnosis, not evidence that the project is broken.',
      ),
    );
    lines.push('');
  }

  if (options.verbose) {
    lines.push(paint(theme, 'bold', 'All checks'));
    for (const result of report.results) {
      const glyph = colorizeStatus(theme, result.status, STATUS_GLYPH[result.status]);
      const suffix = result.reason ? paint(theme, 'dim', ` — ${result.reason}`) : '';
      lines.push(`  ${glyph} ${result.checkId}${suffix}`);
    }
    lines.push('');
  }

  lines.push(...renderFooter(report, theme));
  return lines.join('\n');
}

/**
 * One line per verification level.
 *
 * A level is green only when something in it actually concluded. Deriving the
 * glyph from findings alone painted a level green when every check in it had
 * ended as `internal-error` or `inconclusive` — a green tick for work that
 * never happened.
 */
function renderLevelSummary(report: Report, theme: Theme): string[] {
  const lines: string[] = [];
  const width = 16;

  for (const level of ['static', 'environment', 'connectivity', 'verification'] as const) {
    const results = report.results.filter((result) => result.level === level);
    const label = LEVEL_LABEL[level].padEnd(width);

    if (!report.levelsRequested.includes(level)) {
      lines.push(`${label}${paint(theme, 'dim', `${STATUS_GLYPH.skipped} not run`)}`);
      continue;
    }
    if (results.length === 0) {
      lines.push(
        `${label}${paint(theme, 'yellow', `${STATUS_GLYPH.inconclusive} no checks for this level`)}`,
      );
      continue;
    }

    const errors = countSeverity(results, 'error');
    const warnings = countSeverity(results, 'warning');
    const conclusive = results.filter(
      (result) =>
        result.status === 'pass' || result.status === 'warning' || result.status === 'error',
    ).length;

    if (errors > 0) lines.push(`${label}${paint(theme, 'red', STATUS_GLYPH.error)}`);
    else if (warnings > 0) lines.push(`${label}${paint(theme, 'yellow', STATUS_GLYPH.warning)}`);
    else if (conclusive === 0) {
      lines.push(
        `${label}${paint(theme, 'yellow', `${STATUS_GLYPH.inconclusive} nothing verified`)}`,
      );
    } else lines.push(`${label}${paint(theme, 'green', STATUS_GLYPH.pass)}`);
  }

  return lines;
}

function renderResult(result: CheckResult, theme: Theme): string[] {
  const lines: string[] = [];
  lines.push(
    `${paint(theme, 'bold', CATEGORY_LABEL[result.category])} ${paint(theme, 'dim', `· ${result.checkId}`)}`,
  );

  for (const finding of result.findings) {
    lines.push(...renderFinding(finding, theme));
  }
  lines.push('');
  return lines;
}

function renderFinding(finding: Finding, theme: Theme): string[] {
  const lines: string[] = [];
  const color = finding.severity === 'error' ? 'red' : finding.severity === 'warning' ? 'yellow' : 'blue';
  // Pad before colouring: ANSI codes would otherwise count towards the width.
  const label = paint(theme, color, SEVERITY_LABEL[finding.severity].padEnd(LABEL_WIDTH));
  const indent = ' '.repeat(2 + LABEL_WIDTH + 2);

  lines.push(`  ${label}  ${finding.message}`);
  lines.push(paint(theme, 'dim', `${indent}${finding.code} · confidence: ${finding.confidence}`));

  if (finding.explanation) lines.push(`${indent}${finding.explanation}`);
  if (finding.expected !== undefined) lines.push(`${indent}expected: ${finding.expected}`);
  if (finding.actual !== undefined) lines.push(`${indent}found:    ${finding.actual}`);

  for (const evidence of finding.evidence) {
    const location = formatLocation(evidence.file, evidence.line, evidence.column);
    if (!location && !evidence.detail) continue;
    const detail = evidence.detail ? ` — ${evidence.detail}` : '';
    lines.push(paint(theme, 'dim', `${indent}at ${location || 'workspace'}${detail}`));
  }

  if (finding.remediation) lines.push(`${indent}fix: ${finding.remediation}`);
  lines.push('');
  return lines;
}

function renderFooter(report: Report, theme: Theme): string[] {
  const { errors, warnings, conclusive, inconclusive, internalErrors } = report.summary;
  const parts: string[] = [];
  parts.push(`${errors} blocker${errors === 1 ? '' : 's'}`);
  parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  parts.push(`${conclusive} check${conclusive === 1 ? '' : 's'} verified`);

  const notRun = report.summary.skipped + report.summary.notApplicable;
  if (notRun > 0) parts.push(`${notRun} not run`);
  if (inconclusive > 0) parts.push(`${inconclusive} inconclusive`);
  if (internalErrors > 0) parts.push(`${internalErrors} failed internally`);

  const readinessColor =
    report.readiness === 'BLOCKED'
      ? 'red'
      : report.readiness === 'WARNINGS' || report.readiness === 'INCOMPLETE'
        ? 'yellow'
        : 'green';

  const lines = [
    parts.join(' · '),
    paint(theme, readinessColor, paint(theme, 'bold', report.readiness)),
  ];

  if (report.readiness === 'INCOMPLETE') {
    lines.push(
      paint(
        theme,
        'yellow',
        report.incompleteReason ?? 'The diagnosis is partial, so this is not a pass.',
      ),
    );
  }

  if (report.readiness === 'READY' || report.readiness === 'WARNINGS') {
    lines.push(
      paint(
        theme,
        'dim',
        `Verified against levels: ${report.levelsRequested.join(', ')}. Deeper levels were not executed.`,
      ),
    );
  }

  return lines;
}

function countSeverity(results: readonly CheckResult[], severity: Severity): number {
  return results.reduce(
    (total, result) =>
      total + result.findings.filter((finding) => finding.severity === severity).length,
    0,
  );
}

function colorizeStatus(theme: Theme, status: CheckResult['status'], glyph: string): string {
  switch (status) {
    case 'pass':
      return paint(theme, 'green', glyph);
    case 'warning':
      return paint(theme, 'yellow', glyph);
    case 'error':
      return paint(theme, 'red', glyph);
    default:
      return paint(theme, 'dim', glyph);
  }
}

/** `README.md:47:3`, `README.md:47`, `README.md`, or `''`. */
export function formatLocation(file?: string, line?: number, column?: number): string {
  if (!file) return '';
  if (line === undefined) return file;
  if (column === undefined) return `${file}:${line}`;
  return `${file}:${line}:${column}`;
}
