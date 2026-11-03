import { encodeRepoPath, GitHubApiError, type GitHubClient } from './github-api.js';

/**
 * The REST operations the action needs, each returning validated data.
 *
 * Nothing from a response is used before its type and shape are checked.
 * File names in particular are attacker-controlled: anyone who can open a pull
 * request chooses them.
 */

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly changedFiles: number;
}

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface ChangedFile {
  readonly filename: string;
  readonly status: FileStatus;
  readonly previousFilename?: string;
}

/** GitHub documents that the files endpoint returns at most this many entries. */
export const MAX_LISTED_FILES = 3000;
const PER_PAGE = 100;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATUSES: ReadonlySet<string> = new Set([
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

function repoPrefix(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function unexpected(route: string, what: string): GitHubApiError {
  return new GitHubApiError('unexpected', route, `Unexpected response from ${route}: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getPullRequest(client: GitHubClient, repo: RepoRef, number: number): Promise<PullRequestInfo> {
  const route = `${repoPrefix(repo)}/pulls/${number}`;
  const { body } = await client.get(route);
  if (!isRecord(body)) throw unexpected(route, 'not an object');
  const head = body['head'];
  const base = body['base'];
  const changedFiles = body['changed_files'];
  if (body['number'] !== number) throw unexpected(route, 'pull request number does not match');
  if (!isRecord(head) || !isSha(head['sha'])) throw unexpected(route, 'missing head.sha');
  if (!isRecord(base) || !isSha(base['sha'])) throw unexpected(route, 'missing base.sha');
  if (typeof changedFiles !== 'number' || !Number.isSafeInteger(changedFiles) || changedFiles < 0) {
    throw unexpected(route, 'missing changed_files');
  }
  return { number, headSha: head['sha'], baseSha: base['sha'], changedFiles };
}

/**
 * List every file of a pull request, following pagination.
 *
 * Pages are requested by number until one comes back short. The endpoint caps
 * the listing at {@link MAX_LISTED_FILES}; callers compare the count with
 * `changed_files` to know whether the list is complete.
 */
export async function listPullRequestFiles(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  const maxPages = Math.ceil(MAX_LISTED_FILES / PER_PAGE);

  for (let page = 1; page <= maxPages; page += 1) {
    const route = `${repoPrefix(repo)}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`;
    const { body } = await client.get(route);
    if (!Array.isArray(body)) throw unexpected(route, 'not an array');
    if (body.length > PER_PAGE) throw unexpected(route, 'more entries than requested');

    for (const entry of body) {
      if (!isRecord(entry)) throw unexpected(route, 'entry is not an object');
      const { filename, status } = entry;
      const previous = entry['previous_filename'];
      if (typeof filename !== 'string' || filename === '') throw unexpected(route, 'entry without a filename');
      if (typeof status !== 'string' || !STATUSES.has(status)) throw unexpected(route, 'unknown file status');
      if (previous !== undefined && previous !== null && typeof previous !== 'string') {
        throw unexpected(route, 'previous_filename is not a string');
      }
      files.push({
        filename,
        status: status as FileStatus,
        ...(typeof previous === 'string' && previous !== '' ? { previousFilename: previous } : {}),
      });
    }

    if (body.length < PER_PAGE) break;
  }
  return files;
}

/** Parents of a commit, through the Git database API (no diff payload). */
export async function getCommitParents(client: GitHubClient, repo: RepoRef, sha: string): Promise<string[]> {
  const route = `${repoPrefix(repo)}/git/commits/${sha}`;
  const { body } = await client.get(route);
  if (!isRecord(body) || body['sha'] !== sha) throw unexpected(route, 'commit does not match');
  const parents = body['parents'];
  if (!Array.isArray(parents)) throw unexpected(route, 'missing parents');
  return parents.map((parent) => {
    if (!isRecord(parent) || !isSha(parent['sha'])) throw unexpected(route, 'malformed parent');
    return parent['sha'];
  });
}

/** Merge base of two commits, through the compare API. */
export async function getMergeBase(client: GitHubClient, repo: RepoRef, base: string, head: string): Promise<string> {
  const route = `${repoPrefix(repo)}/compare/${base}...${head}?per_page=1`;
  const { body } = await client.get(route);
  if (!isRecord(body)) throw unexpected(route, 'not an object');
  const mergeBase = body['merge_base_commit'];
  if (!isRecord(mergeBase) || !isSha(mergeBase['sha'])) throw unexpected(route, 'missing merge_base_commit');
  return mergeBase['sha'];
}

/** What a path is at a given commit. */
export type BaseEntry =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'too-large'; readonly size: number }
  | { readonly kind: 'dir' }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'submodule' };

/**
 * Fetch a path as it is at `ref`.
 *
 * Files up to 1 MB come back inline. Between 1 MB and the engine's own limit
 * the content is fetched as a blob. Above the limit the content is not fetched
 * at all — the engine refuses to read such a file from disk too.
 *
 * A symlink whose target is a regular file is answered by GitHub with the
 * *target's* content and path. That is detected by the path changing, and
 * reported as a symlink: substituting the target's text would not reproduce
 * what the engine does with a link on disk.
 */
export async function getContentAt(
  client: GitHubClient,
  repo: RepoRef,
  repoPath: string,
  ref: string,
  maxFileBytes: number,
): Promise<BaseEntry> {
  const route = `${repoPrefix(repo)}/contents/${encodeRepoPath(repoPath)}?ref=${ref}`;
  const response = await client.get(route, { allowNotFound: true });
  if (response.status === 404) return { kind: 'absent' };

  const body = response.body;
  if (Array.isArray(body)) return { kind: 'dir' };
  if (!isRecord(body)) throw unexpected(route, 'not an object');

  const type = body['type'];
  if (type === 'symlink') return { kind: 'symlink' };
  if (type === 'submodule') return { kind: 'submodule' };
  if (type === 'dir') return { kind: 'dir' };
  if (type !== 'file') throw unexpected(route, 'unknown content type');
  if (body['path'] !== repoPath) return { kind: 'symlink' };

  const size = body['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw unexpected(route, 'missing size');
  if (size > maxFileBytes) return { kind: 'too-large', size };

  const encoding = body['encoding'];
  const content = body['content'];
  let bytes: Buffer;
  if (encoding === 'base64' && typeof content === 'string') {
    bytes = Buffer.from(content, 'base64');
  } else if (encoding === 'none' || content === '') {
    const sha = body['sha'];
    if (!isSha(sha)) throw unexpected(route, 'missing blob sha');
    bytes = await getBlob(client, repo, sha);
  } else {
    throw unexpected(route, 'unknown content encoding');
  }

  // A cheap integrity check: a truncated or re-encoded body would otherwise be
  // analysed as if it were the real file.
  if (bytes.length !== size) throw unexpected(route, 'content length does not match the declared size');
  return { kind: 'file', text: bytes.toString('utf8') };
}

async function getBlob(client: GitHubClient, repo: RepoRef, sha: string): Promise<Buffer> {
  const route = `${repoPrefix(repo)}/git/blobs/${sha}`;
  const { body } = await client.get(route);
  if (!isRecord(body) || body['encoding'] !== 'base64' || typeof body['content'] !== 'string') {
    throw unexpected(route, 'blob is not base64');
  }
  return Buffer.from(body['content'], 'base64');
}
