import type { EnvironmentProbe } from '../env/environment.js';
import type { WorkspaceFs } from '../fs/workspace-fs.js';
import type { Category, FindingInput, VerificationLevel } from '../model/types.js';

/** Inputs available while an adapter decides whether it applies and gathers facts. */
export interface DiscoveryContext {
  readonly fs: WorkspaceFs;
  readonly environment: EnvironmentProbe;
  /**
   * Aborts when the run is cancelled or the budget expires. Anything that can
   * outlive the call — a socket, a child process, a long walk — must honour it.
   * The read-only checks of v0.1 finish well inside their budget, but the
   * contract exists before the first check that needs it.
   */
  readonly signal: AbortSignal;
}

/** Inputs available to a check while it runs. */
export interface CheckContext extends DiscoveryContext {
  /** Levels the caller authorised for this run. */
  readonly levels: readonly VerificationLevel[];
}

/** What a check returns. */
export type CheckOutput =
  /** The check ran. Zero findings means `pass`. */
  | { readonly kind: 'findings'; readonly findings: readonly FindingInput[] }
  /** The check does not apply to this project (e.g. no `.env.example` anywhere). */
  | { readonly kind: 'not-applicable'; readonly reason: string }
  /** The check ran but could not decide (e.g. an unresolvable `lts/*` alias). */
  | { readonly kind: 'inconclusive'; readonly reason: string };

/** The check ran and found nothing. */
export function pass(): CheckOutput {
  return { kind: 'findings', findings: [] };
}

/** The check ran and produced findings. An empty array is equivalent to {@link pass}. */
export function found(findings: readonly FindingInput[]): CheckOutput {
  return { kind: 'findings', findings };
}

export function notApplicable(reason: string): CheckOutput {
  return { kind: 'not-applicable', reason };
}

export function inconclusive(reason: string): CheckOutput {
  return { kind: 'inconclusive', reason };
}

/**
 * One deterministic verification.
 *
 * `Facts` is the adapter-specific model produced once per run by
 * {@link Adapter.collect}, so checks do not re-read or re-parse the same files.
 */
export interface Check<Facts = unknown> {
  /** Stable, namespaced identifier, e.g. `node/node-version-runtime`. */
  readonly id: string;
  /** Short human title, shown as the row label in the CLI. */
  readonly title: string;
  readonly category: Category;
  readonly level: VerificationLevel;
  /**
   * `read-only` checks may run automatically. `side-effects` checks must be
   * requested explicitly; the engine refuses to run them otherwise.
   */
  readonly safety: 'read-only' | 'side-effects';
  /**
   * Cheap, synchronous applicability test over already-collected facts. Return
   * `false` and the check is reported as `not-applicable` instead of running.
   */
  applies(facts: Facts, context: CheckContext): boolean;
  run(facts: Facts, context: CheckContext): Promise<CheckOutput> | CheckOutput;
}

/**
 * An ecosystem plug-in: it recognises a technology, turns its manifests and
 * conventions into a fact model, and contributes checks over those facts.
 *
 * The core knows nothing about Node, npm or Markdown; all of that lives in
 * adapters. Adding an ecosystem must not require touching the engine.
 */
export interface Adapter<Facts = unknown> {
  /** Stable identifier, also used as the namespace for its check ids. */
  readonly id: string;
  readonly name: string;
  /** Cheap applicability test against the workspace. */
  detect(context: DiscoveryContext): Promise<boolean>;
  /** Build the fact model. Only called when {@link detect} resolved `true`. */
  collect(context: DiscoveryContext): Promise<Facts>;
  readonly checks: readonly Check<Facts>[];
}

/**
 * Erase an adapter's `Facts` type so heterogeneous adapters can live in one
 * list. Type safety is preserved inside each adapter; the engine only ever
 * passes an adapter the facts that same adapter collected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAdapter = Adapter<any>;
