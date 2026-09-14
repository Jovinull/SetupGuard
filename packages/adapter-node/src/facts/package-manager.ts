/** Package managers SetupGuard recognises in v0.1. */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

export interface LockfileDefinition {
  readonly file: string;
  readonly manager: PackageManagerName;
}

/** Lockfile name -> owning package manager. */
export const LOCKFILES: readonly LockfileDefinition[] = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
];

export function isPackageManagerName(value: string): value is PackageManagerName {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * Sub-commands that belong to the package manager itself rather than to a
 * project script. Used so `pnpm install` in a README is never mistaken for a
 * missing script named `install`.
 */
export const PACKAGE_MANAGER_BUILTINS: ReadonlySet<string> = new Set([
  'access',
  'add',
  'audit',
  'bin',
  'cache',
  'ci',
  'config',
  'create',
  'dedupe',
  'deploy',
  'dlx',
  'doctor',
  'exec',
  'explain',
  'fetch',
  'get',
  'help',
  'i',
  'import',
  'info',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'login',
  'logout',
  'ls',
  'outdated',
  'owner',
  'pack',
  'patch',
  'ping',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'run',
  'search',
  'set',
  'setup',
  'store',
  'unlink',
  'uninstall',
  'unplug',
  'up',
  'update',
  'upgrade',
  'version',
  'view',
  'why',
  'whoami',
  'workspace',
  'workspaces',
  'x',
]);

/**
 * npm lifecycle shortcuts: `npm test` runs the `test` *script*, so these do map
 * to script names even without `run`.
 */
export const LIFECYCLE_SHORTCUTS: ReadonlySet<string> = new Set([
  'test',
  'start',
  'stop',
  'restart',
]);

/** Executable name to look for on `PATH` for a given package manager. */
export function binaryFor(manager: PackageManagerName): string {
  return manager;
}
