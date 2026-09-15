import {
  found,
  inconclusive,
  locateJsonKey,
  notApplicable,
  pass,
  type Check,
  type Evidence,
  type FindingInput,
} from '@setupguard/core';

import type { NodeFacts } from '../facts/collect.js';
import { describeGaps, gapsFor, hasGap } from '../facts/gaps.js';
import { binaryFor, type PackageManagerName } from '../facts/package-manager.js';

/**
 * Static consistency of the package-manager contract: is there a lockfile, is
 * there exactly one, and does it match what `package.json#packageManager`
 * declares?
 */
export const packageManagerCheck: Check<NodeFacts> = {
  id: 'node/package-manager',
  title: 'Package manager and lockfile are consistent',
  category: 'dependencies',
  level: 'static',
  safety: 'read-only',
  applies: (facts) => facts.packageJson.kind === 'ok' || hasGap(facts.gaps, 'package.json'),
  run(facts) {
    const gaps = gapsFor(facts.gaps, 'package.json');
    if (gaps.length > 0) {
      return inconclusive(
        `The manifest could not be read, so the package manager contract is unknown — ${describeGaps(gaps)}`,
      );
    }

    const findings: FindingInput[] = [];
    const declared = facts.declaredPackageManager;
    const lockfiles = facts.lockfiles;

    if (lockfiles.length === 0) {
      findings.push({
        code: 'node/lockfile-missing',
        severity: 'warning',
        confidence: 'high',
        message: 'No lockfile found',
        explanation:
          'Without a lockfile every contributor resolves a different dependency tree, so "works on my machine" failures cannot be ruled out and CI is not reproducible.',
        expected: 'one of package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock',
        actual: 'none',
        remediation: 'Run an install with the project package manager and commit the generated lockfile.',
        evidence: [{ file: 'package.json', detail: 'no lockfile alongside the manifest' }],
      });
    }

    // What matters is how many *package managers* are implied, not how many
    // files exist. `package-lock.json` alongside `npm-shrinkwrap.json` is a
    // legal npm layout, and `bun.lockb` alongside `bun.lock` is just the old
    // and new Bun formats. Counting files reported both as a conflict between
    // "different package managers", which was factually wrong.
    const managers = [...new Set(lockfiles.map((lock) => lock.manager))];
    if (managers.length > 1) {
      findings.push({
        code: 'node/multiple-lockfiles',
        severity: 'warning',
        confidence: 'high',
        message: `Lockfiles from ${managers.length} different package managers are present: ${managers.join(', ')}`,
        explanation:
          'A contributor cannot tell which package manager is authoritative, and the lockfiles that are not used drift silently out of date.',
        expected: 'lockfiles from exactly one package manager',
        actual: lockfiles.map((lock) => `${lock.file} (${lock.manager})`).join(', '),
        remediation:
          'Keep the lockfile of the package manager the project actually uses and delete the others.',
        evidence: lockfiles.map((lock) => ({ file: lock.file, detail: `belongs to ${lock.manager}` })),
      });
    }

    // When nothing is declared, a single lockfile is enough to infer the
    // manager: that is the zero-config path the product supports on purpose.
    if (declared) {
      const matching = lockfiles.filter((lock) => lock.manager === declared.name);
      if (lockfiles.length > 0 && matching.length === 0) {
        findings.push({
          code: 'node/package-manager-lockfile-mismatch',
          severity: 'error',
          confidence: 'high',
          message: `package.json declares "${declared.raw}" but no ${declared.name} lockfile exists`,
          explanation:
            'Following the declared package manager ignores the committed lockfile, so the installed dependency tree will not be the one the project was tested with.',
          expected: `a ${declared.name} lockfile`,
          actual: lockfiles.map((lock) => lock.file).join(', '),
          remediation: `Either install with ${declared.name} and commit its lockfile, or change the packageManager field to match the lockfile in the repository.`,
          evidence: [
            manifestEvidence(facts, ['packageManager'], `declares ${declared.raw}`),
            ...lockfiles.map((lock) => ({ file: lock.file, detail: `belongs to ${lock.manager}` })),
          ],
        });
      }
    }

    return findings.length > 0 ? found(findings) : pass();
  },
};

/**
 * Environment-level counterpart: is the package manager the project needs
 * actually installed on this machine?
 *
 * Resolution is a `PATH` lookup, never an execution: running a shim such as
 * `yarn --version` can make Corepack download a toolchain, which is a side
 * effect a read-only diagnosis must not cause.
 */
export const packageManagerAvailableCheck: Check<NodeFacts> = {
  id: 'node/package-manager-available',
  title: 'Required package manager is installed',
  category: 'environment',
  level: 'environment',
  safety: 'read-only',
  applies: (facts) => resolveManager(facts) !== undefined || hasGap(facts.gaps, 'package.json'),
  async run(facts, context) {
    const gaps = gapsFor(facts.gaps, 'package.json');
    if (gaps.length > 0) {
      return inconclusive(
        `The manifest could not be read, so the required package manager is unknown — ${describeGaps(gaps)}`,
      );
    }

    const resolved = resolveManager(facts);
    if (!resolved) return notApplicable('No package manager could be determined');

    const location = await context.environment.which(binaryFor(resolved.name));
    if (location) return pass();

    return found([
      {
        code: 'node/package-manager-unavailable',
        severity: 'error',
        confidence: resolved.confidence,
        message: `${resolved.name} is not installed on this machine`,
        explanation: `The repository ${resolved.reason}, but no "${resolved.name}" executable was found on PATH. Dependencies cannot be installed until it is available.`,
        expected: `${resolved.name} on PATH`,
        actual: 'not found',
        remediation: `Install ${resolved.name}, or enable Corepack with "corepack enable" if the project relies on it.`,
        evidence: [{ file: resolved.evidenceFile, detail: resolved.reason }],
      },
    ]);
  },
};

interface ResolvedManager {
  readonly name: PackageManagerName;
  readonly confidence: 'high' | 'medium';
  readonly reason: string;
  readonly evidenceFile: string;
}

/**
 * Determine which package manager the project needs.
 *
 * An explicit `packageManager` field wins (high confidence); otherwise a single
 * unambiguous lockfile is used (medium confidence). With several lockfiles the
 * project is ambiguous and `node/multiple-lockfiles` already reports it.
 */
function resolveManager(facts: NodeFacts): ResolvedManager | undefined {
  const declared = facts.declaredPackageManager;
  if (declared) {
    return {
      name: declared.name,
      confidence: 'high',
      reason: `declares "packageManager": "${declared.raw}"`,
      evidenceFile: 'package.json',
    };
  }

  const managers = new Set(facts.lockfiles.map((lock) => lock.manager));
  if (managers.size !== 1) return undefined;
  const lockfile = facts.lockfiles[0];
  if (!lockfile) return undefined;

  return {
    name: lockfile.manager,
    confidence: 'medium',
    reason: `commits ${lockfile.file}`,
    evidenceFile: lockfile.file,
  };
}

/** Point at a key inside package.json when the raw text is available. */
export function manifestEvidence(
  facts: NodeFacts,
  path: readonly string[],
  detail: string,
): Evidence {
  const raw = facts.packageJson.kind === 'ok' ? facts.packageJson.raw : undefined;
  const location = raw ? locateJsonKey(raw, path) : undefined;
  return location
    ? { file: 'package.json', line: location.key.line, column: location.key.column, detail }
    : { file: 'package.json', detail };
}
