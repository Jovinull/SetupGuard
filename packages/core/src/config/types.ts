/**
 * Configuration model.
 *
 * `.setupguard.yml` exists for one reason: letting a repository declare a
 * legitimate exception without switching off a whole category from the command
 * line. It is not a policy engine, and everything in here is shaped by that —
 * the surface is deliberately small and every value is data, never behaviour.
 *
 * Nothing in this file mentions Node, npm or any other ecosystem. `checks`,
 * `ignore` and `version` are generic; `env.optional` names environment
 * variables, which the core already models through `EnvironmentProbe`. An
 * ecosystem-specific option would need a different home — see
 * `Notes/15-configuracao.md`.
 */

/** What a `checks.<id>.severity` override can say. */
export type SeverityOverride = 'error' | 'warning' | 'off';

/** Machine-readable identifier for a problem in the configuration file itself. */
export type ConfigDiagnosticCode =
  | 'config/unreadable'
  | 'config/invalid-yaml'
  | 'config/unsupported-syntax'
  | 'config/not-an-object'
  | 'config/version-missing'
  | 'config/version-unsupported'
  | 'config/unknown-key'
  | 'config/wrong-type'
  | 'config/unknown-check'
  | 'config/invalid-severity'
  | 'config/invalid-env-name'
  | 'config/duplicate-entry'
  | 'config/invalid-ignore-pattern'
  | 'config/misnamed-file';

/**
 * A problem with the configuration, kept apart from findings about the project.
 *
 * A broken `.setupguard.yml` says nothing about whether the repository can be
 * cloned and run, so it must never be reported as a project defect.
 */
export interface ConfigDiagnostic {
  readonly code: ConfigDiagnosticCode;
  /** One line, no trailing period. Already sanitised. */
  readonly message: string;
  /** Workspace-relative path of the configuration file. */
  readonly file: string;
  /** 1-based, when the position is known. */
  readonly line?: number;
  readonly column?: number;
  /** Dotted path of the offending field, e.g. `checks.node/scripts.severity`. */
  readonly path?: string;
  readonly remediation?: string;
}

/**
 * Configuration after discovery, parsing, validation and normalisation.
 *
 * Everything downstream — engine, adapters, checks — receives this and only
 * this. No component parses YAML, and no component sees a raw, unvalidated
 * value.
 */
export interface ResolvedConfig {
  /** Workspace-relative path of the file this came from, if any was found. */
  readonly source?: string;
  /**
   * False when the file exists but could not be applied. The run then proceeds
   * with defaults, and readiness becomes `INCOMPLETE`: the diagnosis that was
   * actually configured did not happen.
   */
  readonly valid: boolean;
  /** Severity override per check id. Absent id means "leave the check alone". */
  readonly checks: ReadonlyMap<string, SeverityOverride>;
  /** Variables the project declares optional. Names only — never values. */
  readonly optionalEnvVars: ReadonlySet<string>;
  /** Normalised, workspace-relative glob patterns. */
  readonly ignore: readonly string[];
  readonly diagnostics: readonly ConfigDiagnostic[];
}

/** The configuration a workspace has when it declares none. */
export const DEFAULT_CONFIG: ResolvedConfig = {
  valid: true,
  checks: new Map(),
  optionalEnvVars: new Set(),
  ignore: [],
  diagnostics: [],
};
