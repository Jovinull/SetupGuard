import { describe, expect, it } from 'vitest';

import {
  buildRequirement,
  extractDocumentedCommands,
  findConflicts,
  parseDotenvKeys,
  parseScriptReferences,
  readPackageManagerField,
  toRange,
  unsatisfied,
} from '@setupguard/adapter-node';

describe('parseDotenvKeys', () => {
  it('extracts keys, line numbers and emptiness without keeping values', () => {
    const file = parseDotenvKeys(
      '.env',
      ['# comment', '', 'DATABASE_URL=postgres://user:pw@host/db', 'export TOKEN=abc', 'EMPTY='].join(
        '\n',
      ),
    );

    expect([...file.keys]).toEqual(['DATABASE_URL', 'TOKEN', 'EMPTY']);
    expect(file.entries).toEqual([
      { key: 'DATABASE_URL', line: 3, empty: false },
      { key: 'TOKEN', line: 4, empty: false },
      { key: 'EMPTY', line: 5, empty: true },
    ]);
  });

  it('keeps no trace of any value in the parsed result', () => {
    const file = parseDotenvKeys('.env', 'SECRET=super-secret-value');
    expect(JSON.stringify([...file.entries])).not.toContain('super-secret-value');
  });

  it('ignores lines that are not declarations', () => {
    const file = parseDotenvKeys('.env', ['just text', '#A=1', '  # B=2', 'C=3'].join('\n'));
    expect([...file.keys]).toEqual(['C']);
  });
});

describe('parseScriptReferences', () => {
  it('reads the explicit run form with high confidence', () => {
    expect(parseScriptReferences('npm run build')).toEqual([
      { script: 'build', manager: 'npm', confidence: 'high', raw: 'npm run build' },
    ]);
  });

  it('treats npm lifecycle shortcuts as script references', () => {
    expect(parseScriptReferences('npm test')[0]).toMatchObject({ script: 'test', confidence: 'high' });
    expect(parseScriptReferences('pnpm start')[0]).toMatchObject({ script: 'start', confidence: 'high' });
  });

  it('reads the implicit pnpm/yarn/bun form with medium confidence', () => {
    expect(parseScriptReferences('pnpm dev')[0]).toMatchObject({ script: 'dev', confidence: 'medium' });
    expect(parseScriptReferences('yarn lint')[0]).toMatchObject({ script: 'lint', confidence: 'medium' });
  });

  it('never treats package-manager sub-commands as scripts', () => {
    for (const command of [
      'npm install',
      'npm ci',
      'pnpm install --frozen-lockfile',
      'yarn add react',
      'pnpm dlx create-next-app',
      'pnpm store prune',
      'yarn',
    ]) {
      expect(parseScriptReferences(command)).toEqual([]);
    }
  });

  it('ignores a bare npm sub-command, because npm has no implicit script form', () => {
    expect(parseScriptReferences('npm dev')).toEqual([]);
  });

  it('splits compound command lines', () => {
    expect(parseScriptReferences('npm run lint && npm run build || npm test').map((r) => r.script)).toEqual([
      'lint',
      'build',
      'test',
    ]);
  });

  it('skips ordinary flags and their values', () => {
    expect(parseScriptReferences('npm run --silent test')[0]).toMatchObject({ script: 'test' });
    expect(parseScriptReferences('pnpm run build --if-present')[0]).toMatchObject({
      script: 'build',
    });
  });

  it('drops references aimed at another workspace instead of guessing', () => {
    // The script belongs to a different manifest, so resolving it against this
    // package.json would produce a confident, blocking, wrong finding.
    for (const command of [
      'npm --prefix ./sub run build',
      'npm -C ./sub run build',
      'npm run build --workspace=api',
      'npm run build -w api',
      'pnpm --filter web run build',
      'pnpm --filter ./packages/* run build',
      'pnpm -F web build',
      'pnpm -C packages/api run build',
      'pnpm -r build',
      'pnpm --recursive run build',
      'yarn workspace api build',
    ]) {
      expect(parseScriptReferences(command), command).toEqual([]);
    }
  });

  it('ignores placeholders and non-package-manager commands', () => {
    expect(parseScriptReferences('pnpm <your-script>')).toEqual([]);
    expect(parseScriptReferences('npm run ${SCRIPT}')).toEqual([]);
    expect(parseScriptReferences('node dist/index.js')).toEqual([]);
    expect(parseScriptReferences('npx tsx src/main.ts')).toEqual([]);
    expect(parseScriptReferences('docker compose up')).toEqual([]);
  });

  it('ignores leading environment assignments and sudo', () => {
    expect(parseScriptReferences('NODE_ENV=production npm run build')[0]).toMatchObject({
      script: 'build',
    });
  });
});

