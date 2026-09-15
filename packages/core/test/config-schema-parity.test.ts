import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAME,
  NodeWorkspaceFs,
  configJsonSchema,
  loadConfig,
  normalizeIgnorePattern,
} from '@setupguard/core';

/**
 * Parity between the published JSON Schema and the loader.
 *
 * Asserting only that the file on disk was produced by `configJsonSchema()`
 * proves the two files agree — not that the *schema* agrees with the
 * *validation*. It did not: duplicates, `../` and absolute paths all passed the
 * schema and were rejected by the loader, which in the editor means a config
 * that looks valid and then fails the run.
 *
 * Every entry below is checked against both, and any accepted divergence has to
 * be written down as such.
 */

const created: string[] = [];
const KNOWN = ['node/package-json', 'node/docs-script-drift'];

/**
 * A validator for exactly the JSON Schema constructs this schema uses.
 *
 * Hand-written for the same reason the glob matcher is: the subset is small,
 * and a dependency added only to a test would still be a dependency to audit.
 * It covers `const`, `enum`, `type`, `required`, `properties`,
 * `additionalProperties`, `items`, `pattern`, `minLength` and `uniqueItems`.
 */
function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  if ('const' in schema) return value === schema['const'];
  if (Array.isArray(schema['enum'])) return schema['enum'].includes(value);

  switch (schema['type']) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const entries = value as Record<string, unknown>;
      const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const extra = schema['additionalProperties'];

      for (const key of (schema['required'] as string[] | undefined) ?? []) {
        if (!(key in entries)) return false;
      }
      for (const [key, entry] of Object.entries(entries)) {
        const propertySchema = properties[key];
        if (propertySchema) {
          if (!schemaAccepts(propertySchema, entry)) return false;
          continue;
        }
        if (extra === false) return false;
        if (typeof extra === 'object' && extra !== null) {
          if (!schemaAccepts(extra as Record<string, unknown>, entry)) return false;
        }
      }
      return true;
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      const items = schema['items'] as Record<string, unknown> | undefined;
      if (items && !value.every((entry) => schemaAccepts(items, entry))) return false;
      if (schema['uniqueItems'] === true) {
        const seen = value.map((entry) => JSON.stringify(entry));
        if (new Set(seen).size !== seen.length) return false;
      }
      return true;
    }
    case 'string': {
      if (typeof value !== 'string') return false;
      const minLength = schema['minLength'];
      if (typeof minLength === 'number' && value.length < minLength) return false;
      const pattern = schema['pattern'];
      if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) return false;
      return true;
    }
    default:
      return true;
  }
}

async function loaderAccepts(yamlText: string): Promise<boolean> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-parity-'));
  created.push(root);
  await fs.writeFile(path.join(root, CONFIG_FILE_NAME), yamlText);
  const config = await loadConfig({ fs: new NodeWorkspaceFs(root), knownCheckIds: KNOWN });
  return config.valid;
}

interface Case {
  readonly name: string;
  readonly yaml: string;
  readonly valid: boolean;
  /** Set when the schema cannot express the rule and accepts what the loader rejects. */
  readonly structuralOnly?: string;
}

