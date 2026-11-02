import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isSha, type RepoRef } from './pull-request.js';

/**
 * Inputs and run context, read from the environment the runner provides.
 *
 * Everything here is validated before use. The event payload is written by
 * GitHub, but it carries text chosen by whoever opened the pull request, and
 * none of it is needed except numbers and commit SHAs.
 */

export type FailOn = 'error' | 'warning';

export interface ActionInputs {
  readonly token: string;
  /** Directory to analyse, relative to the workspace. */
  readonly path: string;
  readonly failOn: FailOn;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Read an input the way `@actions/core` does: `INPUT_<NAME>`, upper-cased. */
function input(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

export function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const failOn = input(env, 'fail-on') || 'error';
  if (failOn !== 'error' && failOn !== 'warning') {
    throw new InputError(`Input "fail-on" must be "error" or "warning"`);
  }
  return { token: input(env, 'token'), path: input(env, 'path') || '.', failOn };
}

export type RunContext =
  | { readonly kind: 'pull-request'; readonly repo: RepoRef; readonly number: number; readonly headSha: string }
  | { readonly kind: 'full'; readonly eventName: string };

/**
 * Decide what kind of run this is.
 *
 * - `pull_request`: compare the pull request against its base.
 * - `pull_request_target`: refused. That event checks out the *base* branch
 *   and grants a write-capable token; an analysis there would describe the
 *   wrong tree, and inviting users to pair it with a checkout of the pull
 *   request is exactly the pattern GitHub warns against.
 * - anything else (`push`, `workflow_dispatch`, `schedule`, ...): diagnose the
 *   checkout as a whole, like the CLI does.
 */
export async function readRunContext(env: NodeJS.ProcessEnv): Promise<RunContext> {
  const eventName = env['GITHUB_EVENT_NAME'] ?? '';
  if (eventName === 'pull_request_target') {
    throw new InputError(
      'SetupGuard does not run on pull_request_target: that event checks out the base branch, not the pull request, ' +
        'and runs with a privileged token. Trigger the workflow on pull_request instead.',
    );
  }
  if (eventName !== 'pull_request') return { kind: 'full', eventName: eventName || 'unknown' };

  const repo = parseRepository(env['GITHUB_REPOSITORY'] ?? '');
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!eventPath) throw new InputError('GITHUB_EVENT_PATH is not set');

  let payload: unknown;
  try {
    payload = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  } catch {
    throw new InputError('The event payload could not be read as JSON');
  }
  const pr = (payload as { pull_request?: { number?: unknown; head?: { sha?: unknown } } } | null)?.pull_request;
  const number = pr?.number;
  const headSha = pr?.head?.sha;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new InputError('The pull_request event payload has no valid pull request number');
  }
  if (!isSha(headSha)) throw new InputError('The pull_request event payload has no valid head SHA');
  return { kind: 'pull-request', repo, number, headSha };
}

export function parseRepository(value: string): RepoRef {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new InputError('GITHUB_REPOSITORY is not a valid owner/name');
  }
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * Resolve the `path` input against the workspace, refusing anything outside it.
 * Returns the absolute directory and its POSIX path relative to the workspace.
 */
export function resolveAnalysisRoot(workspace: string, relative: string): { absolute: string; prefix: string } {
  if (path.isAbsolute(relative)) throw new InputError('Input "path" must be relative to the workspace');
  const absolute = path.resolve(workspace, relative);
  const rel = path.relative(workspace, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new InputError('Input "path" must stay inside the workspace');
  return { absolute, prefix: rel.split(path.sep).join('/') };
}

/**
 * The commit checked out in `repoRoot`, read from `.git` without running git.
 *
 * `actions/checkout` leaves HEAD detached, so `.git/HEAD` normally holds the
 * SHA itself. A symbolic ref is followed through a loose ref file or
 * `packed-refs`. Anything else is `null`: the caller then refuses to compare,
 * because a comparison needs to know exactly which tree it is looking at.
 */
export async function readCheckedOutSha(repoRoot: string): Promise<string | null> {
  const gitDir = path.join(repoRoot, '.git');
  let head: string;
  try {
    if (!(await fs.lstat(gitDir)).isDirectory()) return null;
    head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return null;
  }
  if (isSha(head)) return head;

  const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (ref === undefined || ref.split('/').includes('..')) return null;
  try {
    const loose = (await fs.readFile(path.join(gitDir, ...ref.split('/')), 'utf8')).trim();
    if (isSha(loose)) return loose;
  } catch {
    // fall through to packed-refs
  }
  try {
    const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && isSha(sha)) return sha;
    }
  } catch {
    return null;
  }
  return null;
}
