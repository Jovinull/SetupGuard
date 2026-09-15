/**
 * Ignore patterns.
 *
 * A deliberately small glob dialect, implemented here rather than pulled in:
 * the whole surface is four constructs, and a pattern that decides what a
 * security-relevant scanner does not look at is worth being able to audit in
 * one file.
 *
 * Supported:
 *
 * | Pattern            | Matches                                              |
 * |--------------------|------------------------------------------------------|
 * | `examples`         | that directory and everything under it               |
 * | `examples/**`      | everything under it                                  |
 * | `docs/*.md`        | Markdown directly in `docs`, not in its subfolders    |
 * | `docs/**\/*.md`    | Markdown at any depth under `docs`                   |
 * | `build?`           | `build1`, `buildX`; one character, never a separator |
 *
 * Not supported, on purpose: brace expansion, character classes, negation and
 * absolute paths. Each of those adds a way to write a pattern that means
 * something different from what it looks like.
 */

/** Why a pattern was rejected. `undefined` when it is acceptable. */
export type IgnorePatternError =
  | 'empty'
  | 'absolute'
  | 'traversal'
  | 'negation'
  | 'unsupported-syntax';

export interface NormalizedIgnorePattern {
  readonly pattern?: string;
  readonly error?: IgnorePatternError;
}

/** Windows drive-letter roots, e.g. `C:/x` or `C:\x`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Constructs this dialect does not implement and must not silently accept. */
const UNSUPPORTED = /[[\]{}()!+@]/;

/**
 * Normalise a pattern to a workspace-relative POSIX form, or explain why it
 * cannot be used.
 *
 * Everything that could point outside the workspace is rejected rather than
 * clamped: an ignore rule that quietly means something else is how a scan stops
 * looking at the very thing it was meant to check.
 */
export function normalizeIgnorePattern(raw: string): NormalizedIgnorePattern {
  const unified = raw.replace(/\\/g, '/').trim();

  if (unified === '') return { error: 'empty' };
  if (unified.startsWith('!')) return { error: 'negation' };
  if (unified.startsWith('/') || WINDOWS_ABSOLUTE.test(raw)) return { error: 'absolute' };
  if (UNSUPPORTED.test(unified)) return { error: 'unsupported-syntax' };

  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return { error: 'traversal' };
  if (segments.length === 0) return { error: 'empty' };

  return { pattern: segments.join('/') };
}

/** True when the workspace-relative path is covered by any pattern. */
export function matchesIgnore(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const candidate = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some((pattern) => matchesPattern(candidate, pattern));
}

function matchesPattern(candidate: string, pattern: string): boolean {
  // A pattern with no wildcard names a path prefix: `examples` covers
  // `examples/a/b.js`, which is what someone writing it expects.
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return candidate === pattern || candidate.startsWith(`${pattern}/`);
  }
  return toRegExp(pattern).test(candidate);
}

const regexpCache = new Map<string, RegExp>();

/**
 * Compile a pattern into an anchored regular expression.
 *
 * `**` is handled positionally rather than through a placeholder, because the
 * separator it absorbs depends on where it sits: leading, interior and trailing
 * globstars each consume a different side.
 */
function toRegExp(pattern: string): RegExp {
  const cached = regexpCache.get(pattern);
  if (cached) return cached;

  const segments = pattern.split('/');
  let body = '';
  let needSeparator = false;

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;

    if (segment === '**') {
      if (index === 0 && isLast) body += '.*';
      // Trailing: the directory itself, and everything below it.
      else if (isLast) body += '(?:/.*)?';
      // Leading: any number of leading segments, or none.
      else if (index === 0) body += '(?:[^/]+/)*';
      // Interior: `a/**/b` must also match `a/b`.
      else body += '(?:/[^/]+)*/';
      needSeparator = false;
      continue;
    }

    if (needSeparator) body += '/';
    body += escapeSegment(segment);
    needSeparator = true;
  }

  const expression = new RegExp(`^${body}$`);
  regexpCache.set(pattern, expression);
  return expression;
}

/** `*` and `?` become wildcards inside one segment; everything else is literal. */
function escapeSegment(segment: string): string {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}
