import type { Evidence, Finding } from '@setupguard/core';

import { joinPrefix, type Analysis } from './analyse.js';
import type { ClassifiedFinding } from './compare.js';
import type { Annotation, AnnotationLevel } from './workflow-commands.js';

/**
 * Turning an {@link Analysis} into what a maintainer sees: annotations on the
 * diff, a job summary, and the log.
 *
 * All three carry text that came from the pull request. Annotations are
 * escaped by `formatAnnotation`, the log is printed inside a stop-commands
 * region, and the summary escapes every character HTML or Markdown would act
 * on — a README line like `![x](https://tracker/pixel)` is shown, not loaded.
 */

/**
 * Annotations per level. Every finding is in the summary; annotations are the
 * short list pinned to the diff, so they are kept to what a reviewer reads.
 */
export const MAX_ANNOTATIONS_PER_LEVEL = 10;

/** Rows per table in the summary, which the runner caps at 1 MiB per step. */
const MAX_ROWS = 200;

const RESULT_TITLE: Record<Analysis['result'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  incomplete: 'INCOMPLETE',
};

function primaryEvidence(finding: Finding): Evidence | undefined {
  return finding.evidence.find((e) => e.file !== undefined);
}

function location(finding: Finding, prefix: string): string {
  const evidence = primaryEvidence(finding);
  if (evidence?.file === undefined) return '';
  const file = joinPrefix(prefix, evidence.file);
  return evidence.line !== undefined ? `${file}:${evidence.line}` : file;
}

function describe(finding: Finding): string {
  const parts = [finding.message];
  if (finding.explanation) parts.push('', finding.explanation);
  if (finding.remediation) parts.push('', `Fix: ${finding.remediation}`);
  return parts.join('\n');
}

export function buildAnnotations(analysis: Analysis): Annotation[] {
  const annotations: Annotation[] = [];
  const counts: Record<AnnotationLevel, number> = { error: 0, warning: 0, notice: 0 };

  if (analysis.result === 'incomplete') {
    annotations.push({
      level: 'error',
      title: 'SetupGuard: analysis incomplete',
      message: `${analysis.reasons.join('\n')}\n\nThis is not a pass: part of the diagnosis did not happen.`,
    });
    counts.error += 1;
  }

  const levelFor = (item: ClassifiedFinding): AnnotationLevel | null => {
    if (item.finding.severity === 'info') return null;
    // Pre-existing problems are not pinned to the diff: they are not what this
    // pull request is being reviewed for. They are listed in the summary.
    if (item.classification === 'preexisting') return null;
    if (item.classification === 'unclassified') return 'notice';
    return item.finding.severity;
  };

  for (const item of analysis.findings) {
    const level = levelFor(item);
    if (level === null || counts[level] >= MAX_ANNOTATIONS_PER_LEVEL) continue;
    counts[level] += 1;
    const evidence = primaryEvidence(item.finding);
    const prefixLabel =
      analysis.mode === 'full' ? '' : item.classification === 'unclassified' ? 'unverified · ' : 'new · ';
    annotations.push({
      level,
      title: `SetupGuard: ${prefixLabel}${item.finding.checkId}`,
      message:
        item.classification === 'unclassified'
          ? `${describe(item.finding)}\n\nSetupGuard could not tell whether this pull request introduced it.`
          : describe(item.finding),
      ...(evidence?.file !== undefined
        ? {
            file: joinPrefix(analysis.prefix, evidence.file),
            ...(evidence.line !== undefined ? { line: evidence.line } : {}),
            ...(evidence.endLine !== undefined ? { endLine: evidence.endLine } : {}),
            // A column range only makes sense on one line.
            ...(evidence.column !== undefined && (evidence.endLine === undefined || evidence.endLine === evidence.line)
              ? { col: evidence.column }
              : {}),
            ...(evidence.endColumn !== undefined && (evidence.endLine === undefined || evidence.endLine === evidence.line)
              ? { endColumn: evidence.endColumn }
              : {}),
          }
        : {}),
    });
  }
  return annotations;
}

function counts(analysis: Analysis): { newErrors: number; newWarnings: number; preexisting: number; unclassified: number } {
  const of = (classification: string, severity?: string) =>
    analysis.findings.filter(
      (f) => f.classification === classification && (severity === undefined || f.finding.severity === severity),
    ).length;
  return {
    newErrors: of('new', 'error'),
    newWarnings: of('new', 'warning'),
    preexisting: of('preexisting'),
    unclassified: of('unclassified'),
  };
}

export function buildOutputs(analysis: Analysis): Record<string, string | number> {
  const c = counts(analysis);
  return {
    result: analysis.result,
    readiness: analysis.head?.readiness ?? 'INCOMPLETE',
    'new-errors': c.newErrors,
    'new-warnings': c.newWarnings,
  };
}

