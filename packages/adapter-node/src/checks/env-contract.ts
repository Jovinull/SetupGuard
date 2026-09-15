import {
  found,
  inconclusive,
  notApplicable,
  pass,
  type Check,
  type Evidence,
  type FindingInput,
} from '@setupguard/core';

import type { NodeFacts } from '../facts/collect.js';
import { isAmbientEnvVar } from '../facts/dotenv.js';
import { groupUsagesByName, type EnvUsage } from '../facts/env-usage.js';
import { describeGaps, gapsFor, hasGap } from '../facts/gaps.js';

/**
 * Repository-only half of the configuration contract: does the committed
 * template describe the variables the code actually reads?
 *
 * Everything here is derived from files in the repository, so the result is the
 * same on a workstation and on a CI runner.
 *
 * Only variable *names* are ever handled; values are dropped at parse time, so
 * no finding can leak a secret (`Notes/09-seguranca-e-confiabilidade.md`).
 */
export const envContractCheck: Check<NodeFacts> = {
  id: 'node/env-contract',
  title: 'Environment variables used by the code are documented',
  category: 'configuration',
  level: 'static',
  safety: 'read-only',
  applies: (facts) =>
    facts.envExampleFile !== undefined ||
    facts.envUsages.length > 0 ||
    // A failed template read or a truncated source scan removes the facts this
    // check looks for; without this the gap would be hidden as not-applicable.
    hasGap(facts.gaps, 'env-template', 'source-scan'),
  run(facts) {
    // An incomplete source scan cannot prove that every variable is documented,
    // so it must not be reported as a clean result.
    const gaps = gapsFor(facts.gaps, 'source-scan', 'env-template');
    if (gaps.length > 0) {
      return inconclusive(`Configuration could not be fully inspected — ${describeGaps(gaps)}`);
    }

    const example = facts.envExampleFile;
    const usages = groupUsagesByName(facts.envUsages);
    // A name is only the project's responsibility when no platform provides it.
    // Ambience depends on the access form, so the check asks per usage.
    const usedNames = [...usages.entries()]
      .filter(([name, sites]) => sites.some((site) => !isAmbientEnvVar(name, site.form)))
      .map(([name]) => name);

    if (usedNames.length === 0 && !example) {
      return notApplicable('The project reads no project-specific environment variables');
    }

    const findings: FindingInput[] = [];

    if (!example) {
      findings.push({
        code: 'node/env-example-missing',
        severity: 'warning',
        confidence: 'medium',
        message: `The code reads ${usedNames.length} environment variable(s) but no .env.example is committed`,
        explanation:
          'A contributor has no way to discover which variables must be set, so the project fails at run time with a missing-configuration error.',
        expected: '.env.example listing the required variable names',
        actual: 'not found',
        remediation: 'Commit a .env.example listing the variable names (never real values).',
        evidence: usedNames.slice(0, 5).flatMap((name) => usageEvidence(usages.get(name)?.[0], name)),
      });
      return found(findings);
    }

    for (const name of usedNames) {
      if (example.keys.has(name)) continue;
      findings.push({
        code: 'node/env-var-undocumented',
        severity: 'warning',
        confidence: 'medium',
        message: `${name} is read by the code but not listed in ${example.path}`,
        explanation:
          'A contributor following the template will not set this variable, so the failure only appears at run time. SetupGuard infers this from source code, so the variable may in fact be optional.',
        expected: `${name} listed in ${example.path}`,
        actual: 'not listed',
        remediation: `Add ${name} to ${example.path}, or treat this finding as expected if the variable is genuinely optional.`,
        evidence: usageEvidence(usages.get(name)?.[0], name),
      });
    }

    return findings.length > 0 ? found(findings) : pass();
  },
};

