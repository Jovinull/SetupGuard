/**
 * Read-only view of the analysed workspace.
 *
 * Checks never touch `node:fs` directly: they go through this interface so the
 * engine can enforce the workspace boundary, and so tests can run against an
 * in-memory workspace.
 */

export interface WalkOptions {
  /** Directory to start from, workspace-relative. Defaults to the root. */
  readonly dir?: string;
  /** Only return files whose name ends with one of these (e.g. `['.ts']`). */
  readonly extensions?: readonly string[];
  /** Only return files whose basename is exactly one of these (e.g. `['package.json']`). */
  readonly names?: readonly string[];
  /** Maximum directory depth below `dir`. Default 8. */
  readonly maxDepth?: number;
  /** Hard cap on returned files, to keep the static level bounded. Default 5000. */
  readonly maxFiles?: number;
  /** Directory names to skip, in addition to the built-in defaults. */
  readonly ignoreDirs?: readonly string[];
}

/** Directory names never traversed: they hold generated or vendored content. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'vendor',
  '__pycache__',
];

/** Outcome of a {@link WorkspaceFs.walk}. */
export interface WalkResult {
  /** Workspace-relative, POSIX-separated file paths. */
  readonly files: readonly string[];
  /**
   * True when the `maxFiles` cap was reached, so the list is a prefix of what
   * is really there. Any inference drawn from it is incomplete and must be
   * reported as such rather than presented as a clean result.
   */
  readonly truncated: boolean;
  /** True when at least one subtree was cut off by `maxDepth`. */
  readonly depthLimited: boolean;
}

export interface WorkspaceFs {
  /** Absolute path of the workspace root. */
  readonly root: string;

  /**
   * True when a file or directory exists at the workspace-relative path *and*
   * resolves, through any symlinks, to a location still inside the workspace.
   */
  exists(relativePath: string): Promise<boolean>;

  /** True when the path exists, is inside the workspace, and is a regular file. */
  isFile(relativePath: string): Promise<boolean>;

  /**
   * Read a UTF-8 text file. Rejects when the file is missing, resolves outside
   * the workspace, is not a regular file, or exceeds the reader's size limit.
   */
  readText(relativePath: string): Promise<string>;

  /** Names of the direct children of a directory. Returns `[]` when missing. */
  listDir(relativePath: string): Promise<string[]>;

  /** Recursively collect file paths, reporting whether the walk was complete. */
  walk(options?: WalkOptions): Promise<WalkResult>;
}

/** Thrown when a path would escape the workspace root. */
export class WorkspaceBoundaryError extends Error {
  constructor(public readonly requestedPath: string) {
    super(`Path escapes the workspace root: ${requestedPath}`);
    this.name = 'WorkspaceBoundaryError';
  }
}

/** Thrown when a file is larger than the reader is willing to load. */
export class FileTooLargeError extends Error {
  constructor(
    public readonly relativePath: string,
    public readonly size: number,
    public readonly limit: number,
  ) {
    super(`File ${relativePath} is ${size} bytes, above the ${limit} byte limit`);
    this.name = 'FileTooLargeError';
  }
}
