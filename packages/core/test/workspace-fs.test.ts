import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { FileTooLargeError, NodeWorkspaceFs, WorkspaceBoundaryError } from '@setupguard/core';
import { fixture } from '@setupguard/testing';

describe('NodeWorkspaceFs', () => {
  const workspace = new NodeWorkspaceFs(fixture('healthy-npm'));

  it('reads files inside the workspace', async () => {
    await expect(workspace.isFile('package.json')).resolves.toBe(true);
    await expect(workspace.readText('package.json')).resolves.toContain('"healthy-npm"');
  });

  it('reports missing files without throwing', async () => {
    await expect(workspace.exists('nope.json')).resolves.toBe(false);
    await expect(workspace.isFile('src')).resolves.toBe(false);
    await expect(workspace.listDir('nope')).resolves.toEqual([]);
  });

  it('refuses paths that escape the root', () => {
    expect(() => workspace.resolve('../healthy-pnpm/package.json')).toThrow(WorkspaceBoundaryError);
    expect(() => workspace.resolve('src/../../secret')).toThrow(WorkspaceBoundaryError);
    expect(() => workspace.resolve('/etc/passwd')).toThrow(WorkspaceBoundaryError);
  });

  it('allows traversal that stays inside the root', () => {
    expect(workspace.resolve('src/../package.json')).toBe(
      path.join(fixture('healthy-npm'), 'package.json'),
    );
  });

  it('walks files and filters by extension', async () => {
    const walked = await workspace.walk({ extensions: ['.js'] });
    expect(walked.files).toEqual(['src/index.js']);
    expect(walked.truncated).toBe(false);
  });

  it('walks files by exact basename', async () => {
    const monorepo = new NodeWorkspaceFs(fixture('monorepo-root'));
    const walked = await monorepo.walk({ names: ['package.json'] });
    expect(walked.files).toEqual(['package.json', 'packages/api/package.json']);
  });

  it('returns entries in a deterministic order, whatever the filesystem does', async () => {
    const root = path.join(os.tmpdir(), `setupguard-order-${process.pid}`);
    await fs.mkdir(path.join(root, 'zz'), { recursive: true });
    await fs.mkdir(path.join(root, 'aa'), { recursive: true });
    try {
      // Written in deliberately non-alphabetical order. `fs.readdir` promises
      // no ordering: on APFS, NTFS or a network mount it can differ from ext4,
      // which would make the report itself differ between machines.
      for (const name of ['m.js', 'z.js', 'a.js', 'k.js', 'b.js']) {
        await fs.writeFile(path.join(root, name), '');
      }
      await fs.writeFile(path.join(root, 'zz', 'inner.js'), '');
      await fs.writeFile(path.join(root, 'aa', 'inner.js'), '');

      const walked = await new NodeWorkspaceFs(root).walk({ extensions: ['.js'] });
      expect(walked.files).toEqual([...walked.files].sort());
      expect(walked.files).toEqual([
        'a.js',
        'aa/inner.js',
        'b.js',
        'k.js',
        'm.js',
        'z.js',
        'zz/inner.js',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('truncates to the same subset everywhere', async () => {
    const root = path.join(os.tmpdir(), `setupguard-trunc-${process.pid}`);
    await fs.mkdir(root, { recursive: true });
    try {
      for (const name of ['m.js', 'z.js', 'a.js', 'k.js', 'b.js']) {
        await fs.writeFile(path.join(root, name), '');
      }
      // Which files survive a truncated walk must not depend on the filesystem
      // either, or an inference drawn from them would vary by machine.
      const walked = await new NodeWorkspaceFs(root).walk({ extensions: ['.js'], maxFiles: 3 });
      expect(walked.files).toEqual(['a.js', 'b.js', 'k.js']);
      expect(walked.truncated).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('caps the number of returned files and says the walk was truncated', async () => {
    const walked = await workspace.walk({ maxFiles: 2 });
    expect(walked.files).toHaveLength(2);
    // Without this flag a partial scan would be indistinguishable from a
    // complete one, and any inference over it would be a silent false result.
    expect(walked.truncated).toBe(true);
  });

  describe('with generated directories', () => {
    const root = path.join(os.tmpdir(), `setupguard-fs-${process.pid}`);

    afterAll(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('never walks into node_modules or dist', async () => {
      await fs.mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
      await fs.mkdir(path.join(root, 'dist'), { recursive: true });
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), '');
      await fs.writeFile(path.join(root, 'dist', 'bundle.js'), '');
      await fs.writeFile(path.join(root, 'src', 'app.js'), '');

      const walker = new NodeWorkspaceFs(root);
      const walked = await walker.walk({ extensions: ['.js'] });
      expect(walked.files).toEqual(['src/app.js']);
    });

    // Creating a symlink on Windows requires Developer Mode or elevation, so
    // these run where they can and are skipped where they cannot. The guard
    // itself is platform-independent: it compares realpath against the root.
    const symlinks = process.platform === 'win32' ? it.skip : it;

    symlinks('refuses a file symlinked to a target outside the workspace', async () => {
      const outside = path.join(root, 'outside');
      const inside = path.join(root, 'inside');
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(inside, { recursive: true });
      await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE-THE-ROOT');
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(inside, 'package.json'));

      const workspace = new NodeWorkspaceFs(inside);

      // The lexical guard alone cannot see this: the path never contains `..`.
      expect(() => workspace.resolve('package.json')).not.toThrow();

      await expect(workspace.exists('package.json')).resolves.toBe(false);
      await expect(workspace.isFile('package.json')).resolves.toBe(false);
      await expect(workspace.readText('package.json')).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    });

    symlinks('refuses a directory symlinked outside the workspace', async () => {
      const outside = path.join(root, 'outside-dir');
      const inside = path.join(root, 'inside-dir');
      await fs.mkdir(path.join(outside, 'nested'), { recursive: true });
      await fs.mkdir(inside, { recursive: true });
      await fs.writeFile(path.join(outside, 'nested', 'leak.txt'), 'SECRET');
      await fs.symlink(outside, path.join(inside, 'link'), 'dir');

      const workspace = new NodeWorkspaceFs(inside);

      await expect(workspace.exists('link/nested/leak.txt')).resolves.toBe(false);
      await expect(workspace.listDir('link')).resolves.toEqual([]);
      await expect(workspace.readText('link/nested/leak.txt')).rejects.toBeInstanceOf(
        WorkspaceBoundaryError,
      );
      // The walker never descends into a symlinked directory either.
      const walked = await workspace.walk();
      expect(walked.files).toEqual([]);
    });

    symlinks('refuses a chain of symlinks that ends outside the workspace', async () => {
      const outside = path.join(root, 'chain-outside');
      const inside = path.join(root, 'chain-inside');
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(inside, { recursive: true });
      await fs.writeFile(path.join(outside, 'target.txt'), 'SECRET');
      await fs.symlink(path.join(outside, 'target.txt'), path.join(outside, 'hop.txt'));
      await fs.symlink(path.join(outside, 'hop.txt'), path.join(inside, 'package.json'));

      const workspace = new NodeWorkspaceFs(inside);
      await expect(workspace.isFile('package.json')).resolves.toBe(false);
      await expect(workspace.readText('package.json')).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    });

    symlinks('treats a broken symlink as absent', async () => {
      const inside = path.join(root, 'broken');
      await fs.mkdir(inside, { recursive: true });
      await fs.symlink(path.join(inside, 'nowhere.json'), path.join(inside, 'package.json'));

      const workspace = new NodeWorkspaceFs(inside);
      await expect(workspace.exists('package.json')).resolves.toBe(false);
      await expect(workspace.isFile('package.json')).resolves.toBe(false);
    });

    symlinks('still allows a symlink that stays inside the workspace', async () => {
      const inside = path.join(root, 'internal-link');
      await fs.mkdir(path.join(inside, 'real'), { recursive: true });
      await fs.writeFile(path.join(inside, 'real', 'manifest.json'), '{"name":"ok"}');
      await fs.symlink(path.join(inside, 'real', 'manifest.json'), path.join(inside, 'package.json'));

      const workspace = new NodeWorkspaceFs(inside);
      await expect(workspace.isFile('package.json')).resolves.toBe(true);
      await expect(workspace.readText('package.json')).resolves.toBe('{"name":"ok"}');
    });

    it('reads exactly up to the limit, and refuses one byte past it', async () => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'at-limit.txt'), 'x'.repeat(1024));
      await fs.writeFile(path.join(root, 'over-limit.txt'), 'x'.repeat(1025));

      const limited = new NodeWorkspaceFs(root, { maxFileBytes: 1024 });
      // The cap is enforced by the read itself, not only by the stat that
      // precedes it, so the boundary has to be exact in both directions.
      await expect(limited.readText('at-limit.txt')).resolves.toHaveLength(1024);
      await expect(limited.readText('over-limit.txt')).rejects.toBeInstanceOf(FileTooLargeError);
    });

    it('reassembles a file larger than one read chunk, multi-byte characters included', async () => {
      await fs.mkdir(root, { recursive: true });
      // Long enough to span several 64 KiB reads. The character is three bytes
      // in UTF-8 and the chunk size is 65536, which 3 does not divide, so one
      // character is guaranteed to straddle a boundary — a two-byte character
      // would divide evenly and never exercise the split.
      const content = '\u20ac'.repeat(60_000);
      await fs.writeFile(path.join(root, 'big-utf8.txt'), content);

      const reader = new NodeWorkspaceFs(root, { maxFileBytes: 4 * 1024 * 1024 });
      await expect(reader.readText('big-utf8.txt')).resolves.toBe(content);
    });

    it('refuses to read files above the size limit', async () => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(2048));

      const limited = new NodeWorkspaceFs(root, { maxFileBytes: 1024 });
      await expect(limited.readText('big.txt')).rejects.toBeInstanceOf(FileTooLargeError);
    });
  });
});
