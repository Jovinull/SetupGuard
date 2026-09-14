/**
 * Read-only view of the local machine.
 *
 * Deliberately narrow. Two rules shape this interface:
 *
 * 1. **No process execution.** Levels `static` and `environment` must have no
 *    side effects, and spawning a package-manager shim can trigger a download
 *    (Corepack) or run repository-controlled code. Tool availability is
 *    therefore answered by looking at `PATH`, not by executing anything.
 * 2. **No secret values.** Checks can ask *whether* a variable is defined and
 *    enumerate names, but there is no API to read a value, so a value cannot
 *    leak into a finding.
 */
export interface EnvironmentProbe {
  /** Version of the Node.js runtime executing SetupGuard, e.g. `24.16.0`. */
  nodeVersion(): string;

  platform(): NodeJS.Platform;

  /** True when the variable is set in the current process environment. */
  hasEnvVar(name: string): boolean;

  /** Names of all variables in the current process environment. Never values. */
  envVarNames(): string[];

  /**
   * Absolute path of an executable found on `PATH`, or `null`.
   * Resolution only — the executable is never run.
   */
  which(binary: string): Promise<string | null>;
}
