import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  destructuredNames,
  isAmbientEnvVar,
  maskComments,
  nodeAdapter,
} from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeWorkspaceFs,
  allFindings,
  runDiagnosis,
  type Report,
} from '@setupguard/core';
import { stubEnvironment } from '@setupguard/testing';

const created: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-env-'));
  created.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function diagnose(root: string, envVars: readonly string[] = []): Promise<Report> {
  return runDiagnosis({
    fs: new NodeWorkspaceFs(root),
    environment: stubEnvironment({ envVars }),
    registry: new AdapterRegistry([nodeAdapter]),
  });
}

function codes(report: Report): string[] {
  return allFindings(report).map((finding) => finding.code);
}

const BASE = {
  'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { s: 'node .' } }),
  'package-lock.json': '{"lockfileVersion":3}',
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('empty values', () => {
  it('treats a declared-but-empty variable as not provided', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': 'DATABASE_URL=',
      '.env': 'DATABASE_URL=',
      'src/db.js': 'export const url = process.env.DATABASE_URL;',
    });

    const report = await diagnose(root);

    // `DATABASE_URL=` in a .env is an unfilled placeholder. Counting the key as
    // present made this project READY while it could not connect to anything.
    expect(codes(report)).toContain('node/env-var-empty');
    expect(report.readiness).toBe('BLOCKED');
  });

  it('accepts a variable that actually has a value', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': 'DATABASE_URL=',
      '.env': 'DATABASE_URL=postgres://localhost/app',
      'src/db.js': 'export const url = process.env.DATABASE_URL;',
    });

    expect(codes(await diagnose(root))).toEqual([]);
  });
});

describe('variables provided outside the dotenv files', () => {
  it('accepts a variable exported in the process environment', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': 'API_URL=',
      '.env': '',
      'src/api.js': 'export const url = process.env.API_URL;',
    });

    // direnv, a shell profile or a CI secret provides configuration without a
    // .env file. Reporting it missing is a false positive.
    expect(codes(await diagnose(root, ['API_URL']))).toEqual([]);
    expect(codes(await diagnose(root))).toContain('node/env-var-missing');
  });

  it('accepts a variable exported when no local file exists at all', async () => {
    const root = await workspace({ ...BASE, '.env.example': 'API_URL=' });

    expect(codes(await diagnose(root, ['API_URL']))).toEqual([]);
    expect(codes(await diagnose(root))).toContain('node/env-file-missing');
  });

  it('merges layered environment files instead of reading only the first', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': 'A=\nB=',
      '.env': 'A=one',
      '.env.local': 'B=two',
      'src/app.js': 'export const a = process.env.A; export const b = process.env.B;',
    });

    // Reading only `.env` reported B as missing even though `.env.local`
    // provides it, which is exactly how dotenv layering works.
    expect(codes(await diagnose(root))).toEqual([]);
  });
});

describe('source inference', () => {
  it('ignores process.env inside a comment', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': 'REAL=',
      '.env': 'REAL=value',
      'src/app.js': [
        '// process.env.GHOST_LINE_COMMENT',
        '/* process.env.GHOST_BLOCK_COMMENT */',
        'export const real = process.env.REAL;',
      ].join('\n'),
    });

    const report = await diagnose(root);

    expect(codes(report)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('GHOST_LINE_COMMENT');
    expect(JSON.stringify(report)).not.toContain('GHOST_BLOCK_COMMENT');
  });

  it('still sees the bracket form, whose name lives inside a string', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': '',
      'src/app.js': "export const x = process.env['BRACKET_VAR'];",
    });

    expect(codes(await diagnose(root))).toContain('node/env-var-undocumented');
  });
});

describe('destructured reads', () => {
  it('detects names bound by destructuring process.env', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': '',
      'src/a.js': 'const { DESTRUCTURED_ONE, RENAMED: alias } = process.env;\nexport default alias;\n',
    });

    // The single most common way to read configuration, and previously invisible
    // to the scanner: the check passed clean while nothing was documented.
    const found = codes(await diagnose(root));
    expect(found.filter((c) => c === 'node/env-var-undocumented')).toHaveLength(2);
  });

  it('detects a destructuring spread over several lines', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': '',
      'src/a.js': ['const {', '  MULTILINE_A,', '  MULTILINE_B = "x",', '} = process.env;'].join('\n'),
    });

    expect(codes(await diagnose(root)).filter((c) => c === 'node/env-var-undocumented')).toHaveLength(
      2,
    );
  });

  it('does not fire on destructuring of an unrelated object', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': '',
      'src/a.js': 'const { NOT_AN_ENV_VAR } = someConfigObject;\nexport default NOT_AN_ENV_VAR;\n',
    });

    expect(codes(await diagnose(root))).toEqual([]);
  });

  it('keeps the binding parser conservative', () => {
    expect(destructuredNames('A, B: alias, C = "x"')).toEqual(['A', 'B', 'C']);
    // Rest elements, nested patterns and computed keys are skipped, not guessed.
    expect(destructuredNames('...rest')).toEqual([]);
    expect(destructuredNames('[computed]: x')).toEqual([]);
  });
});

describe('ambient variables', () => {
  it('never asks the project to document what the platform provides', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': '',
      'src/a.js': [
        'export const mode = import.meta.env.MODE;',
        'export const dev = import.meta.env.DEV;',
        'export const version = process.env.npm_package_version;',
        'export const cfg = process.env.npm_config_registry;',
        'export const nodeEnv = process.env.NODE_ENV;',
      ].join('\n'),
    });

    expect(codes(await diagnose(root))).toEqual([]);
  });

  it('still asks for a project variable read through import.meta.env', async () => {
    const root = await workspace({
      ...BASE,
      '.env.example': '',
      'src/a.js': 'export const url = import.meta.env.VITE_API_URL;\n',
    });

    expect(codes(await diagnose(root))).toContain('node/env-var-undocumented');
  });

  it('treats ambience as a property of the access form, not the name', () => {
    // MODE is a Vite builtin only through import.meta.env. Read from
    // process.env it is an ordinary variable the project has to declare.
    expect(isAmbientEnvVar('MODE', 'import.meta.env')).toBe(true);
    expect(isAmbientEnvVar('MODE', 'process.env')).toBe(false);
    expect(isAmbientEnvVar('npm_package_version', 'process.env')).toBe(true);
    expect(isAmbientEnvVar('VITE_API_URL', 'import.meta.env')).toBe(false);
  });
});

describe('maskComments', () => {
  it('blanks comments while preserving offsets', () => {
    const masked = maskComments('a // b\nc');
    expect(masked).toHaveLength('a // b\nc'.length);
    expect(masked.split('\n')[0]?.trimEnd()).toBe('a');
    expect(masked.split('\n')[1]).toBe('c');
  });

  it('does not mistake a URL inside a string for a comment', () => {
    expect(maskComments('const u = "http://example.com/x"; const y = 1;')).toBe(
      'const u = "http://example.com/x"; const y = 1;',
    );
  });

  it('keeps string contents, which carry bracket-access variable names', () => {
    expect(maskComments("process.env['NAME'] // gone")).toContain("process.env['NAME']");
  });

  it('handles escapes and unterminated quotes without swallowing the file', () => {
    expect(maskComments('const a = "he said \\"hi\\""; // x\nconst b = 2;')).toContain(
      'const b = 2;',
    );
    expect(maskComments("const a = 'oops;\nconst b = 2;")).toContain('const b = 2;');
  });
});
