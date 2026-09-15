import type { ConfigDiagnostic } from '../config/types.js';

/**
 * Shared result model for SetupGuard.
 *
 * Every interface (CLI, VS Code, CI) consumes exactly these types, so the
 * vocabulary defined here is the product contract. See
 * `Notes/04-funcionamento-e-checks.md`.
 */

/** Schema version of {@link Report}. Bumped on breaking serialization changes. */
export const REPORT_SCHEMA_VERSION = 1 as const;

/**
 * How deep a check is allowed to look. Higher levels cost more and may touch
 * the network or mutate state, so they are opt-in.
 */
export const VERIFICATION_LEVELS = [
  /** Reads repository files only. No process execution, no network. */
  'static',
  /** Inspects the local machine (runtime version, PATH, env var names). Read-only. */
  'environment',
  /** Talks to local/remote services (databases, HTTP, Docker daemon). Not implemented in v0.1. */
  'connectivity',
  /** Runs project commands (build, test, lint). Never automatic. Not implemented in v0.1. */
  'verification',
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Levels that run by default: both are read-only and free of side effects. */
export const DEFAULT_LEVELS: readonly VerificationLevel[] = ['static', 'environment'];

/** Problem domains, used to group findings in every interface. */
export const CATEGORIES = [
  'environment',
  'dependencies',
  'configuration',
  'services',
  'project',
  'documentation',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Impact of a single finding.
 *
 * - `error`: a contributor following the repository's own instructions is blocked.
 * - `warning`: the contract is degraded or ambiguous, but the project can still run.
 * - `info`: contextual note; never affects aggregated readiness.
 */
export type Severity = 'error' | 'warning' | 'info';

/**
 * How sure SetupGuard is that the finding is real, per
 * `Notes/09-seguranca-e-confiabilidade.md`.
 *
 * - `high`: derived from an explicit declaration in the repository.
 * - `medium`: derived from a strong convention or an inference over source code.
 * - `low`: heuristic; likely to need suppression in some repositories.
 */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Outcome of one check.
 *
 * `pass` / `warning` / `error` describe the project. The remaining states
 * describe SetupGuard itself and must never be presented as proof that the
 * project is broken.
 */
export type CheckStatus =
  | 'pass'
  | 'warning'
  | 'error'
  | 'skipped'
  | 'not-applicable'
  | 'inconclusive'
  | 'internal-error';

/**
 * Aggregated project state.
 *
 * `INCOMPLETE` is not a verdict about the repository: it means the diagnosis
 * did not actually happen (no supported project, no check applicable to the
 * requested levels, or a SetupGuard failure). It exists so "nothing was
 * checked" can never be mistaken for "everything is fine".
 */
export type Readiness = 'READY' | 'WARNINGS' | 'BLOCKED' | 'INCOMPLETE';

/**
 * Where a finding came from. Positions are 1-based so they can be rendered
 * directly in a terminal and converted to VS Code's 0-based ranges.
 */
export interface Evidence {
  /** Workspace-relative POSIX path, e.g. `README.md`. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  /**
   * Short quoted fragment of the source. Must never contain a secret value —
   * see {@link Finding}.
   */
  readonly excerpt?: string;
  /** Free-form note explaining what this piece of evidence proves. */
  readonly detail?: string;
}

/**
 * A single actionable problem.
 *
 * Invariant: no field may ever contain the *value* of an environment variable
 * or any other credential. Names are allowed, values are not.
 */
export interface Finding {
  /** Check that produced this finding. */
  readonly checkId: string;
  /** Stable machine-readable identifier, e.g. `node/lockfile-missing`. */
  readonly code: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** One line, imperative or declarative, no trailing period. */
  readonly message: string;
  /** Why this is a problem for someone cloning the repository. */
  readonly explanation?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly evidence: readonly Evidence[];
  /**
   * Human instruction for a safe fix. SetupGuard never performs it
   * automatically in v0.1.
   */
  readonly remediation?: string;
}

/** A finding as produced by a check, before the engine stamps `checkId`. */
export type FindingInput = Omit<Finding, 'checkId' | 'evidence'> & {
  readonly evidence?: readonly Evidence[];
};

/** Result of running (or not running) one check. */
export interface CheckResult {
  readonly checkId: string;
  readonly title: string;
  readonly category: Category;
  readonly level: VerificationLevel;
  readonly status: CheckStatus;
  readonly findings: readonly Finding[];
  readonly durationMs: number;
  /** Present for `skipped`, `not-applicable`, `inconclusive` and `internal-error`. */
  readonly reason?: string;
}

export interface ReportSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly passed: number;
  readonly skipped: number;
  readonly notApplicable: number;
  readonly inconclusive: number;
  readonly internalErrors: number;
  /**
   * Checks that reached a conclusion about the project (`pass`, `warning` or
   * `error`). `READY` requires this to be greater than zero.
   */
  readonly conclusive: number;
}

export interface AdapterReport {
  readonly id: string;
  readonly name: string;
  readonly detected: boolean;
  /** Set when detection or fact collection threw. */
  readonly error?: string;
}

/** How the run was configured, and anything wrong with that configuration. */
export interface ConfigReport {
  /** Workspace-relative path of the configuration file, when one was found. */
  readonly source?: string;
  /** False when a configuration file exists but could not be applied. */
  readonly valid: boolean;
  readonly diagnostics: readonly ConfigDiagnostic[];
}

/** Full diagnosis of one workspace. This is the serialized public contract. */
export interface Report {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  /** Absolute path of the analysed workspace. */
  readonly root: string;
  readonly readiness: Readiness;
  readonly levelsRequested: readonly VerificationLevel[];
  readonly adapters: readonly AdapterReport[];
  readonly results: readonly CheckResult[];
  readonly summary: ReportSummary;
  /**
   * Configuration state. A broken `.setupguard.yml` is never a project finding:
   * it says the diagnosis that was configured did not run, which makes
   * readiness `INCOMPLETE`.
   */
  readonly config: ConfigReport;
  /**
   * True when at least one check failed because of a SetupGuard bug. Readiness
   * is then `INCOMPLETE` and interfaces must say so.
   */
  readonly hasInternalErrors: boolean;
  /**
   * Set when `readiness` is `INCOMPLETE`: a short explanation of what was not
   * verified. Interfaces must show it instead of implying success.
   */
  readonly incompleteReason?: string;
  readonly durationMs: number;
}

/** All findings of a report, flattened in result order. */
export function allFindings(report: Report): Finding[] {
  return report.results.flatMap((result) => [...result.findings]);
}
