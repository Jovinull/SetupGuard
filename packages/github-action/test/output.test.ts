import { describe, expect, it } from 'vitest';

import { escapeData, escapeHtml, escapeProperty, formatAnnotation, formatOutputs, inertBlock } from '../src/index.js';

/**
 * The escaping primitives, tested against the inputs that matter: anything an
 * author of a pull request can put in a file name, a README or a script name.
 */

/** What the runner does to a value before using it (the inverse of escapeData/escapeProperty). */
function unescape(value: string): string {
  return value.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%25/g, '%');
}

const HOSTILE = [
  'line\n::error::injected',
  'cr\r::warning::injected',
  '%0A::set-output name=x::y',
  'a,title=spoofed',
  'file=../../etc/passwd',
  'x::y::z',
  '%25%0A%3A',
  '::stop-commands::guess',
];

describe('workflow command escaping', () => {
  it.each(HOSTILE)('keeps %j on one line and round-trips it exactly', (value) => {
    const line = formatAnnotation({ level: 'error', title: value, file: value, line: 3, message: value });
    expect(line.split('\n')).toHaveLength(1);
    expect(line.split('\r')).toHaveLength(1);
    // Properties cannot contain the separators that would end them early.
    const header = line.slice(2, line.indexOf('::', 2));
    const properties = header.slice('error '.length).split(',');
    expect(properties.map((p) => p.split('=')[0])).toEqual(['title', 'file', 'line']);
    expect(unescape(properties[0]!.slice('title='.length))).toBe(value);
    expect(unescape(line.slice(line.indexOf('::', 2) + 2))).toBe(value);
    expect(unescape(escapeData(value))).toBe(value);
    expect(unescape(escapeProperty(value))).toBe(value);
  });

  it('drops positions that are not positive integers rather than guessing', () => {
    expect(formatAnnotation({ level: 'warning', file: 'a.md', line: 0, col: Number.NaN, endLine: 2.5, message: 'm' })).toBe(
      '::warning file=a.md::m',
    );
    expect(formatAnnotation({ level: 'notice', line: 4, message: 'no file' })).toBe('::notice::no file');
  });

  it('wraps free-form text in a stop-commands region the text cannot close early', () => {
    const block = inertBlock('a\r\n::guess::\u001b[2Jb', 'tok');
    expect(block.split('\n')).toEqual(['::stop-commands::tok', 'a', '::guess:: [2Jb', '::tok::']);
  });

  it('only writes simple output values', () => {
    expect(formatOutputs({ result: 'pass', 'new-errors': 0 })).toBe('result=pass\nnew-errors=0\n');
    expect(() => formatOutputs({ result: 'pass\nevil=1' })).toThrow();
    expect(() => formatOutputs({ 'evil\n': 'x' })).toThrow();
  });
});

describe('summary escaping', () => {
  it.each([
    ['![pixel](https://tracker.invalid/p.png)', /!\[|\]\(|https:\/\//],
    ['<img src=x onerror=alert(1)>', /<img/],
    ['<script>alert(1)</script>', /<script/],
    ['[click](javascript:alert(1))', /\]\(|javascript:/],
    ['https://phish.invalid/login', /https:\/\//],
    ['a | b', /\|/],
    ['line one\n\nline two', /\n/],
    ['&lt;already escaped&gt;', /&lt;/],
  ])('neutralises %j', (value, forbidden) => {
    expect(escapeHtml(value)).not.toMatch(forbidden);
  });

  it('escapes each character once, so entities are never double-encoded', () => {
    expect(escapeHtml(`'#`)).toBe('&#39;&#35;');
    expect(escapeHtml('a & b')).toBe('a &#38; b');
  });
});
