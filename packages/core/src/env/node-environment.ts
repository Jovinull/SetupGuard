import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { EnvironmentProbe } from './environment.js';

export interface NodeEnvironmentProbeOptions {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `process.versions.node`. */
  readonly nodeVersion?: string;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** {@link EnvironmentProbe} backed by the current Node.js process. */
export class NodeEnvironmentProbe implements EnvironmentProbe {
  readonly #env: NodeJS.ProcessEnv;
  readonly #nodeVersion: string;
  readonly #platform: NodeJS.Platform;
  readonly #whichCache = new Map<string, Promise<string | null>>();

  constructor(options: NodeEnvironmentProbeOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#nodeVersion = options.nodeVersion ?? process.versions.node;
    this.#platform = options.platform ?? process.platform;
  }

  nodeVersion(): string {
    return this.#nodeVersion;
  }

  platform(): NodeJS.Platform {
    return this.#platform;
  }

  hasEnvVar(name: string): boolean {
    return this.#env[name] !== undefined;
  }

  envVarNames(): string[] {
    return Object.keys(this.#env);
  }

  which(binary: string): Promise<string | null> {
    const cached = this.#whichCache.get(binary);
    if (cached) return cached;
    const lookup = this.#lookup(binary);
    this.#whichCache.set(binary, lookup);
    return lookup;
  }

  async #lookup(binary: string): Promise<string | null> {
    // A path separator means the caller already knows where the binary is;
    // resolving it against PATH would be wrong.
    if (binary.includes('/') || binary.includes('\\')) return null;

    const pathValue = this.#env['PATH'] ?? this.#env['Path'] ?? '';
    if (pathValue === '') return null;

    const isWindows = this.#platform === 'win32';
    const dirs = pathValue.split(isWindows ? ';' : ':').filter((dir) => dir !== '');
    const candidates = isWindows
      ? (this.#env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((ext) => ext !== '')
          .map((ext) => binary + ext.toLowerCase())
      : [binary];

    for (const dir of dirs) {
      for (const candidate of candidates) {
        const full = path.join(dir, candidate);
        try {
          await fs.access(full, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
          return full;
        } catch {
          // Not here; keep looking.
        }
      }
    }
    return null;
  }
}