/**
 * Machine-specific half: is the configuration the repository documents actually
 * available on *this* machine?
 *
 * Declared at the `environment` level because the answer legitimately differs
 * between a workstation and a CI runner (`Notes/08-github-action.md`).
 *
 * "Available" means any of three things, and all three must be consulted or the
 * check produces noise:
 *
 * - defined with a value in one of the layered local files (`.env`,
 *   `.env.development`, `.env.local` — all of them, merged);
 * - defined but **empty**, which is an unfilled placeholder, not a value;
 * - already exported in the process environment, which is how many setups
 *   (direnv, a shell profile, a CI secret) actually provide configuration.
 */
export const envLocalFileCheck: Check<NodeFacts> = {
  id: 'node/env-local-file',
  title: 'Local environment provides the documented variables',
  category: 'configuration',
  level: 'environment',
  safety: 'read-only',
  applies: (facts) =>
    facts.envExampleFile !== undefined || hasGap(facts.gaps, 'env-template', 'env-local'),
  run(facts, context) {
    // The gap check comes first on purpose. When `.env.example` is unreadable,
    // `envExampleFile` is undefined, and an early `notApplicable` here would
    // swallow the gap exactly like a facts-only `applies()` would.
    const gaps = gapsFor(facts.gaps, 'env-template', 'env-local');
    if (gaps.length > 0) {
      return inconclusive(
        `The local environment could not be fully inspected — ${describeGaps(gaps)}`,
      );
    }

    const example = facts.envExampleFile;
    if (!example) return notApplicable('No environment template is committed');

    const usages = groupUsagesByName(facts.envUsages);
    const localFiles = facts.envLocalFiles;

    if (localFiles.length === 0) {
      // Configuration exported into the shell is a legitimate setup, so an
      // absent .env is only worth reporting when the process environment does
      // not already provide the documented variables.
      const unprovided = example.entries.filter(
        (entry) => !context.environment.hasEnvVar(entry.key),
      );
      if (unprovided.length === 0) return pass();

      return found([
        {
          code: 'node/env-file-missing',
          severity: 'warning',
          confidence: 'high',
          message: `${example.path} exists but no local environment file was found`,
          explanation:
            'The repository documents configuration that is neither in a local .env file nor exported in the current environment, so the project will start with missing values.',
          expected: 'a local .env file, or the variables exported in the environment',
          actual: `${unprovided.length} of ${example.entries.length} documented variable(s) unavailable`,
          remediation: `Copy ${example.path} to .env and fill in the values. SetupGuard does not create or modify the file for you.`,
          evidence: [{ file: example.path, detail: `declares ${example.keys.size} variable(s)` }],
        },
      ]);
    }

    const findings: FindingInput[] = [];
    const localPaths = localFiles.map((file) => file.path).join(', ');

    for (const entry of example.entries) {
      const state = facts.envLocalKeys.get(entry.key) ?? 'absent';
      if (state === 'set') continue;
      if (context.environment.hasEnvVar(entry.key)) continue;

      const usedInCode = usages.has(entry.key);
      const empty = state === 'empty';

      findings.push({
        code: empty ? 'node/env-var-empty' : 'node/env-var-missing',
        severity: usedInCode ? 'error' : 'warning',
        confidence: usedInCode ? 'high' : 'medium',
        message: empty
          ? `${entry.key} is declared in ${localPaths} but has no value`
          : `${entry.key} is documented in ${example.path} but missing from ${localPaths}`,
        explanation: usedInCode
          ? 'The source code reads this variable, so the project cannot run correctly without a value.'
          : 'The template documents this variable but no value is available locally. It may be optional.',
        expected: `${entry.key} set to a value`,
        actual: empty ? 'declared with an empty value' : 'not defined',
        remediation: empty
          ? `Fill in a value for ${entry.key}.`
          : `Add ${entry.key} to a local environment file, or export it in your shell.`,
        evidence: [
          { file: example.path, line: entry.line, detail: 'documented here' },
          ...usageEvidence(usages.get(entry.key)?.[0], entry.key),
        ],
      });
    }

    return findings.length > 0 ? found(findings) : pass();
  },
};

function usageEvidence(usage: EnvUsage | undefined, name: string): Evidence[] {
  if (!usage) return [];
  return [{ file: usage.file, line: usage.line, detail: `reads ${name}` }];
}
