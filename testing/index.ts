import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DiscoveryContext, EnvironmentProbe, WorkspaceFs } from '@setupguard/core';

/**
 * Shared test support.
 *
 * Lives outside `packages/` so it is never built, published or imported by
 * production code; `vitest.config.ts` and `tsconfig.check.json` expose it as
 * `@setupguard/testing`.
 */

const FIXTURES_ROOT = path.resolve(fileURLToPath(new URL('../fixtures', import.meta.url)));

/** Absolute path of a fixture project directory. */
export function fixture(name: string): string {
  return path.join(FIXTURES_ROOT, name);
}

export interface StubEnvironmentOptions {
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  /** Binaries considered installed, mapped to the path `which` should return. */
  readonly binaries?: Readonly<Record<string, string>>;
  readonly envVars?: readonly string[];
}

/**
 * Deterministic {@link EnvironmentProbe}.
 *
 * Environment-level checks describe the machine they run on, so asserting on
 * them requires pinning the machine. This is the seam the core defines for
 * exactly that purpose; static-level assertions use the real probe instead.
 */
export function stubEnvironment(options: StubEnvironmentOptions = {}): EnvironmentProbe {
  const binaries = options.binaries ?? { npm: '/usr/bin/npm', pnpm: '/usr/bin/pnpm' };
  const envVars = new Set(options.envVars ?? []);

  return {
    nodeVersion: () => options.nodeVersion ?? '20.11.0',
    platform: () => options.platform ?? 'linux',
    hasEnvVar: (name) => envVars.has(name),
    envVarNames: () => [...envVars],
    which: (binary) => Promise.resolve(binaries[binary] ?? null),
  };
}

/**
 * A {@link DiscoveryContext} for testing an adapter's `collect` in isolation.
 * The signal never aborts unless the caller supplies one.
 */
export function discoveryContext(
  fs: WorkspaceFs,
  options: { environment?: EnvironmentProbe; signal?: AbortSignal } = {},
): DiscoveryContext {
  return {
    fs,
    environment: options.environment ?? stubEnvironment(),
    signal: options.signal ?? new AbortController().signal,
  };
}