/** Plain-text log. Printed by the caller inside a stop-commands region. */
export function renderLog(analysis: Analysis): string {
  const lines: string[] = [];
  const short = (sha: string) => sha.slice(0, 12);
  lines.push(
    analysis.mode === 'pull-request'
      ? `SetupGuard — pull request${analysis.pullRequest !== undefined ? ` #${analysis.pullRequest}` : ''}`
      : 'SetupGuard — full diagnosis of the checkout',
  );
  if (analysis.comparison) {
    lines.push(
      `Compared with base ${short(analysis.comparison.baseRef)} (${analysis.comparison.checkout} checkout); ` +
        `${analysis.comparison.changedFiles} file(s) changed, ${analysis.comparison.relevantPaths} inside the analysed directory`,
    );
  }
  if (analysis.apiCalls.length > 0) {
    lines.push('', `GitHub API requests (${analysis.apiCalls.length}):`);
    for (const call of analysis.apiCalls) {
      const retries = call.attempts > 1 ? ` after ${call.attempts} attempts` : '';
      lines.push(`  ${call.method} ${call.path} -> ${call.status ?? 'no response'}${retries}`);
    }
  }

  lines.push('', `Result: ${RESULT_TITLE[analysis.result]}`);
  for (const reason of analysis.reasons) lines.push(`  - ${reason}`);

  const section = (title: string, items: readonly ClassifiedFinding[]) => {
    if (items.length === 0) return;
    lines.push('', `${title} (${items.length}):`);
    for (const { finding } of items) {
      const where = location(finding, analysis.prefix);
      lines.push(`  ${finding.severity.padEnd(7)} ${where ? `${where}  ` : ''}${finding.message}`);
      if (finding.remediation) lines.push(`          fix: ${finding.remediation}`);
    }
  };
  if (analysis.mode === 'full') {
    section('Problems', analysis.findings);
  } else {
    section('New in this pull request', analysis.findings.filter((f) => f.classification === 'new'));
    section('Could not be compared with the base', analysis.findings.filter((f) => f.classification === 'unclassified'));
    section('Already on the base branch (not caused by this pull request)', analysis.findings.filter((f) => f.classification === 'preexisting'));
  }
  return lines.join('\n');
}

/** Escape text for an HTML context inside the summary. Also neutralises Markdown. */
export function escapeHtml(value: string): string {
  return (
    value
      // Inside an HTML block GitHub does not parse Markdown, but a blank line
      // ends the block. Collapsing whitespace keeps every cell on one line.
      .replace(/\s+/g, ' ')
      // One pass, so an entity produced here is never escaped a second time.
      // Beyond the HTML metacharacters, Markdown and autolink punctuation is
      // also turned into entities, for renderers that do apply Markdown.
      .replace(/[&<>"'[\]()*_`|~!#:\\]/g, (char) => `&#${char.charCodeAt(0)};`)
  );
}

function findingTable(items: readonly ClassifiedFinding[], prefix: string): string {
  const rows = items.slice(0, MAX_ROWS).map(({ finding }) => {
    const where = location(finding, prefix);
    const detail = [finding.explanation, finding.remediation ? `Fix: ${finding.remediation}` : undefined]
      .filter((part): part is string => part !== undefined)
      .map(escapeHtml)
      .join('<br>');
    return (
      `<tr><td>${escapeHtml(finding.severity)}</td><td><code>${escapeHtml(where || '—')}</code></td>` +
      `<td>${escapeHtml(finding.message)}${detail ? `<br><sub>${detail}</sub>` : ''}</td></tr>`
    );
  });
  const more = items.length > MAX_ROWS ? `\n\n${items.length - MAX_ROWS} more not shown.` : '';
  return `<table><tr><th>Severity</th><th>Where</th><th>Problem</th></tr>${rows.join('')}</table>${more}`;
}

export function renderSummary(analysis: Analysis): string {
  const c = counts(analysis);
  const out: string[] = [];
  out.push(`## SetupGuard: ${RESULT_TITLE[analysis.result]}`, '');

  if (analysis.mode === 'pull-request') {
    out.push(
      `| New blockers | New warnings | Already on base | Not comparable |`,
      `| ---: | ---: | ---: | ---: |`,
      `| ${c.newErrors} | ${c.newWarnings} | ${c.preexisting} | ${c.unclassified} |`,
      '',
    );
  }

  if (analysis.reasons.length > 0) {
    out.push(`<ul>${analysis.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`, '');
  }
  if (analysis.result === 'incomplete') {
    out.push('**Incomplete is not a pass.** Part of the diagnosis did not happen; the reasons are listed above.', '');
    if (analysis.head?.results.some((result) => result.status === 'inconclusive')) {
      out.push(
        'When a scan limit was reached (common in large repositories), list the directories SetupGuard should skip under `ignore:` in `.setupguard.yml`.',
        '',
      );
    }
  }

  const section = (title: string, items: readonly ClassifiedFinding[]) => {
    if (items.length === 0) return;
    out.push(`### ${title}`, '', findingTable(items, analysis.prefix), '');
  };
  if (analysis.mode === 'full') {
    section('Problems', analysis.findings);
  } else {
    section('Introduced by this pull request', analysis.findings.filter((f) => f.classification === 'new'));
    section('Could not be compared with the base', analysis.findings.filter((f) => f.classification === 'unclassified'));
    section('Already on the base branch', analysis.findings.filter((f) => f.classification === 'preexisting'));
  }

  if (analysis.findings.length === 0 && analysis.result === 'pass') {
    out.push(
      analysis.mode === 'pull-request'
        ? 'No readiness problems introduced by this pull request.'
        : 'No readiness problems found.',
      '',
    );
  }

  const details: string[] = [];
  if (analysis.head) {
    details.push(`Static checks on the ${analysis.mode === 'pull-request' ? 'pull request' : 'checkout'}: ${analysis.head.readiness}, ${analysis.head.summary.conclusive} check(s) reached a conclusion.`);
  }
  if (analysis.comparison) {
    details.push(
      `Base commit <code>${escapeHtml(analysis.comparison.baseRef)}</code> (${analysis.comparison.checkout} checkout): ${analysis.base?.readiness ?? '—'}.`,
      `${analysis.comparison.changedFiles} changed file(s) listed by the GitHub API, ${analysis.comparison.relevantPaths} inside the analysed directory.`,
    );
  }
  if (analysis.apiCalls.length > 0) {
    details.push(`${analysis.apiCalls.length} GitHub API request(s); the job log lists each one.`);
  }
  details.push('Only static checks run in CI: SetupGuard reads files and never executes anything from the repository.');
  out.push(`<sub>${details.join('<br>')}</sub>`, '');
  return out.join('\n');
}
