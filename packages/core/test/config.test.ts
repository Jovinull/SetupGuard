import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAME,
  NodeWorkspaceFs,
  loadConfig,
  type ConfigDiagnosticCode,
  type ResolvedConfig,
} from '@setupguard/core';

/**
 * Discovery, parsing, validation and normalisation of `.setupguard.yml`.
 *
 * Two rules drive every case here: a configuration problem is never silent, and
 * it is never reported as a problem with the project.
 */

const created: string[] = [];
const KNOWN = ['node/package-json', 'node/docs-script-drift', 'node/env-contract'];

async function withConfig(content?: string, extra: Record<string, string> = {}): Promise<ResolvedConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-config-'));
  created.push(root);
  if (content !== undefined) await fs.writeFile(path.join(root, CONFIG_FILE_NAME), content);
  for (const [name, body] of Object.entries(extra)) {
    await fs.writeFile(path.join(root, name), body);
  }
  return loadConfig({ fs: new NodeWorkspaceFs(root), knownCheckIds: KNOWN });
}

function codes(config: ResolvedConfig): ConfigDiagnosticCode[] {
  return config.diagnostics.map((diagnostic) => diagnostic.code);
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('discovery', () => {
  it('returns the defaults when no file exists', async () => {
    const config = await withConfig();

    expect(config).toMatchObject({ valid: true, ignore: [], diagnostics: [] });
    expect(config.source).toBeUndefined();
    expect(config.checks.size).toBe(0);
    expect(config.optionalEnvVars.size).toBe(0);
  });

  it('reports a file that is nearly but not quite the right name', async () => {
    const config = await withConfig(undefined, { '.setupguard.yaml': 'version: 1\n' });

    // Loading nothing and saying nothing would be the worst outcome: the author
    // believes the file is in effect.
    expect(codes(config)).toEqual(['config/misnamed-file']);
    expect(config.valid).toBe(false);
    expect(config.diagnostics[0]?.remediation).toContain('.setupguard.yml');
  });
});

describe('valid configuration', () => {
  it('accepts the minimal file', async () => {
    const config = await withConfig('version: 1\n');

    expect(config.valid).toBe(true);
    expect(config.diagnostics).toEqual([]);
    expect(config.source).toBe(CONFIG_FILE_NAME);
  });

  it('accepts a complete file', async () => {
    const config = await withConfig(
      [
        'version: 1',
        'checks:',
        '  node/docs-script-drift:',
        '    severity: warning',
        '  node/env-contract:',
        '    severity: off',
        'env:',
        '  optional:',
        '    - SENTRY_DSN',
        '    - ANALYTICS_KEY',
        'ignore:',
        '  - docs/generated/**',
        '  - examples/**',
        '',
      ].join('\n'),
    );

    expect(config.valid).toBe(true);
    expect(config.checks.get('node/docs-script-drift')).toBe('warning');
    expect(config.checks.get('node/env-contract')).toBe('off');
    expect([...config.optionalEnvVars]).toEqual(['SENTRY_DSN', 'ANALYTICS_KEY']);
    expect(config.ignore).toEqual(['docs/generated/**', 'examples/**']);
  });

  it('reads bare `off` as the string, not as a boolean', async () => {
    // YAML 1.1 would fold `off` into `false`. The parser is on the 1.2 core
    // schema, and this pins that.
    const config = await withConfig(
      'version: 1\nchecks:\n  node/env-contract:\n    severity: off\n',
    );
    expect(config.checks.get('node/env-contract')).toBe('off');
  });

  it('normalises ignore patterns deterministically', async () => {
    const first = await withConfig('version: 1\nignore:\n  - "./b/**"\n  - a\n');
    const second = await withConfig('version: 1\nignore:\n  - a\n  - "b/**"\n');

    expect(first.ignore).toEqual(second.ignore);
    expect(first.ignore).toEqual(['a', 'b/**']);
  });
});

describe('invalid configuration', () => {
  const cases: readonly [string, string, ConfigDiagnosticCode][] = [
    ['broken YAML', 'version: 1\nchecks: [\n', 'config/invalid-yaml'],
    ['empty file', '', 'config/version-missing'],
    ['comments only', '# nothing here\n', 'config/version-missing'],
    ['missing version', 'ignore:\n  - a\n', 'config/version-missing'],
    ['future version', 'version: 2\n', 'config/version-unsupported'],
    ['non-numeric version', 'version: "1"\n', 'config/version-unsupported'],
    ['unknown top-level key', 'version: 1\nrules: {}\n', 'config/unknown-key'],
    ['not a mapping', '- version\n', 'config/not-an-object'],
    ['scalar document', 'just a string\n', 'config/not-an-object'],
    ['checks is a list', 'version: 1\nchecks:\n  - a\n', 'config/wrong-type'],
    ['unknown check id', 'version: 1\nchecks:\n  node/nope:\n    severity: off\n', 'config/unknown-check'],
    [
      'unknown check setting',
      'version: 1\nchecks:\n  node/package-json:\n    level: off\n',
      'config/unknown-key',
    ],
    [
      'invalid severity',
      'version: 1\nchecks:\n  node/package-json:\n    severity: loud\n',
      'config/invalid-severity',
    ],
    ['env is a list', 'version: 1\nenv:\n  - SENTRY_DSN\n', 'config/wrong-type'],
    ['env.optional is a string', 'version: 1\nenv:\n  optional: SENTRY_DSN\n', 'config/wrong-type'],
    ['invalid env name', 'version: 1\nenv:\n  optional:\n    - "not a name"\n', 'config/invalid-env-name'],
    ['env name as a pattern', 'version: 1\nenv:\n  optional:\n    - "SENTRY_*"\n', 'config/invalid-env-name'],
    [
      'duplicate env name',
      'version: 1\nenv:\n  optional:\n    - SENTRY_DSN\n    - SENTRY_DSN\n',
      'config/duplicate-entry',
    ],
    ['ignore is a string', 'version: 1\nignore: docs\n', 'config/wrong-type'],
    ['ignore entry is a number', 'version: 1\nignore:\n  - 42\n', 'config/wrong-type'],
    ['duplicate ignore', 'version: 1\nignore:\n  - docs\n  - docs\n', 'config/duplicate-entry'],
    ['duplicate key', 'version: 1\nversion: 1\n', 'config/invalid-yaml'],
    ['yaml alias', 'version: 1\nignore: &a\n  - x\nenv: *a\n', 'config/unsupported-syntax'],
    ['unknown tag', 'version: 1\nignore: !!js/function "x"\n', 'config/unsupported-syntax'],
  ];

  for (const [name, content, code] of cases) {
    it(`rejects ${name}`, async () => {
      const config = await withConfig(content);

      expect(codes(config), name).toContain(code);
      expect(config.valid).toBe(false);
      // Defaults, never a half-applied configuration.
      expect(config.checks.size).toBe(0);
      expect(config.ignore).toEqual([]);
      expect(config.optionalEnvVars.size).toBe(0);
    });
  }

  it('points at the offending line, column and field', async () => {
    const config = await withConfig(
      'version: 1\nchecks:\n  node/package-json:\n    severity: loud\n',
    );
    const diagnostic = config.diagnostics[0];

    expect(diagnostic).toMatchObject({
      code: 'config/invalid-severity',
      file: CONFIG_FILE_NAME,
      line: 4,
      path: 'checks.node/package-json.severity',
    });
    expect(diagnostic?.column).toBeGreaterThan(0);
  });

  it('names the known check ids so a typo is easy to fix', async () => {
    const config = await withConfig('version: 1\nchecks:\n  node/docs-drift:\n    severity: off\n');

    expect(config.diagnostics[0]?.code).toBe('config/unknown-check');
    expect(config.diagnostics[0]?.remediation).toContain('node/docs-script-drift');
  });

  it('sanitises credential-shaped text coming out of the configuration', async () => {
    // Everything a diagnostic quotes came from a file in the repository, so it
    // goes through the same redactor as every other report field.
    const config = await withConfig('version: 1\nAPI_TOKEN=QA-FAKE-CONFIG-SECRET: 1\n');

    const serialized = JSON.stringify(config.diagnostics);
    expect(serialized).not.toContain('QA-FAKE-CONFIG-SECRET');
    expect(config.valid).toBe(false);
  });

  it('reports every problem in one pass instead of stopping at the first', async () => {
    const config = await withConfig(
      [
        'version: 3',
        'checks:',
        '  node/nope:',
        '    severity: off',
        'env:',
        '  optional:',
        '    - "bad name"',
        'ignore:',
        '  - ../escape',
        '',
      ].join('\n'),
    );

    expect(new Set(codes(config))).toEqual(
      new Set([
        'config/version-unsupported',
        'config/unknown-check',
        'config/invalid-env-name',
        'config/invalid-ignore-pattern',
      ]),
    );
  });
});
