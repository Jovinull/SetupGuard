import path from 'node:path';

import {
  DEFAULT_IGNORED_DIRS,
  FileTooLargeError,
  matchesIgnore,
  WorkspaceBoundaryError,
  type WalkOptions,
  type WalkResult,
  type WorkspaceFs,
} from '@setupguard/core';

import type { BaseEntry } from './pull-request.js';

/**
 * The workspace as it was on the base commit, without checking it out.
 *
 * The runner has the pull request checked out. A path the pull request did not
 * touch is byte-identical on the base, so it is read from disk. A path it did
 * touch is looked up on the base commit through the API — lazily, only when
 * the engine actually asks for it. A pull request that changes 400 images and
 * one README costs one request, not 401.
 *
 * Every method mirrors what `NodeWorkspaceFs` would answer for a real checkout
 * of the base, including the order `walk` returns files in. Where that cannot
 * be reproduced faithfully — a path that is a symlink on the base, read
 * directly — it throws instead of guessing, and records why in
 * {@link BaseWorkspaceFs.problems}. A comparison built on a guess would be a
 * comparison nobody can trust.
 */
export class BaseWorkspaceFs implements WorkspaceFs {
  readonly root: string;
  /** Reasons this view had to refuse a question. Non-empty means "do not trust the base report". */
  readonly problems: string[] = [];

  readonly #head: WorkspaceFs;
  readonly #changed: ReadonlySet<string>;
  readonly #load: (relativePath: string) => Promise<BaseEntry>;
  readonly #maxFileBytes: number;
  readonly #entries = new Map<string, Promise<BaseEntry>>();

  constructor(options: {
    readonly head: WorkspaceFs;
    /** Workspace-relative POSIX paths the pull request touched (both sides of a rename). */
    readonly changed: Iterable<string>;
    readonly load: (relativePath: string) => Promise<BaseEntry>;
    readonly maxFileBytes: number;
  }) {
    this.root = options.head.root;
    this.#head = options.head;
    this.#changed = new Set(options.changed);
    this.#load = options.load;
    this.#maxFileBytes = options.maxFileBytes;
  }

