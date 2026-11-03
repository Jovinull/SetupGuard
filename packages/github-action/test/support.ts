import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixture } from '@setupguard/testing';

import type { FetchLike } from '../src/index.js';

/**
 * A controlled GitHub API for one pull request.
 *
 * Nothing is hand-written per test: the file list is computed by diffing the
 * fixture's `base/` and `head/` directories, and file contents are served from
 * `base/`. A test that passes therefore says something about a real pair of
 * trees, not about a canned response that happens to agree with the code.
 *
 * Shapes follow the documented REST responses: paginated `pulls/{n}/files`,
 * base64 contents wrapped at 60 columns like GitHub's, arrays for directories,
 * 404 for missing paths.
 */

export const OWNER = 'acme';
export const REPO = 'widgets';
export const PR = 7;
export const BASE_SHA = 'b'.repeat(40);
export const HEAD_SHA = 'c'.repeat(40);
export const MERGE_SHA = 'd'.repeat(40);

export interface ChangedEntry {
  filename: string;
  status: string;
  previous_filename?: string;
}

export interface FakeGitHubOptions {
  /** Pairs `[from, to]` reported as renames instead of remove + add. */
  readonly renames?: ReadonlyArray<readonly [string, string]>;
  /** Replace or extend the computed file list. */
  readonly mapFiles?: (files: ChangedEntry[]) => ChangedEntry[];
  /** Overrides for the pull request object. */
  readonly pull?: { changed_files?: number; headShaSequence?: string[] };
  /** Return a response (or throw) to inject a fault; `undefined` to serve normally. */
  readonly fault?: (pathAndQuery: string, attempt: number) => Response | 'network' | undefined;
}

export interface FakeGitHub {
  readonly fetch: FetchLike;
  /** Every request, in order: path and query, and the authorization header seen. */
  readonly requests: Array<{ path: string; authorization: string | null }>;
  readonly files: ChangedEntry[];
}

async function listTree(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const visit = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) out.set(rel, await fs.readFile(abs));
    }
  };
  await visit(root, '');
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function wrap60(base64: string): string {
  return (base64.match(/.{1,60}/g) ?? []).join('\n') + '\n';
}

export async function fakeGitHub(baseDir: string, headDir: string, options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const base = await listTree(baseDir);
  const head = await listTree(headDir);

  let files: ChangedEntry[] = [];
  for (const name of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b === undefined) files.push({ filename: name, status: 'added' });
    else if (h === undefined) files.push({ filename: name, status: 'removed' });
    else if (!b.equals(h)) files.push({ filename: name, status: 'modified' });
  }
  for (const [from, to] of options.renames ?? []) {
    files = files.filter((f) => f.filename !== from && f.filename !== to);
    files.push({ filename: to, status: 'renamed', previous_filename: from });
  }
  if (options.mapFiles) files = options.mapFiles(files);

  const requests: FakeGitHub['requests'] = [];
  const attempts = new Map<string, number>();
  const headShas = [...(options.pull?.headShaSequence ?? [])];
  const prefix = `/repos/${OWNER}/${REPO}`;

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url);
    const pathAndQuery = `${parsed.pathname}${parsed.search}`;
    const headers = new Headers(init.headers);
    requests.push({ path: pathAndQuery, authorization: headers.get('authorization') });
    const attempt = (attempts.get(pathAndQuery) ?? 0) + 1;
    attempts.set(pathAndQuery, attempt);

    const fault = options.fault?.(pathAndQuery, attempt);
    if (fault === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (fault !== undefined) return Promise.resolve(fault);

    const route = parsed.pathname;
    if (route === `${prefix}/pulls/${PR}`) {
      const headSha = headShas.length > 1 ? headShas.shift()! : (headShas[0] ?? HEAD_SHA);
      return Promise.resolve(
        json({
          number: PR,
          head: { sha: headSha },
          base: { sha: BASE_SHA },
          changed_files: options.pull?.changed_files ?? files.length,
        }),
      );
    }
    if (route === `${prefix}/pulls/${PR}/files`) {
      const perPage = Number(parsed.searchParams.get('per_page') ?? 30);
      const page = Number(parsed.searchParams.get('page') ?? 1);
      const slice = files.slice((page - 1) * perPage, page * perPage);
      return Promise.resolve(json(slice.map((f) => ({ ...f, sha: 'e'.repeat(40), additions: 1, deletions: 0, changes: 1 }))));
    }
    if (route === `${prefix}/git/commits/${MERGE_SHA}`) {
      return Promise.resolve(json({ sha: MERGE_SHA, parents: [{ sha: BASE_SHA }, { sha: HEAD_SHA }] }));
    }
    if (route === `${prefix}/compare/${BASE_SHA}...${HEAD_SHA}`) {
      return Promise.resolve(json({ merge_base_commit: { sha: BASE_SHA } }));
    }
    if (route.startsWith(`${prefix}/contents/`)) {
      if (parsed.searchParams.get('ref') !== BASE_SHA) return Promise.resolve(json({ message: 'Not Found' }, 404));
      const repoPath = route
        .slice(`${prefix}/contents/`.length)
        .split('/')
        .map(decodeURIComponent)
        .join('/');
      const content = base.get(repoPath);
      if (content !== undefined) {
        return Promise.resolve(
          json({
            type: 'file',
            path: repoPath,
            size: content.length,
            sha: 'f'.repeat(40),
            encoding: 'base64',
            content: wrap60(content.toString('base64')),
          }),
        );
      }
      const children = [...base.keys()].filter((k) => k.startsWith(`${repoPath}/`));
      if (children.length > 0) return Promise.resolve(json(children.map((c) => ({ type: 'file', path: c }))));
      return Promise.resolve(json({ message: 'Not Found' }, 404));
    }
    return Promise.resolve(json({ message: 'Not Found' }, 404));
  };

  return { fetch, requests, files };
}

export interface Checkout {
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  readonly summaryPath: string;
  readonly outputPath: string;
}

/**
 * Copy a fixture's `head/` to a temporary workspace that looks like what
 * `actions/checkout` leaves behind: the files, plus `.git/HEAD` naming the
 * checked-out commit.
 */
export async function checkout(
  caseName: string,
  options: { sha?: string; event?: string; failOn?: string; token?: string; eventPayload?: unknown } = {},
): Promise<Checkout> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-action-'));
  const workspace = path.join(temp, 'repo');
  await fs.cp(path.join(fixture('pull-requests'), caseName, 'head'), workspace, { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.git', 'HEAD'), `${options.sha ?? MERGE_SHA}\n`);

  const eventPath = path.join(temp, 'event.json');
  await fs.writeFile(
    eventPath,
    JSON.stringify(options.eventPayload ?? { pull_request: { number: PR, head: { sha: HEAD_SHA } } }),
  );
  const summaryPath = path.join(temp, 'summary.md');
  const outputPath = path.join(temp, 'output.txt');

  return {
    workspace,
    summaryPath,
    outputPath,
    env: {
      GITHUB_EVENT_NAME: options.event ?? 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
      GITHUB_WORKSPACE: workspace,
      GITHUB_SHA: MERGE_SHA,
      'INPUT_TOKEN': options.token ?? 'test-token-not-a-secret',
      'INPUT_FAIL-ON': options.failOn ?? 'error',
      INPUT_PATH: '.',
    },
  };
}

export function caseDirs(caseName: string): { base: string; head: string } {
  const root = path.join(fixture('pull-requests'), caseName);
  return { base: path.join(root, 'base'), head: path.join(root, 'head') };
}

/** No real waiting in tests: retries are exercised, delays are not. */
export const noSleep = (): Promise<void> => Promise.resolve();
