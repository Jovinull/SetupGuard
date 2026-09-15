import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAME,
  NodeWorkspaceFs,
  configJsonSchema,
  loadConfig,
  matchesIgnore,
  normalizeIgnorePattern,
} from '@setupguard/core';

/**
 * Ignore patterns decide what a scanner does not look at, so a pattern that
 * means something other than it says is a way to blind the tool. Every case
 * that could point outside the workspace is here.
 */

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('normalizeIgnorePattern', () => {
  it('accepts and normalises relative patterns', () => {
    expect(normalizeIgnorePattern('examples').pattern).toBe('examples');
    expect(normalizeIgnorePattern('./docs/generated/**').pattern).toBe('docs/generated/**');
    expect(normalizeIgnorePattern('docs//generated').pattern).toBe('docs/generated');
    expect(normalizeIgnorePattern('  spaced  ').pattern).toBe('spaced');
  });

  it('normalises Windows separators to one form', () => {
    // Walk output is always POSIX, so a pattern written on Windows has to be
    // folded into the same shape or it would silently never match.
    expect(normalizeIgnorePattern('docs\\generated\\**').pattern).toBe('docs/generated/**');
    expect(normalizeIgnorePattern('examples\\demo.js').pattern).toBe('examples/demo.js');
  });

  it('rejects anything that could leave the workspace', () => {
    expect(normalizeIgnorePattern('../outside').error).toBe('traversal');
    expect(normalizeIgnorePattern('docs/../../outside').error).toBe('traversal');
    expect(normalizeIgnorePattern('..').error).toBe('traversal');
    expect(normalizeIgnorePattern('/etc/passwd').error).toBe('absolute');
    expect(normalizeIgnorePattern('C:\\Windows\\System32').error).toBe('absolute');
    expect(normalizeIgnorePattern('C:/Windows').error).toBe('absolute');
  });

  it('rejects syntax this dialect does not implement', () => {
    expect(normalizeIgnorePattern('!keep-me').error).toBe('negation');
    expect(normalizeIgnorePattern('src/{a,b}').error).toBe('unsupported-syntax');
    expect(normalizeIgnorePattern('src/[ab].js').error).toBe('unsupported-syntax');
    expect(normalizeIgnorePattern('').error).toBe('empty');
    expect(normalizeIgnorePattern('   ').error).toBe('empty');
    expect(normalizeIgnorePattern('./').error).toBe('empty');
  });
});

describe('matchesIgnore', () => {
  const cases: readonly [string, string, boolean][] = [
    ['examples', 'examples/demo.js', true],
    ['examples', 'examples', true],
    ['examples', 'examples-other/demo.js', false],
    ['examples', 'src/examples/demo.js', false],
    ['examples/demo.js', 'examples/demo.js', true],
    ['examples/demo.js', 'examples/other.js', false],
    ['examples/**', 'examples/a/b/c.js', true],
    ['examples/**', 'examples', true],
    ['docs/*.md', 'docs/a.md', true],
    ['docs/*.md', 'docs/nested/a.md', false],
    ['docs/**/*.md', 'docs/a.md', true],
    ['docs/**/*.md', 'docs/x/y/a.md', true],
    ['docs/**/*.md', 'docs/a.txt', false],
    ['**/*.spec.ts', 'a.spec.ts', true],
    ['**/*.spec.ts', 'src/deep/a.spec.ts', true],
    ['**', 'anything/at/all.js', true],
    ['build?', 'build1', true],
    ['build?', 'build12', false],
    ['build?', 'build/1', false],
  ];

  for (const [pattern, candidate, expected] of cases) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${candidate}`, () => {
      expect(matchesIgnore(candidate, [pattern])).toBe(expected);
    });
  }

  it('folds Windows separators in the candidate too', () => {
    expect(matchesIgnore('examples\\demo.js', ['examples/**'])).toBe(true);
  });

  it('matches nothing when there are no patterns', () => {
    expect(matchesIgnore('anything', [])).toBe(false);
  });
});

describe('ignore in a real workspace', () => {
  async function workspace(files: Record<string, string>): Promise<NodeWorkspaceFs> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-ign-'));
    created.push(root);
    for (const [name, body] of Object.entries(files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    }
    return new NodeWorkspaceFs(root);
  }

  it('excludes a single file', async () => {
    const wfs = await workspace({ 'a.js': '', 'b.js': '' });
    const walked = await wfs.walk({ extensions: ['.js'], ignore: ['b.js'] });
    expect(walked.files).toEqual(['a.js']);
  });

  it('excludes a whole directory without descending into it', async () => {
    const wfs = await workspace({ 'src/a.js': '', 'examples/b.js': '', 'examples/deep/c.js': '' });
    const walked = await wfs.walk({ extensions: ['.js'], ignore: ['examples'] });
    expect(walked.files).toEqual(['src/a.js']);
  });

  it('excludes by glob', async () => {
    const wfs = await workspace({ 'docs/a.md': '', 'docs/generated/b.md': '', 'docs/generated/c.md': '' });
    const walked = await wfs.walk({ extensions: ['.md'], ignore: ['docs/generated/**'] });
    expect(walked.files).toEqual(['docs/a.md']);
  });

  it('cannot reach outside the workspace even through a symlink', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-out-'));
    created.push(outside);
    await fs.writeFile(path.join(outside, 'secret.js'), '');

    const wfs = await workspace({ 'src/a.js': '' });
    const link = path.join(wfs.root, 'linked');
    if (process.platform !== 'win32') await fs.symlink(outside, link, 'dir');

    // Two independent guarantees: the walker never follows a symlinked
    // directory, and an ignore pattern cannot widen what it can see.
    const walked = await wfs.walk({ extensions: ['.js'], ignore: [] });
    expect(walked.files).toEqual(['src/a.js']);
  });

  it('never lets configuration hide a structural file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-struct-'));
    created.push(root);
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}');
    await fs.writeFile(
      path.join(root, CONFIG_FILE_NAME),
      'version: 1\nignore:\n  - package.json\n  - "**"\n',
    );

    const wfs = new NodeWorkspaceFs(root);
    const config = await loadConfig({ fs: wfs, knownCheckIds: [] });
    expect(config.valid).toBe(true);

    // `ignore` narrows the auxiliary scans only. Structural files are read by
    // name, never through `walk`, so no pattern can make the project look as if
    // it does not exist.
    expect(await wfs.isFile('package.json')).toBe(true);
    await expect(wfs.readText('package.json')).resolves.toContain('"x"');
  });
});

describe('JSON Schema stays in sync with the TypeScript source of truth', () => {
  it('matches schemas/setupguard.schema.json byte for byte', async () => {
    const file = path.resolve(process.cwd(), 'schemas/setupguard.schema.json');
    const onDisk = await fs.readFile(file, 'utf8');

    // The schema is generated, never hand-edited. If this fails, run
    // `pnpm run schema`; if the change was not intended, revert the constants.
    expect(onDisk).toBe(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  });
});
