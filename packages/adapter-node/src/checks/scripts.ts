import {
  closestMatch,
  found,
  inconclusive,
  pass,
  type Check,
  type FindingInput,
} from '@setupguard/core';

import type { NodeFacts } from '../facts/collect.js';
import { describeGaps, gapsFor, hasGap } from '../facts/gaps.js';
import { parseScriptReferences } from '../facts/script-references.js';
import { manifestEvidence } from './package-manager.js';

/**
 * Scripts are the executable part of the repository contract. This check
 * verifies the manifest is self-consistent: every script another script calls
 * has to exist.
 */
export const scriptsCheck: Check<NodeFacts> = {
  id: 'node/scripts',
  title: 'Declared scripts are usable and self-consistent',
  category: 'project',
  level: 'static',
  safety: 'read-only',
  applies: (facts) => facts.packageJson.kind === 'ok' || hasGap(facts.gaps, 'package.json'),
  run(facts) {
    const gaps = gapsFor(facts.gaps, 'package.json');
    if (gaps.length > 0) {
      return inconclusive(`The manifest could not be read — ${describeGaps(gaps)}`);
    }

    const scripts = facts.scripts;
    const names = Object.keys(scripts);

    if (names.length === 0) {
      return found([
        {
          code: 'node/scripts-absent',
          severity: 'warning',
          confidence: 'medium',
          message: 'package.json declares no scripts',
          explanation:
            'There is no documented way to install, build, test or start the project. A contributor has to guess the commands from the source tree.',
          expected: 'a scripts section in package.json',
          actual: 'none',
          remediation: 'Add the commands the project actually uses, at minimum a way to run it.',
          evidence: [manifestEvidence(facts, ['scripts'], 'no scripts declared')],
        },
      ]);
    }

    const findings: FindingInput[] = [];

    for (const [name, body] of Object.entries(scripts)) {
      if (body.trim() === '') {
        findings.push({
          code: 'node/script-empty',
          severity: 'warning',
          confidence: 'high',
          message: `Script "${name}" is empty`,
          explanation:
            'An empty script succeeds without doing anything, which hides a broken step from both contributors and CI.',
          expected: 'a command to run',
          actual: 'empty string',
          evidence: [manifestEvidence(facts, ['scripts', name], 'declared with an empty body')],
        });
        continue;
      }

      for (const reference of parseScriptReferences(body)) {
        if (reference.script === name) continue; // Self-recursion is a different problem.
        if (scripts[reference.script] !== undefined) continue;

        const suggestion = closestMatch(reference.script, names);
        findings.push({
          code: 'node/script-reference-missing',
          severity: reference.confidence === 'high' ? 'error' : 'warning',
          confidence: reference.confidence,
          message: `Script "${name}" calls "${reference.manager} run ${reference.script}", which is not declared`,
          explanation:
            'Running the outer script fails as soon as it reaches the missing one, so any workflow that depends on it is broken.',
          expected: suggestion
            ? `an existing script, for example "${suggestion}"`
            : `a script named "${reference.script}"`,
          actual: `scripts: ${names.join(', ')}`,
          remediation: suggestion
            ? `Declare "${reference.script}", or change the call to "${suggestion}".`
            : `Declare "${reference.script}", or remove the call.`,
          evidence: [
            manifestEvidence(facts, ['scripts', name], `calls "${reference.raw}"`),
          ],
        });
      }
    }

    return findings.length > 0 ? found(findings) : pass();
  },
};
