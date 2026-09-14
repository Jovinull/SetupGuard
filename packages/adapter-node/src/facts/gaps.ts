/**
 * Things SetupGuard could not read or could not read fully.
 *
 * Collecting these is not enough — an earlier revision stored them and no check
 * ever looked, so an unreadable `.nvmrc` silently became "no Node version
 * declared" and a truncated source walk silently became "all variables are
 * documented". Both are false `READY`s.
 *
 * A gap therefore has a **scope**, and every check that depends on that scope
 * reports `inconclusive` instead of a clean result.
 */
export const FACT_SCOPES = [
  'package.json',
  'node-version',
  'env-template',
  'env-local',
  'source-scan',
  'documents',
] as const;

export type FactScope = (typeof FACT_SCOPES)[number];

export interface FactGap {
  readonly scope: FactScope;
  /** Workspace-relative file, when the gap is about one specific file. */
  readonly file?: string;
  readonly reason: string;
}

/** Gaps affecting any of the given scopes. */
export function gapsFor(
  gaps: readonly FactGap[],
  ...scopes: readonly FactScope[]
): readonly FactGap[] {
  return gaps.filter((gap) => scopes.includes(gap.scope));
}

/**
 * True when any of the given scopes has a gap.
 *
 * Every check that consults gaps in `run()` must also call this from
 * `applies()`. A gap often *removes* the very fact the check tests for — an
 * unreadable README leaves `documents` empty — so an `applies()` that looks
 * only at the facts returns `false`, the check is recorded as `not-applicable`,
 * `run()` never executes, and the gap is never reported. The result is a
 * `READY` built on a file that was never read.
 */
export function hasGap(gaps: readonly FactGap[], ...scopes: readonly FactScope[]): boolean {
  return gaps.some((gap) => scopes.includes(gap.scope));
}

/** One sentence naming every gap, for a check's `inconclusive` reason. */
export function describeGaps(gaps: readonly FactGap[]): string {
  return gaps
    .map((gap) => (gap.file === undefined ? gap.reason : `${gap.file}: ${gap.reason}`))
    .join('; ');
}
