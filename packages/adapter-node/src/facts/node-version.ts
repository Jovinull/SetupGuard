import semver from 'semver';

/** Where a Node.js version requirement was declared. */
export type NodeVersionSource =
  | 'package.json#engines.node'
  | 'package.json#volta.node'
  | '.nvmrc'
  | '.node-version';

export interface NodeVersionRequirement {
  readonly source: NodeVersionSource;
  /** Workspace-relative file the requirement was read from. */
  readonly file: string;
  /** Exactly what the file said, before normalisation. */
  readonly raw: string;
  /**
   * A semver range equivalent to `raw`, or `undefined` when the declaration
   * cannot be resolved offline (`lts/iron`, `latest`, `system`, ...).
   */
  readonly range?: string;
  /** Set when `range` is undefined, explaining why. */
  readonly unresolvedReason?: string;
}

/**
 * Normalise a version declaration into a semver range.
 *
 * `.nvmrc` and `.node-version` hold a version *specifier*, not a range: `20`
 * means "the 20.x line", which `semver.validRange` already models as
 * `>=20.0.0 <21.0.0-0`.
 */
export function toRange(raw: string): Pick<NodeVersionRequirement, 'range' | 'unresolvedReason'> {
  const value = raw.trim().replace(/^v/i, '');

  if (value === '') return { unresolvedReason: 'declaration is empty' };
  if (/^(lts\/.*|lts|latest|node|stable|system|current)$/i.test(value)) {
    return {
      unresolvedReason: `alias "${raw.trim()}" cannot be resolved without a network lookup`,
    };
  }

  const range = semver.validRange(value);
  if (range === null) return { unresolvedReason: `"${raw.trim()}" is not a valid semver range` };
  return { range };
}

export function buildRequirement(
  source: NodeVersionSource,
  file: string,
  raw: string,
): NodeVersionRequirement {
  return { source, file, raw: raw.trim(), ...toRange(raw) };
}

/** Requirements that could be turned into a comparable range. */
export function resolvedRequirements(
  requirements: readonly NodeVersionRequirement[],
): (NodeVersionRequirement & { range: string })[] {
  return requirements.filter(
    (requirement): requirement is NodeVersionRequirement & { range: string } =>
      requirement.range !== undefined,
  );
}

export interface RequirementConflict {
  readonly a: NodeVersionRequirement & { range: string };
  readonly b: NodeVersionRequirement & { range: string };
}

/**
 * Pairs of declarations that no single Node.js version can satisfy at once.
 *
 * v0.1 deliberately has no precedence rule between `engines.node`, `.nvmrc`,
 * Volta and `.node-version`: every declaration is part of the repository's
 * contract, so a contradiction is reported instead of silently resolved
 * (`Notes/10-adapters-e-configuracao.md`).
 */
export function findConflicts(
  requirements: readonly NodeVersionRequirement[],
): RequirementConflict[] {
  const resolved = resolvedRequirements(requirements);
  const conflicts: RequirementConflict[] = [];

  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const a = resolved[i];
      const b = resolved[j];
      if (!a || !b) continue;
      if (!semver.intersects(a.range, b.range, { loose: true })) {
        conflicts.push({ a, b });
      }
    }
  }

  return conflicts;
}

/** Requirements the given version fails to satisfy. */
export function unsatisfied(
  version: string,
  requirements: readonly NodeVersionRequirement[],
): (NodeVersionRequirement & { range: string })[] {
  const coerced = semver.valid(version) ?? semver.coerce(version)?.version;
  if (!coerced) return [];
  return resolvedRequirements(requirements).filter(
    // `includePrerelease` so that running Node 25.0.0-rc.1 is not reported as
    // failing `>=20`. semver excludes prereleases by default, which is right
    // for dependency resolution and wrong for "is this runtime acceptable".
    (requirement) =>
      !semver.satisfies(coerced, requirement.range, { loose: true, includePrerelease: true }),
  );
}
