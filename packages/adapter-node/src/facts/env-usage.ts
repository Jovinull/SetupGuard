import { offsetToPosition, type WorkspaceFs } from '@setupguard/core';

import type { EnvAccessForm } from './dotenv.js';
import type { FactGap } from './gaps.js';
import { maskComments } from './mask-comments.js';
import { isInsideNestedProject } from './workspace-boundary.js';

/** One place in the source where an environment variable is read. */
export interface EnvUsage {
  readonly name: string;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /**
   * Which accessor was used. Needed because a name can be ambient through one
   * form and project-owned through another: `import.meta.env.MODE` is a Vite
   * builtin, `process.env.MODE` is not.
   */
  readonly form: EnvAccessForm;
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

interface AccessPattern {
  readonly pattern: RegExp;
  readonly form: EnvAccessForm;
  /** Destructuring patterns capture a whole binding list, not a single name. */
  readonly destructuring?: boolean;
}

const PATTERNS: readonly AccessPattern[] = [
  // process.env.NAME
  { pattern: /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, form: 'process.env' },
  // process.env['NAME'] / process.env["NAME"]
  {
    pattern: /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
    form: 'process.env',
  },
  // import.meta.env.NAME (Vite)
  { pattern: /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, form: 'import.meta.env' },
  // const { NAME, OTHER: alias, THIRD = 'x' } = process.env
  {
    pattern:
      /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*process\.env(?![.[\w])/g,
    form: 'process.env',
    destructuring: true,
  },
  {
    pattern:
      /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*import\.meta\.env(?![.[\w])/g,
    form: 'import.meta.env',
    destructuring: true,
  },
];

/**
 * Names bound by a destructuring pattern.
 *
 * Handles `{ A, B: alias, C = 'default' }` by keeping only the property name —
 * the part before `:` or `=`. Anything else (rest elements, nested patterns,
 * computed keys) is skipped rather than guessed at: this is a scanner, not a
 * JavaScript parser.
 */
export function destructuredNames(bindingList: string): string[] {
  return bindingList
    .split(',')
    .map((entry) => entry.split(/[:=]/, 1)[0]?.trim() ?? '')
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

export interface ScanEnvUsageOptions {
  readonly maxFiles?: number;
  /**
   * Workspace-relative directory prefixes to skip, each ending in `/`.
   * Used to stay inside the project being diagnosed.
   */
  readonly excludeDirs?: readonly string[];
  /** Normalised `.setupguard.yml` ignore patterns. */
  readonly ignore?: readonly string[];
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
    ...(options.ignore ? { ignore: options.ignore } : {}),
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

    // Matched over the whole masked file rather than line by line: a
    // destructuring pattern is routinely spread across several lines.
    const masked = maskComments(text);
    for (const { pattern, form, destructuring } of PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(masked)) !== null) {
        const captured = match[1];
        if (!captured) continue;
        const line = offsetToPosition(masked, match.index).line;
        for (const name of destructuring ? destructuredNames(captured) : [captured]) {
          const dedupeKey = `${name}::${file}::${line}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          usages.push({ name, file, line, form });
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
