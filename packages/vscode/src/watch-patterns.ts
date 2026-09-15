import { CONFIG_FILE_NAME, DEFAULT_IGNORED_DIRS, MISNAMED_CONFIG_FILES } from '@setupguard/core';

/**
 * Which file changes are worth a new diagnosis.
 *
 * Kept as data, separate from the extension host, for two reasons: the list is
 * the honest answer to "when does the status bar go stale?", and watching too
 * much is a real cost in a large repository. Nothing here reads a file — these
 * are globs handed to VS Code and a predicate used to drop events VS Code
 * should have filtered but did not.
 */

/** Files SetupGuard reads by name. A change to any of them can flip a verdict. */
export const STRUCTURAL_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  '.nvmrc',
  '.node-version',
  '.env',
  '.env.local',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.development',
  'env.example',
  CONFIG_FILE_NAME,
  ...MISNAMED_CONFIG_FILES,
];

/** Documents the drift check reads. */
export const DOCUMENT_GLOBS: readonly string[] = [
  '*.md',
  'docs/**/*.md',
  'docs/**/*.mdx',
  '.github/CONTRIBUTING.md',
];

/**
 * Source files, because the environment contract is inferred from how the code
 * reads `process.env`. Watching them is what makes "add a new variable, see the
 * warning" work without an explicit re-run; the debounce is what keeps a save
 * storm from turning into a run storm.
 */
export const SOURCE_GLOBS: readonly string[] = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

/**
 * Globs for `vscode.workspace.createFileSystemWatcher`, relative to a folder.
 *
 * Nested manifests matter too — a new `sub/package.json` moves a workspace
 * boundary — so the structural names are watched at any depth.
 */
export const WATCH_GLOBS: readonly string[] = [
  `**/{${STRUCTURAL_FILES.join(',')}}`,
  ...DOCUMENT_GLOBS,
  ...SOURCE_GLOBS,
];

/** Directories whose contents never change a verdict, in POSIX form. */
const IGNORED_DIR_SET = new Set(DEFAULT_IGNORED_DIRS);

/**
 * Last line of defence against pointless runs.
 *
 * VS Code applies `files.watcherExclude`, which normally hides `node_modules`
 * and `.git`, but that is a user setting and a `pnpm install` writing tens of
 * thousands of files is exactly when we least want to be woken up. The engine
 * ignores these directories anyway, so an event from one cannot change the
 * report.
 *
 * @param relativePath workspace-relative path, either separator.
 */
export function shouldTriggerRun(relativePath: string): boolean {
  if (relativePath === '') return false;
  const segments = relativePath.replace(/\\/g, '/').split('/');
  // The file name itself is not a directory, so it is not tested: a file called
  // `build` or `out` is still a file.
  return !segments.slice(0, -1).some((segment) => IGNORED_DIR_SET.has(segment));
}
