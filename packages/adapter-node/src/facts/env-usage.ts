import type { WorkspaceFs } from '@setupguard/core';

import type { FactGap } from './gaps.js';
import { maskComments } from './mask-comments.js';
import { isInsideNestedProject } from './workspace-boundary.js';

/** One place in the source where an environment variable is read. */
export interface EnvUsage {
  readonly name: string;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
}

/*
 * Note: no source excerpt is captured. A line such as
 * `process.env.TOKEN ?? 'fallback-secret'` would put a literal credential into
 * the report, and file + line is already enough to navigate to the usage.
 */

export const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.vue',
];

const PATTERNS: readonly RegExp[] = [
  // process.env.NAME
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  // process.env['NAME'] / process.env["NAME"]
  /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  // import.meta.env.NAME (Vite)
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
];

export interface ScanEnvUsageOptions {
  readonly maxFiles?: number;
  /**
   * Workspace-relative directory prefixes to skip, each ending in `/`.
   * Used to stay inside the project being diagnosed.
   */
  readonly excludeDirs?: readonly string[];
}

export interface EnvScanResult {
  readonly usages: readonly EnvUsage[];
  /**
   * Non-empty when the scan could not see everything — a file was unreadable or
   * over the size limit, or the walk hit its cap. Callers must not present a
   * partial scan as a complete one.
   */
  readonly gaps: readonly FactGap[];
}

/**
 * Find environment variables read by the project's own source.
 *
 * This is an inference, not a declaration, so findings derived from it carry at
 * most `medium` confidence. Generated and vendored directories are excluded by
 * {@link WorkspaceFs.walk}; nested projects are excluded by `excludeDirs`;
 * comments are blanked before matching.
 */
export async function scanEnvUsage(
  fs: WorkspaceFs,
  options: ScanEnvUsageOptions = {},
): Promise<EnvScanResult> {
  const walked = await fs.walk({
    extensions: SOURCE_EXTENSIONS,
    maxFiles: options.maxFiles ?? 2000,
  });

  const excludeDirs = options.excludeDirs ?? [];
  const usages: EnvUsage[] = [];
  const gaps: FactGap[] = [];
  const seen = new Set<string>();

  if (walked.truncated) {
    gaps.push({
      scope: 'source-scan',
      reason: 'the source scan hit its file limit, so some usages may be missing',
    });
  }
  if (walked.depthLimited) {
    gaps.push({
      scope: 'source-scan',
      reason: 'the source tree is deeper than the scan limit, so some usages may be missing',
    });
  }

  for (const file of walked.files) {
    if (isInsideNestedProject(file, excludeDirs)) continue;

    let text: string;
    try {
      text = await fs.readText(file);
    } catch (error) {
      gaps.push({
        scope: 'source-scan',
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const lines = maskComments(text).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const name = match[1];
          if (!name) continue;
          const dedupeKey = `${name}::${file}::${index}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          usages.push({ name, file, line: index + 1 });
        }
      }
    }
  }

  return { usages, gaps };
}

/** Group usages by variable name, preserving discovery order. */
export function groupUsagesByName(usages: readonly EnvUsage[]): Map<string, EnvUsage[]> {
  const grouped = new Map<string, EnvUsage[]>();
  for (const usage of usages) {
    const bucket = grouped.get(usage.name);
    if (bucket) bucket.push(usage);
    else grouped.set(usage.name, [usage]);
  }
  return grouped;
}
