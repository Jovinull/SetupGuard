import { describe, expect, it } from 'vitest';

import { locateJsonKey } from '@setupguard/core';

const MANIFEST = `{
  "name": "demo",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "keywords": ["a", "b"]
}
`;

describe('locateJsonKey', () => {
  it('locates a top-level key', () => {
    expect(locateJsonKey(MANIFEST, ['name'])).toEqual({
      key: { line: 2, column: 3 },
      value: { line: 2, column: 11 },
    });
  });

  it('locates a nested key', () => {
    expect(locateJsonKey(MANIFEST, ['scripts', 'test'])?.key).toEqual({ line: 8, column: 5 });
  });

  it('skips over arrays and preceding objects', () => {
    expect(locateJsonKey(MANIFEST, ['keywords'])?.key).toEqual({ line: 10, column: 3 });
  });

  it('returns undefined for an unknown path', () => {
    expect(locateJsonKey(MANIFEST, ['scripts', 'lint'])).toBeUndefined();
    expect(locateJsonKey(MANIFEST, ['nope'])).toBeUndefined();
    expect(locateJsonKey(MANIFEST, [])).toBeUndefined();
  });

  it('never throws on malformed input', () => {
    // The scanner assumes the document already parsed; on truncated input it
    // may still locate a key it has read, but it must never throw.
    expect(() => locateJsonKey('{ "a": ', ['a'])).not.toThrow();
    expect(locateJsonKey('not json at all', ['a'])).toBeUndefined();
    expect(locateJsonKey('{ "a": {', ['a', 'b'])).toBeUndefined();
    expect(locateJsonKey('', ['a'])).toBeUndefined();
  });

  it('handles escapes inside string values', () => {
    const text = '{\n  "a": "say \\"hi\\" \\\\ done",\n  "b": 1\n}';
    expect(locateJsonKey(text, ['b'])?.key).toEqual({ line: 3, column: 3 });
  });

  it('handles unicode escapes inside keys', () => {
    const text = '{ "caf\\u00e9": 1, "b": 2 }';
    expect(locateJsonKey(text, ['café'])?.key).toEqual({ line: 1, column: 3 });
  });
});