describe('extractDocumentedCommands', () => {
  it('reads shell fences and inline code, and skips non-shell fences', () => {
    const markdown = [
      '# Title',
      '',
      '```bash',
      'pnpm install',
      'pnpm dev',
      '```',
      '',
      'Run `npm run build` before shipping.',
      '',
      '```json',
      '{ "scripts": { "npm run fake": "x" } }',
      '```',
      '',
      '```',
      'npm test',
      '```',
    ].join('\n');

    expect(extractDocumentedCommands(markdown)).toEqual([
      { line: 4, command: 'pnpm install', source: 'code-block' },
      { line: 5, command: 'pnpm dev', source: 'code-block' },
      { line: 8, command: 'npm run build', source: 'inline-code' },
      { line: 15, command: 'npm test', source: 'code-block' },
    ]);
  });

  it('strips shell prompts and comment lines', () => {
    const markdown = ['```sh', '# install first', '$ pnpm install', '> pnpm build', '```'].join('\n');
    expect(extractDocumentedCommands(markdown).map((c) => c.command)).toEqual([
      'pnpm install',
      'pnpm build',
    ]);
  });

  it('ignores inline code that is not a package-manager command', () => {
    expect(extractDocumentedCommands('See `src/index.ts` and `PORT`.')).toEqual([]);
  });

  it('handles tilde fences and longer backtick runs', () => {
    const markdown = ['~~~bash', 'pnpm dev', '~~~', '````sh', 'npm test', '````'].join('\n');
    expect(extractDocumentedCommands(markdown).map((c) => c.command)).toEqual(['pnpm dev', 'npm test']);
  });
});

describe('node version requirements', () => {
  it('normalises specifiers into ranges', () => {
    expect(toRange('20').range).toBe('>=20.0.0 <21.0.0-0');
    expect(toRange('v18.20.4').range).toBe('18.20.4');
    expect(toRange('>=20').range).toBe('>=20.0.0');
  });

  it('reports aliases it cannot resolve offline', () => {
    expect(toRange('lts/iron').unresolvedReason).toMatch(/cannot be resolved/);
    expect(toRange('system').unresolvedReason).toMatch(/cannot be resolved/);
    expect(toRange('not-a-version').unresolvedReason).toMatch(/not a valid semver range/);
  });

  it('detects declarations that cannot be satisfied together', () => {
    const conflicts = findConflicts([
      buildRequirement('package.json#engines.node', 'package.json', '>=22'),
      buildRequirement('.nvmrc', '.nvmrc', '18.20.4'),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.a.raw).toBe('>=22');
    expect(conflicts[0]?.b.raw).toBe('18.20.4');
  });

  it('accepts declarations that overlap', () => {
    expect(
      findConflicts([
        buildRequirement('package.json#engines.node', 'package.json', '>=18'),
        buildRequirement('.nvmrc', '.nvmrc', '20'),
      ]),
    ).toEqual([]);
  });

  it('lists the requirements a given runtime fails', () => {
    const requirements = [
      buildRequirement('package.json#engines.node', 'package.json', '>=22'),
      buildRequirement('.nvmrc', '.nvmrc', '20'),
    ];

    expect(unsatisfied('20.11.0', requirements).map((r) => r.raw)).toEqual(['>=22']);
    expect(unsatisfied('22.1.0', requirements).map((r) => r.raw)).toEqual(['20']);
  });
});

describe('readPackageManagerField', () => {
  it('splits name and version and drops the corepack hash', () => {
    expect(readPackageManagerField({ packageManager: 'pnpm@9.12.0' })).toEqual({
      name: 'pnpm',
      version: '9.12.0',
    });
    expect(readPackageManagerField({ packageManager: 'yarn@4.1.0+sha224.abc' })).toEqual({
      name: 'yarn',
      version: '4.1.0',
    });
  });

  it('returns undefined for missing or malformed values', () => {
    expect(readPackageManagerField({})).toBeUndefined();
    expect(readPackageManagerField({ packageManager: '' })).toBeUndefined();
    expect(readPackageManagerField({ packageManager: 42 })).toBeUndefined();
  });
});
