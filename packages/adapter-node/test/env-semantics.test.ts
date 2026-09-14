import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { maskComments, nodeAdapter } from '@setupguard/adapter-node';
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