const CASES: readonly Case[] = [
  { name: 'minimal', yaml: 'version: 1\n', valid: true },
  {
    name: 'complete',
    yaml: [
      'version: 1',
      'checks:',
      '  node/docs-script-drift:',
      '    severity: warning',
      'env:',
      '  optional:',
      '    - SENTRY_DSN',
      'ignore:',
      '  - docs/generated/**',
      '',
    ].join('\n'),
    valid: true,
  },
  { name: 'severity off', yaml: 'version: 1\nchecks:\n  node/package-json:\n    severity: off\n', valid: true },
  { name: 'missing version', yaml: 'ignore:\n  - a\n', valid: false },
  { name: 'future version', yaml: 'version: 2\n', valid: false },
  { name: 'version as string', yaml: 'version: "1"\n', valid: false },
  { name: 'unknown top-level key', yaml: 'version: 1\nrules: {}\n', valid: false },
  {
    name: 'unknown check setting',
    yaml: 'version: 1\nchecks:\n  node/package-json:\n    level: off\n',
    valid: false,
  },
  {
    name: 'invalid severity',
    yaml: 'version: 1\nchecks:\n  node/package-json:\n    severity: loud\n',
    valid: false,
  },
  { name: 'env is a list', yaml: 'version: 1\nenv:\n  - A\n', valid: false },
  { name: 'unknown env key', yaml: 'version: 1\nenv:\n  required:\n    - A\n', valid: false },
  { name: 'invalid env name', yaml: 'version: 1\nenv:\n  optional:\n    - "not a name"\n', valid: false },
  {
    name: 'duplicate env name',
    yaml: 'version: 1\nenv:\n  optional:\n    - A\n    - A\n',
    valid: false,
  },
  { name: 'ignore is a string', yaml: 'version: 1\nignore: docs\n', valid: false },
  { name: 'ignore entry is a number', yaml: 'version: 1\nignore:\n  - 42\n', valid: false },
  { name: 'duplicate ignore', yaml: 'version: 1\nignore:\n  - docs\n  - docs\n', valid: false },
  { name: 'ignore traversal', yaml: 'version: 1\nignore:\n  - "../outside"\n', valid: false },
  { name: 'ignore nested traversal', yaml: 'version: 1\nignore:\n  - "docs/../../x"\n', valid: false },
  { name: 'ignore absolute unix', yaml: 'version: 1\nignore:\n  - "/etc/passwd"\n', valid: false },
  { name: 'ignore absolute windows', yaml: 'version: 1\nignore:\n  - "C:\\\\Windows"\n', valid: false },
  { name: 'ignore negation', yaml: 'version: 1\nignore:\n  - "!keep"\n', valid: false },
  { name: 'ignore braces', yaml: 'version: 1\nignore:\n  - "a/{b,c}"\n', valid: false },
  { name: 'ignore blank', yaml: 'version: 1\nignore:\n  - "   "\n', valid: false },

  // Non-canonical spellings. Each one used to be silently rewritten by the
  // loader while the schema saw the literal string, which is how `docs` and
  // `./docs` could pass `uniqueItems` and then collide as duplicates.
  { name: 'ignore dot', yaml: 'version: 1\nignore:\n  - "."\n', valid: false },
  { name: 'ignore dot slash', yaml: 'version: 1\nignore:\n  - "./"\n', valid: false },
  { name: 'ignore dot prefix', yaml: 'version: 1\nignore:\n  - "./docs"\n', valid: false },
  { name: 'ignore trailing slash', yaml: 'version: 1\nignore:\n  - "docs/"\n', valid: false },
  { name: 'ignore empty segment', yaml: 'version: 1\nignore:\n  - "docs//generated"\n', valid: false },
  { name: 'ignore dot segment', yaml: 'version: 1\nignore:\n  - "docs/./generated"\n', valid: false },
  { name: 'ignore backslash separator', yaml: 'version: 1\nignore:\n  - "docs\\\\generated"\n', valid: false },
  { name: 'ignore surrounding spaces', yaml: 'version: 1\nignore:\n  - "  docs  "\n', valid: false },
  {
    name: 'ignore absolute windows behind a space',
    yaml: 'version: 1\nignore:\n  - " C:\\\\Windows"\n',
    valid: false,
  },

  // Duplicates that only collide after normalisation. Rejecting the
  // non-canonical spelling is what keeps `uniqueItems` equivalent to the
  // loader's own uniqueness check.
  {
    name: 'ignore duplicate via dot prefix',
    yaml: 'version: 1\nignore:\n  - docs\n  - "./docs"\n',
    valid: false,
  },
  {
    name: 'ignore duplicate via separators',
    yaml: 'version: 1\nignore:\n  - "docs/generated"\n  - "docs\\\\generated"\n',
    valid: false,
  },

  // A pattern is one path, never several lines.
  { name: 'ignore with a newline', yaml: 'version: 1\nignore:\n  - "docs\\nprivate"\n', valid: false },
  { name: 'ignore with a tab', yaml: 'version: 1\nignore:\n  - "docs\\tprivate"\n', valid: false },

  // `.` and `..` are forbidden *segments*; a longer run of dots is an ordinary
  // file name. The schema used to demand a character that was neither a dot nor
  // a separator, which was stricter than the rule it was meant to mirror.
  { name: 'ignore triple dot', yaml: 'version: 1\nignore:\n  - "..."\n', valid: true },
  { name: 'ignore quadruple dot', yaml: 'version: 1\nignore:\n  - "...."\n', valid: true },
  { name: 'ignore dots around a space', yaml: 'version: 1\nignore:\n  - ". ."\n', valid: true },
  { name: 'ignore name with an inner space', yaml: 'version: 1\nignore:\n  - "my docs"\n', valid: true },
  {
    name: 'unknown check id',
    yaml: 'version: 1\nchecks:\n  node/nope:\n    severity: off\n',
    valid: false,
    // Which ids exist depends on the adapters loaded at run time, so the schema
    // cannot enumerate them without core knowing about Node. Documented in
    // Notes/15 as the one place the schema is structural.
    structuralOnly: 'check ids are not enumerable in a schema shipped by the core',
  },
];

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('schema and loader agree', () => {
  const schema = configJsonSchema();

  for (const testCase of CASES) {
    it(`${testCase.name}: ${testCase.valid ? 'both accept' : 'both reject'}`, async () => {
      const parsed: unknown = parse(testCase.yaml);
      const bySchema = schemaAccepts(schema, parsed);
      const byLoader = await loaderAccepts(testCase.yaml);

      expect(byLoader, 'loader').toBe(testCase.valid);

      if (testCase.structuralOnly) {
        // A recorded divergence, not a silent one.
        expect(bySchema, testCase.structuralOnly).toBe(true);
        return;
      }
      expect(bySchema, 'schema').toBe(testCase.valid);
    });
  }
});

