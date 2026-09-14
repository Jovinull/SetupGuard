import type { CheckResult, Evidence, Finding } from '../model/types.js';
import { redact, redactOptional, redactPathOptional } from '../util/redact.js';

/**
 * Sanitise every free-text field that a check can populate.
 *
 * Applied by the engine to every finding and every result of every check, so
 * redaction is a property of the pipeline rather than a habit each check has to
 * remember. See `packages/core/src/util/redact.ts` for the channels this closes.
 *
 * What is **not** sanitised, and why:
 *
 * - `checkId`, `code`, `title`, `category`, `level`, `status`: structural
 *   identifiers chosen by SetupGuard's own code, never derived from the
 *   repository. This holds only while every adapter is first-party; it must be
 *   revisited before third-party adapters can be loaded.
 * - `Report.root`: the directory the user pointed the tool at. It comes from
 *   the command line, not from repository content, and mangling it would hide
 *   *what was analysed* — which the reader needs in order to trust the report.
 */
export function sanitizeFinding(finding: Finding): Finding {
  return {
    ...finding,
    message: redact(finding.message),
    ...definedOnly({
      explanation: redactOptional(finding.explanation),
      expected: redactOptional(finding.expected),
      actual: redactOptional(finding.actual),
      remediation: redactOptional(finding.remediation),
    }),
    evidence: finding.evidence.map(sanitizeEvidence),
  };
}

export function sanitizeEvidence(evidence: Evidence): Evidence {
  return {
    ...evidence,
    ...definedOnly({
      // A filename is repository content: `TOKEN=value.js` would otherwise put
      // its own name into the JSON, the terminal and the Problems panel.
      file: redactPathOptional(evidence.file),
      excerpt: redactOptional(evidence.excerpt),
      detail: redactOptional(evidence.detail),
    }),
  };
}

/**
 * Sanitise a whole result, including the `reason` attached to `skipped`,
 * `not-applicable`, `inconclusive` and `internal-error` — those carry file
 * names and error messages too.
 */
export function sanitizeResult(result: CheckResult): CheckResult {
  const reason = redactOptional(result.reason);
  return {
    ...result,
    findings: result.findings.map(sanitizeFinding),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Drop keys whose value is `undefined` so spreading never turns an absent
 * optional field into a present-but-undefined one.
 */
function definedOnly<T extends Record<string, string | undefined>>(
  value: T,
): Partial<Record<keyof T, string>> {
  const result: Partial<Record<keyof T, string>> = {};
  for (const [key, entry] of Object.entries(value) as [keyof T, string | undefined][]) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
