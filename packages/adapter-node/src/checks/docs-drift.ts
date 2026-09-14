import {
  closestMatch,
  excerpt,
  found,
  inconclusive,
  notApplicable,
  pass,
  type Check,
  type FindingInput,
} from '@setupguard/core';

import type { NodeFacts } from '../facts/collect.js';
import { describeGaps, gapsFor, hasGap } from '../facts/gaps.js';
import { parseScriptReferences } from '../facts/script-references.js';

/**
 * Documentation drift, narrowed to the one case that can be decided with high
 * precision in v0.1: the documentation tells a contributor to run a package
 * script that `package.json` does not declare.
 *
 * Precision guards:
 *
 * - only shell-like fenced blocks and inline code are read as instructions;
 * - package-manager sub-commands (`pnpm install`) are never mistaken for scripts;
 * - `npm <word>` without `run` is ignored, because npm has no implicit form;
 * - the check does not run at all when the manifest declares no scripts, since
 *   then every documented command would be reported at once.
 */
export const docsScriptDriftCheck: Check<NodeFacts> = {
  id: 'node/docs-script-drift',
  title: 'Documented commands match the declared scripts',
  category: 'documentation',
  level: 'static',
  safety: 'read-only',
  // An unreadable README leaves `documents` empty, which would make a
  // facts-only `applies()` return false and hide the gap behind
  // `not-applicable`. The gap has to be part of the applicability question.
  applies: (facts) =>
    (facts.documents.length > 0 || hasGap(facts.gaps, 'documents')) &&
    (Object.keys(facts.scripts).length > 0 || hasGap(facts.gaps, 'package.json')),
  run(facts) {
    const gaps = gapsFor(facts.gaps, 'documents', 'package.json');
    if (gaps.length > 0) {
      return inconclusive(`Documentation could not be fully read — ${describeGaps(gaps)}`);
    }

    if (facts.documents.length === 0) return notApplicable('No documentation files were found');

    const names = Object.keys(facts.scripts);
    if (names.length === 0) {
      return notApplicable('package.json declares no scripts to compare documentation against');
    }

    const findings: FindingInput[] = [];
    const seen = new Set<string>();

    for (const document of facts.documents) {
      for (const command of document.commands) {
        for (const reference of parseScriptReferences(command.command)) {
          if (facts.scripts[reference.script] !== undefined) continue;

          // One finding per (file, line, script): a command repeated in the
          // same line should not produce duplicates.
          const key = `${document.file}:${command.line}:${reference.script}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const suggestion = closestMatch(reference.script, names);
          findings.push({
            code: 'node/docs-script-not-found',
            severity: reference.confidence === 'high' ? 'error' : 'warning',
            confidence: reference.confidence,
            // The message names the script, never the raw command line: a
            // documented command such as `TOKEN=abc npm run deploy` would carry
            // a credential into every rendering of this finding. The command
            // itself belongs in the evidence excerpt, which is redacted.
            message: `${document.file} tells the reader to run "${reference.manager} ${reference.script}", which is not a declared script`,
            explanation:
              'Someone following the documentation runs a command that fails immediately. This is the drift SetupGuard exists to catch: the repository changed and the instructions did not.',
            expected: suggestion
              ? `an existing script, for example "${reference.manager} run ${suggestion}"`
              : `a script named "${reference.script}" in package.json`,
            actual: `package.json scripts: ${names.join(', ')}`,
            remediation: suggestion
              ? `Update ${document.file} to use "${suggestion}", or declare "${reference.script}" in package.json.`
              : `Update ${document.file}, or declare "${reference.script}" in package.json.`,
            evidence: [
              {
                file: document.file,
                line: command.line,
                excerpt: excerpt(command.command),
                detail: command.source === 'code-block' ? 'in a shell code block' : 'in inline code',
              },
            ],
          });
        }
      }
    }

    return findings.length > 0 ? found(findings) : pass();
  },
};
