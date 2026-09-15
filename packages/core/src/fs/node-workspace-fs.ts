import { promises as fs, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_IGNORED_DIRS,
  FileTooLargeError,
  WorkspaceBoundaryError,
  type WalkOptions,
  type WalkResult,
  type WorkspaceFs,
} from './workspace-fs.js';

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 5000;
const READ_CHUNK_BYTES = 64 * 1024;

export interface NodeWorkspaceFsOptions {
  /** Refuse to read files larger than this. Default 2 MiB. */
  readonly maxFileBytes?: number;
}

/**
 * {@link WorkspaceFs} backed by the real filesystem, confined to `root`.
 *
 * Confinement is enforced twice, and both are necessary:
 *
 * 1. **Lexically**, by {@link NodeWorkspaceFs.resolve}, which rejects absolute
 *    paths and `..` traversal.
 * 2. **Physically**, by resolving symlinks with `realpath` and checking the
 *    target is still under the real root, before any read.
 *
 * Only the second stops a symlink. A repository can commit `package.json` as a
 * link to `/etc/passwd`; `fs.stat` and `fs.readFile` follow it happily, and
 * without this check the contents of that file end up quoted in the report.
 * Repository content is untrusted input, and a symlink is content.
 *
 * **Out of scope:** a workspace being rewritten *while* it is analysed. There
 * is a window between `realpath` and `open` in which the path could be swapped
 * for a symlink, and hard links are not detectable at all. Both need local
 * write access to the directory, which already grants direct read access, so
 * neither is defended against — see the threat model in
 * `Notes/09-seguranca-e-confiabilidade.md`. The size cap is the one guarantee
 * that does hold under concurrent mutation.
 */
export class NodeWorkspaceFs implements WorkspaceFs {
  readonly root: string;
  readonly #maxFileBytes: number;
  #realRoot: Promise<string> | undefined;

  constructor(root: string, options: NodeWorkspaceFsOptions = {}) {
    this.root = path.resolve(root);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * Lexical guard: resolve a workspace-relative path to an absolute one,
   * refusing anything that leaves the root on paper.
   *
   * This does **not** resolve symlinks — use {@link NodeWorkspaceFs.realPath}
   * for that. It is exposed separately because it is cheap and synchronous.
   */
  resolve(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    const absolute = path.resolve(this.root, relativePath);
    if (!isInside(this.root, absolute)) {
      throw new WorkspaceBoundaryError(relativePath);
    }
    return absolute;
  }

  /**
   * Physical guard: the fully symlink-resolved path, or `null` when it does not
   * exist, is a broken link, or points outside the workspace.
   */
  async realPath(relativePath: string): Promise<string | null> {
    let absolute: string;
    try {
      absolute = this.resolve(relativePath);
    } catch {
      return null;
    }

    const realRoot = await this.#resolveRoot();
    if (realRoot === null) return null;

    try {
      const real = await fs.realpath(absolute);
      return isInside(realRoot, real) ? real : null;
    } catch {
      // Missing file, broken symlink, or a symlink loop.
      return null;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    return (await this.realPath(relativePath)) !== null;
  }

  async isFile(relativePath: string): Promise<boolean> {
    const real = await this.realPath(relativePath);
    if (real === null) return false;
    try {
      return (await fs.stat(real)).isFile();
    } catch {
      return false;
    }
  }

  async readText(relativePath: string): Promise<string> {
    const real = await this.realPath(relativePath);
    if (real === null) {
      // Either the path is gone, or it resolves outside the workspace. Both are
      // refusals; distinguishing them would leak whether an external path exists.
      throw new WorkspaceBoundaryError(relativePath);
    }

    const handle = await fs.open(real, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new Error(`Not a regular file: ${relativePath}`);
      }
      // `stat` gives an accurate size for the usual error, but it is only
      // advisory: `readFile` reads to EOF, so a file that grows after the stat
      // would still be read in full. The chunked read below is what actually
      // enforces the cap, by refusing as soon as one byte too many arrives.
      if (stats.size > this.#maxFileBytes) {
        throw new FileTooLargeError(relativePath, stats.size, this.#maxFileBytes);
      }
      return await this.#readCapped(handle, relativePath);
    } finally {
      await handle.close();
    }
  }

  /**
   * Read at most `maxFileBytes` bytes, rejecting as soon as the file proves
   * larger.
   *
   * The final read is narrowed to `remaining + 1` rather than a whole chunk, so
   * the reader never pulls more than one byte past the limit. That one byte is
   * the cheapest possible proof of overflow; asking for a full chunk instead
   * would make the promise "at most maxFileBytes" untrue by up to 64 KiB.
   */
  async #readCapped(handle: FileHandle, relativePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
      const remaining = this.#maxFileBytes - total;
      const bytesToRead = Math.min(READ_CHUNK_BYTES, remaining + 1);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, null);
      if (bytesRead === 0) break;

      total += bytesRead;
      if (total > this.#maxFileBytes) {
        throw new FileTooLargeError(relativePath, total, this.#maxFileBytes);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }

    // Decoded once at the end, so a multi-byte character split across two
    // chunks is still decoded correctly.
    return Buffer.concat(chunks).toString('utf8');
  }

  async listDir(relativePath: string): Promise<string[]> {
    const real = await this.realPath(relativePath);
    if (real === null) return [];
    try {
      return await fs.readdir(real);
    } catch {
      return [];
    }
  }

  async walk(options: WalkOptions = {}): Promise<WalkResult> {
    const startDir = options.dir ?? '.';
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoreDirs ?? [])]);
    const extensions = options.extensions;
    const names = options.names;

    const files: string[] = [];
    let truncated = false;
    let depthLimited = false;

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (depth > maxDepth) {
        depthLimited = true;
        return;
      }

      const real = await this.realPath(dir);
      if (real === null) return;

      let entries: Dirent[];
      try {
        entries = await fs.readdir(real, { withFileTypes: true });
      } catch {
        return;
      }

      // `fs.readdir` makes no ordering promise: it reflects the filesystem's
      // own layout, which differs between ext4, APFS, NTFS and network mounts.
      // Sorting here is what makes two runs of the same repository produce the
      // same report — and, when `maxFiles` cuts the walk short, what makes the
      // surviving subset the same everywhere. Compared by code unit rather than
      // `localeCompare`, so the locale cannot change the result either.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const entry of entries) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        const childRelative = dir === '.' ? entry.name : `${dir}/${entry.name}`;

        if (entry.isDirectory()) {
          if (ignored.has(entry.name)) continue;
          await visit(childRelative, depth + 1);
          continue;
        }
        // Symlinks are neither isFile() nor isDirectory() here, so they are
        // skipped: following one could walk outside the workspace, and a
        // symlinked manifest is not something to analyse as project content.
        if (!entry.isFile()) continue;
        if (names && !names.includes(entry.name)) continue;
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
        files.push(childRelative);
      }
    };

    await visit(normalizeDir(startDir), 0);
    return { files, truncated, depthLimited };
  }

  async #resolveRoot(): Promise<string | null> {
    this.#realRoot ??= fs.realpath(this.root);
    try {
      return await this.#realRoot;
    } catch {
      return null;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
}
