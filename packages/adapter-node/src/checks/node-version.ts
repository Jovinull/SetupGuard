import {
  found,
  inconclusive,
  notApplicable,
  pass,
  type Check,
  type FindingInput,
} from '@setupguard/core';

import type { NodeFacts } from '../facts/collect.js';
import { describeGaps, gapsFor, hasGap } from '../facts/gaps.js';
import { findConflicts, resolvedRequirements, unsatisfied } from '../facts/node-version.js';

/**
 * Static half of the runtime contract: does the repository declare which
 * Node.js version it needs, and do its declarations agree with each other?
 */
export const nodeVersionDeclarationCheck: Check<NodeFacts> = {
  id: 'node/node-version-declaration',
  title: 'Required Node.js version is declared consistently',
  category: 'project',
  level: 'static',
  safety: 'read-only',
  applies: (facts) =>
    facts.packageJson.kind === 'ok' || hasGap(facts.gaps, 'package.json', 'node-version'),
  run(facts) {
    const requirements = facts.nodeVersionRequirements;
    const findings: FindingInput[] = [];
    const gaps = gapsFor(facts.gaps, 'node-version', 'package.json');

    // An unreadable .nvmrc must not be reported as "no version declared":
    // that turns a read failure into a clean-looking warning about the project.
    if (gaps.length > 0 && requirements.length === 0) {
      return inconclusive(
        `The declared Node.js version could not be read — ${describeGaps(gaps)}`,
      );
    }

    if (requirements.length === 0) {
      return found([
        {
          code: 'node/node-version-undeclared',
          severity: 'warning',
          confidence: 'medium',
          message: 'The repository does not declare a required Node.js version',
          explanation:
            'Nothing tells a contributor which runtime to use, so an incompatible Node.js version fails at install or at run time with an unrelated-looking error.',
          expected: 'engines.node in package.json, or a .nvmrc / .node-version file',
          actual: 'no declaration found',
          remediation: 'Add "engines": { "node": ">=X" } to package.json, or commit a .nvmrc file.',
          evidence: [{ file: 'package.json', detail: 'no engines.node field' }],
        },
      ]);
    }

    for (const requirement of requirements) {
      if (requirement.range !== undefined) continue;
      findings.push({
        code: 'node/node-version-unresolvable',
        severity: 'warning',
        confidence: 'high',
        message: `Node.js version declared in ${requirement.file} cannot be resolved offline`,
        explanation: `SetupGuard cannot compare "${requirement.raw}" against the running runtime: ${requirement.unresolvedReason ?? 'unsupported declaration'}. The declaration is reported but not verified.`,
        expected: 'an explicit version or semver range',
        actual: requirement.raw,
        remediation: 'Prefer an explicit version (for example "20.11.0") over a moving alias.',
        evidence: [{ file: requirement.file, excerpt: requirement.raw }],
      });
    }

    for (const conflict of findConflicts(requirements)) {
      findings.push({
        code: 'node/node-version-declaration-conflict',
        severity: 'error',
        confidence: 'high',
        message: `Conflicting Node.js requirements: ${conflict.a.source} says "${conflict.a.raw}", ${conflict.b.source} says "${conflict.b.raw}"`,
        explanation:
          'No single Node.js version satisfies both declarations, so whichever one a contributor follows, the other is violated.',
        expected: 'declarations that can be satisfied at the same time',
        actual: `${conflict.a.raw} vs ${conflict.b.raw}`,
        remediation: 'Align the declarations on one supported version range.',
        evidence: [
          { file: conflict.a.file, excerpt: conflict.a.raw, detail: conflict.a.source },
          { file: conflict.b.file, excerpt: conflict.b.raw, detail: conflict.b.source },
        ],
      });
    }

    if (findings.length > 0) return found(findings);
    // Everything readable agreed, but something was unreadable: do not claim a
    // clean pass over a partial view.
    if (gaps.length > 0) {
      return inconclusive(
        `Some Node.js version declarations could not be read — ${describeGaps(gaps)}`,
      );
    }
    return pass();
  },
};

/**
 * Environment half: does the Node.js runtime actually executing SetupGuard
 * satisfy every declared requirement?
 *
 * The running runtime is read from the process itself, so this check spawns
 * nothing.
 */
export const nodeVersionRuntimeCheck: Check<NodeFacts> = {
  id: 'node/node-version-runtime',
  title: 'Local Node.js version satisfies the declared requirement',
  category: 'environment',
  level: 'environment',
  safety: 'read-only',
  applies: (facts) =>
    resolvedRequirements(facts.nodeVersionRequirements).length > 0 ||
    hasGap(facts.gaps, 'node-version', 'package.json'),
  run(facts, context) {
    const gaps = gapsFor(facts.gaps, 'node-version', 'package.json');
    if (gaps.length > 0) {
      return inconclusive(
        `The declared Node.js version could not be read in full — ${describeGaps(gaps)}`,
      );
    }

    const requirements = resolvedRequirements(facts.nodeVersionRequirements);
    if (requirements.length === 0) {
      return notApplicable('No comparable Node.js requirement is declared');
    }

    // Contradictory declarations have no single expectation to test against;
    // node/node-version-declaration already reports the contradiction.
    if (findConflicts(requirements).length > 0) {
      return inconclusive(
        'The repository declares conflicting Node.js requirements, so there is no single expectation to verify',
      );
    }

    const current = context.environment.nodeVersion();
    const failures = unsatisfied(current, requirements);
    if (failures.length === 0) return pass();

    return found(
      failures.map((requirement) => ({
        code: 'node/node-version-mismatch',
        severity: 'error' as const,
        confidence: 'high' as const,
        message: `Node.js ${current} does not satisfy "${requirement.raw}" from ${requirement.source}`,
        explanation:
          'Installing or running the project with an unsupported runtime typically fails with a syntax or native-module error that does not name the real cause.',
        expected: requirement.raw,
        actual: current,
        remediation: `Switch to a Node.js version matching "${requirement.raw}" (for example with nvm, fnm, Volta or mise) before installing dependencies.`,
        evidence: [{ file: requirement.file, excerpt: requirement.raw, detail: requirement.source }],
      })),
    );
  },
};
