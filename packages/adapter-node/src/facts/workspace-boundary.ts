import type { WorkspaceFs } from '@setupguard/core';

import type { FactGap } from './gaps.js';

/**
 * Directories that belong to a *different* Node project than the one being
 * diagnosed, because they carry their own `package.json`.
 *
 * This is the project boundary, and it matters for every inference that scans
 * source files: the root project's `.env.example` is not expected to document
 * variables read by a nested package. Without this rule, SetupGuard's own
 * repository reports the environment variables of its test fixtures as
 * undocumented — a false positive found by running the tool on itself.
 *
 * It is also the first piece of monorepo handling: workspaces are exactly these
 * nested projects, and v0.1 excludes them from the root diagnosis rather than
 * pretending to analyse them (`Notes/10-adapters-e-configuracao.md`).
 *
 * A truncated or depth-limited search is reported as a gap rather than
 * silently accepted: an undiscovered nested project means the source scan
 * crosses a workspace boundary and attributes a child package's code to the
 * root, which is the false positive this function exists to prevent.
 */
export interface NestedProjectScan {
  /** Workspace-relative directory prefixes, each ending in `/`. */
  readonly dirs: readonly string[];
  readonly gaps: readonly FactGap[];
}

/** Cap on how many manifests the boundary search will look at. */
export const MAX_NESTED_PROJECT_MANIFESTS = 500;

export async function findNestedProjectDirs(
  fs: WorkspaceFs,
  options: { readonly maxFiles?: number } = {},
): Promise<NestedProjectScan> {
  const walked = await fs.walk({
    names: ['package.json'],
    maxFiles: options.maxFiles ?? MAX_NESTED_PROJECT_MANIFESTS,
  });

  const gaps: FactGap[] = [];
  if (walked.truncated) {
    gaps.push({
      scope: 'source-scan',
      reason:
        'the search for nested projects hit its limit, so a workspace boundary may have been missed',
    });
  }
  if (walked.depthLimited) {
    gaps.push({
      scope: 'source-scan',
      reason:
        'the repository is deeper than the nested-project search limit, so a workspace boundary may have been missed',
    });
  }

  const dirs = walked.files
    .filter((file) => file !== 'package.json')
    .map((file) => file.slice(0, file.length - 'package.json'.length))
    .filter((dir) => dir !== '');

  return { dirs, gaps };
}

/** True when `file` lives inside one of the nested project directories. */
export function isInsideNestedProject(file: string, nestedDirs: readonly string[]): boolean {
  return nestedDirs.some((dir) => file.startsWith(dir));
}
