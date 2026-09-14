import { offsetToPosition, type TextPosition } from './text-position.js';

/**
 * Minimal position-aware JSON scanner.
 *
 * `JSON.parse` discards positions, but a finding about `scripts.build` is far
 * more useful when it can point at the exact line of `package.json`. This
 * scanner walks the raw text and records where each key/value pair starts.
 *
 * It is a scanner, not a validator: it assumes the document already parsed
 * successfully with `JSON.parse`, and returns `undefined` rather than throwing
 * when it cannot follow a path.
 */
export interface JsonLocation {
  /** Position of the key token (the opening quote). */
  readonly key: TextPosition;
  /** Position of the first character of the value. */
  readonly value: TextPosition;
}

/**
 * Locate a property inside a JSON document by its path.
 *
 * @example
 * locateJsonKey(text, ['scripts', 'build'])
 */
export function locateJsonKey(text: string, path: readonly string[]): JsonLocation | undefined {
  if (path.length === 0) return undefined;
  const scanner = new Scanner(text);
  try {
    return scanner.findInValue(path, 0);
  } catch {
    return undefined;
  }
}

class Scanner {
  #index = 0;

  constructor(private readonly text: string) {}

  /** Search for `path` starting at the value that begins at the current index. */
  findInValue(path: readonly string[], depth: number): JsonLocation | undefined {
    this.#skipWhitespace();
    const char = this.text[this.#index];
    if (char === '{') return this.#findInObject(path, depth);
    if (char === '[') {
      this.#skipValue();
      return undefined;
    }
    this.#skipValue();
    return undefined;
  }

  #findInObject(path: readonly string[], depth: number): JsonLocation | undefined {
    const wanted = path[depth];
    this.#expect('{');

    for (;;) {
      this.#skipWhitespace();
      if (this.text[this.#index] === '}') {
        this.#index += 1;
        return undefined;
      }

      const keyStart = this.#index;
      const key = this.#readString();
      this.#skipWhitespace();
      this.#expect(':');
      this.#skipWhitespace();
      const valueStart = this.#index;

      if (key === wanted) {
        if (depth === path.length - 1) {
          return {
            key: offsetToPosition(this.text, keyStart),
            value: offsetToPosition(this.text, valueStart),
          };
        }
        const nested = this.findInValue(path, depth + 1);
        if (nested) return nested;
      } else {
        this.#skipValue();
      }

      this.#skipWhitespace();
      if (this.text[this.#index] === ',') {
        this.#index += 1;
        continue;
      }
      if (this.text[this.#index] === '}') {
        this.#index += 1;
        return undefined;
      }
      throw new Error(`Unexpected character at offset ${this.#index}`);
    }
  }

  #skipValue(): void {
    this.#skipWhitespace();
    const char = this.text[this.#index];
    if (char === '"') {
      this.#readString();
      return;
    }
    if (char === '{' || char === '[') {
      const open = char;
      const close = char === '{' ? '}' : ']';
      let depth = 0;
      for (; this.#index < this.text.length; this.#index += 1) {
        const current = this.text[this.#index];
        if (current === '"') {
          this.#readString();
          this.#index -= 1; // the loop step re-advances
          continue;
        }
        if (current === open) depth += 1;
        else if (current === close) {
          depth -= 1;
          if (depth === 0) {
            this.#index += 1;
            return;
          }
        }
      }
      throw new Error('Unterminated container');
    }
    // number, true, false, null
    while (this.#index < this.text.length && !',}] \t\r\n'.includes(this.text[this.#index] ?? '')) {
      this.#index += 1;
    }
  }

  #readString(): string {
    this.#expect('"');
    let value = '';
    for (; this.#index < this.text.length; this.#index += 1) {
      const char = this.text[this.#index];
      if (char === '\\') {
        const next = this.text[this.#index + 1] ?? '';
        if (next === 'u') {
          const hex = this.text.slice(this.#index + 2, this.#index + 6);
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.#index += 5;
          continue;
        }
        value += UNESCAPE[next] ?? next;
        this.#index += 1;
        continue;
      }
      if (char === '"') {
        this.#index += 1;
        return value;
      }
      value += char ?? '';
    }
    throw new Error('Unterminated string');
  }

  #skipWhitespace(): void {
    while (this.#index < this.text.length && ' \t\r\n'.includes(this.text[this.#index] ?? '')) {
      this.#index += 1;
    }
  }

  #expect(char: string): void {
    if (this.text[this.#index] !== char) {
      throw new Error(`Expected "${char}" at offset ${this.#index}`);
    }
    this.#index += 1;
  }
}

const UNESCAPE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};