  async exists(relativePath: string): Promise<boolean> {
    const p = normalize(relativePath);
    if (p === null) return this.#head.exists(relativePath);
    if (this.#changed.has(p)) {
      const entry = await this.#entry(p);
      if (entry.kind === 'symlink') throw this.#refuse(p, 'is a symlink on the base commit');
      return entry.kind !== 'absent';
    }
    if (this.#hasChangedBelow(p)) return this.#baseHasFileBelow(p);
    return this.#head.exists(p);
  }

  async isFile(relativePath: string): Promise<boolean> {
    const p = normalize(relativePath);
    if (p === null || !this.#changed.has(p)) return this.#head.isFile(p ?? relativePath);
    const entry = await this.#entry(p);
    switch (entry.kind) {
      case 'file':
      case 'too-large':
        return true;
      case 'symlink':
        throw this.#refuse(p, 'is a symlink on the base commit');
      default:
        return false;
    }
  }

  async readText(relativePath: string): Promise<string> {
    const p = normalize(relativePath);
    if (p === null || !this.#changed.has(p)) return this.#head.readText(p ?? relativePath);
    const entry = await this.#entry(p);
    switch (entry.kind) {
      case 'file':
        // Same cap as the disk reader, measured the same way (bytes).
        if (Buffer.byteLength(entry.text, 'utf8') > this.#maxFileBytes) {
          throw new FileTooLargeError(p, Buffer.byteLength(entry.text, 'utf8'), this.#maxFileBytes);
        }
        return entry.text;
      case 'too-large':
        throw new FileTooLargeError(p, entry.size, this.#maxFileBytes);
      case 'absent':
        // Exactly what the disk reader throws for a missing file.
        throw new WorkspaceBoundaryError(p);
      case 'symlink':
        throw this.#refuse(p, 'is a symlink on the base commit');
      default:
        throw new Error(`Not a regular file: ${p}`);
    }
  }

  async listDir(relativePath: string): Promise<string[]> {
    const dir = normalize(relativePath);
    if (dir === null) return this.#head.listDir(relativePath);

    const names: string[] = [];
    const seen = new Set<string>();
    const consider = async (name: string): Promise<void> => {
      if (seen.has(name)) return;
      seen.add(name);
      const child = join(dir, name);
      if (this.#changed.has(child)) {
        const entry = await this.#entry(child);
        if (entry.kind !== 'absent') names.push(name);
      } else if (this.#hasChangedBelow(child)) {
        if (await this.#baseHasFileBelow(child)) names.push(name);
      } else {
        names.push(name);
      }
    };

    for (const name of await this.#head.listDir(dir)) await consider(name);
    for (const changed of this.#changed) {
      const rest = below(dir, changed);
      if (rest === null) continue;
      await consider(rest.split('/')[0]!);
    }
    return names;
  }

  async walk(options: WalkOptions = {}): Promise<WalkResult> {
    const head = await this.#head.walk(options);
    const maxFiles = options.maxFiles ?? 5000;

    // Everything the pull request touched is decided by the base, never by the
    // head: a modified file may have been a symlink before, an added one did
    // not exist, a removed one is missing from disk.
    const kept = head.files.filter((file) => !this.#changed.has(file));
    let depthLimited = head.depthLimited;
    const candidates: string[] = [];
    for (const file of this.#changed) {
      const verdict = walkWouldVisit(file, options);
      if (verdict === 'depth-limited') depthLimited = true;
      if (verdict === 'include') candidates.push(file);
    }

    const included = await mapConcurrent(candidates, 8, async (file) => {
      const entry = await this.#entry(file);
      // The disk walker skips symlinks and only lists regular files; a
      // submodule is a directory on disk. All of that is reproduced exactly.
      return entry.kind === 'file' || entry.kind === 'too-large' ? file : null;
    });

    const merged = [...kept, ...included.filter((file): file is string => file !== null)].sort(walkOrder);
    // If the head walk was cut short we cannot know which base files lay past
    // the cut, so the base walk is reported as cut short too. Consumers turn
    // that into "inconclusive", which is the honest answer.
    const truncated = head.truncated || merged.length > maxFiles;
    return { files: merged.slice(0, maxFiles), truncated, depthLimited };
  }

  #entry(relativePath: string): Promise<BaseEntry> {
    let entry = this.#entries.get(relativePath);
    if (entry === undefined) {
      entry = this.#load(relativePath);
      this.#entries.set(relativePath, entry);
    }
    return entry;
  }

  #hasChangedBelow(dir: string): boolean {
    for (const changed of this.#changed) if (below(dir, changed) !== null) return true;
    return false;
  }

  /** Git tracks no empty directories, so a directory exists iff some file lives under it. */
  async #baseHasFileBelow(dir: string): Promise<boolean> {
    // Disk first: one unchanged file below `dir` settles it without a request.
    const walked = await this.#head.walk({ dir, maxDepth: 64, maxFiles: 5000 });
    if (walked.files.some((file) => !this.#changed.has(file))) return true;
    for (const changed of this.#changed) {
      if (below(dir, changed) === null) continue;
      const entry = await this.#entry(changed);
      if (entry.kind !== 'absent') return true;
    }
    if (walked.truncated) throw this.#refuse(dir, 'has too many files to decide whether it exists on the base');
    return false;
  }

  #refuse(relativePath: string, why: string): Error {
    const message = `Cannot reproduce ${relativePath} as it is on the base commit: it ${why}`;
    this.problems.push(message);
    return new Error(message);
  }
}

/** Workspace-relative POSIX path, or `null` for anything outside the workspace. */
function normalize(relativePath: string): string | null {
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) return null;
  const normalized = path.posix.normalize(relativePath).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '' ? '.' : normalized;
}

function join(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

/** The part of `file` below `dir`, or `null` when it is not below it. */
function below(dir: string, file: string): string | null {
  if (dir === '.') return file;
  return file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
}

/**
 * Would `NodeWorkspaceFs.walk(options)` list `file`, if it were a regular file?
 *
 * Mirrors the walker step by step: start directory, ignored directory names,
 * ignore patterns on directories, depth, then name/extension filters and
 * ignore patterns on the file. The walker flags `depthLimited` when it reaches
 * a directory deeper than allowed, before it looks inside — so that verdict
 * does not depend on the file's name.
 */
function walkWouldVisit(file: string, options: WalkOptions): 'include' | 'exclude' | 'depth-limited' {
  const startDir = normalizeDir(options.dir ?? '.');
  const rest = below(startDir, file);
  if (rest === null) return 'exclude';

  const maxDepth = options.maxDepth ?? 8;
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoreDirs ?? [])]);
  const ignore = options.ignore ?? [];
  const segments = rest.split('/');
  const name = segments.pop()!;

  let current = startDir;
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const segment = segments[depth - 1]!;
    current = join(current, segment);
    if (ignored.has(segment)) return 'exclude';
    if (matchesIgnore(current, ignore)) return 'exclude';
    if (depth > maxDepth) return 'depth-limited';
  }

  if (options.names && !options.names.includes(name)) return 'exclude';
  if (options.extensions && !options.extensions.some((ext) => name.endsWith(ext))) return 'exclude';
  if (matchesIgnore(file, ignore)) return 'exclude';
  return 'include';
}

function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
}

/**
 * The order `NodeWorkspaceFs.walk` produces: depth-first, siblings sorted by
 * code unit. That is lexicographic order over path *segments*, which differs
 * from plain string order (`a-b` sorts before `a/c` as strings, after it here).
 */
export function walkOrder(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i]!;
    const y = right[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