describe('schema and loader agree on every short string', () => {
  it('has no divergence across an exhaustive corpus', () => {
    // A finite hand-written corpus proves the cases someone thought of. This
    // enumerates every string of length 1 to 4 over an alphabet chosen to hit
    // each rule — separators, dots, wildcards, negation, whitespace and a
    // Windows drive root — and requires the two sides to agree on all of them.
    // It is what caught `...` being accepted by the loader and rejected by the
    // schema.
    const pattern = new RegExp(
      (configJsonSchema()['properties'] as Record<string, Record<string, Record<string, string>>>)[
        'ignore'
      ]?.['items']?.['pattern'] ?? '',
    );
    const alphabet = ['a', '.', '/', '\\', '*', '!', ' ', 'C', ':'];

    const schemaOnly: string[] = [];
    const loaderOnly: string[] = [];
    let checked = 0;

    const walk = (prefix: string, depth: number): void => {
      if (prefix !== '') {
        checked += 1;
        const bySchema = pattern.test(prefix);
        const byLoader = normalizeIgnorePattern(prefix).error === undefined;
        if (bySchema && !byLoader) schemaOnly.push(prefix);
        if (byLoader && !bySchema) loaderOnly.push(prefix);
      }
      if (depth === 0) return;
      for (const character of alphabet) walk(prefix + character, depth - 1);
    };
    walk('', 4);

    expect(checked).toBe(7380);
    // The dangerous direction: an editor calls it valid, the run rejects it.
    expect(schemaOnly, 'schema accepts, loader rejects').toEqual([]);
    // The annoying direction: an editor underlines a pattern that works.
    expect(loaderOnly, 'loader accepts, schema rejects').toEqual([]);
  });
});

describe('the mini validator is itself exercised', () => {
  it('rejects what it is meant to reject', () => {
    const schema = configJsonSchema();
    expect(schemaAccepts(schema, { version: 1 })).toBe(true);
    expect(schemaAccepts(schema, { version: 1, ignore: ['a', 'a'] })).toBe(false);
    expect(schemaAccepts(schema, { version: 1, ignore: ['../x'] })).toBe(false);
    expect(schemaAccepts(schema, {})).toBe(false);
    expect(schemaAccepts(schema, [])).toBe(false);
    expect(schemaAccepts(schema, 'string')).toBe(false);
  });
});
