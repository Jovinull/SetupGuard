/**
 * Blank out comments in JavaScript/TypeScript source, preserving offsets.
 *
 * `// process.env.GHOST` used to be reported as a real environment-variable
 * usage, which is exactly the kind of false positive that makes a linter-shaped
 * tool lose credibility.
 *
 * The scanner tracks string and template literals so that a URL like
 * `"http://example.com"` is not mistaken for a comment. Comment characters are
 * replaced with spaces rather than removed, so every subsequent match keeps its
 * real line and column.
 *
 * Known limitation: regular-expression literals are not tracked, because
 * telling `/re/` from division needs real parsing. The failure mode is benign —
 * a `//` inside a regex would end up treated as a comment for the rest of that
 * line — and `process.env` inside a regex literal is not a real pattern.
 * String *contents* are deliberately kept, because `process.env['NAME']` reads
 * its variable name from a string.
 */
export function maskComments(source: string): string {
  const output = source.split('');
  let index = 0;

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < output.length; i += 1) {
      if (output[i] !== '\n') output[i] = ' ';
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      let end = source.indexOf('\n', index);
      if (end === -1) end = source.length;
      blank(index, end);
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }

    index += 1;
  }

  return output.join('');
}

/** Advance past a string or template literal, honouring backslash escapes. */
function skipString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // An unterminated single- or double-quoted string cannot span lines; give
    // up at the newline so one stray quote does not swallow the whole file.
    if (char === '\n' && quote !== '`') return index;
    index += 1;
  }
  return index;
}
