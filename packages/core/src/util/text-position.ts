/** 1-based position inside a text file. */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

/** Convert a 0-based character offset into a 1-based line/column pair. */
export function offsetToPosition(text: string, offset: number): TextPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * Trim an excerpt to a safe display length. Findings quote repository content,
 * which is untrusted and may be arbitrarily long.
 */
export function excerpt(value: string, maxLength = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}
