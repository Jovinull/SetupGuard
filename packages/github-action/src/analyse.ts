import { promises as fs } from 'node:fs';
import path from 'node:path';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  allFindings,
  describeError,
  loadConfig,
  NodeEnvironmentProbe,
  NodeWorkspaceFs,
  runDiagnosis,
  type Report,
  type WorkspaceFs,
} from '@setupguard/core';

import { BaseWorkspaceFs } from './base-fs.js';
import { compareReports, type ClassifiedFinding } from './compare.js';
import {
  InputError,
  readCheckedOutSha,
  readInputs,
  readRunContext,
  resolveAnalysisRoot,
  type FailOn,
  type RunContext,
} from './context.js';
import { GitHubApiError, GitHubClient, type ApiCall, type FetchLike } from './github-api.js';
import {
  getCommitParents,
  getContentAt,
  getMergeBase,
  getPullRequest,
  listPullRequestFiles,
  MAX_LISTED_FILES,
  type RepoRef,
} from './pull-request.js';

/**
 * Same limit the disk reader applies by default. Passed explicitly to both the
 * disk reader and the base view so the two sides of a comparison can never
 * disagree about which files are too large to read.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The action only ever runs the static level: see `Notes/17-github-action-implementada.md`. */
const LEVELS = ['static'] as const;

export type ActionResult = 'pass' | 'fail' | 'incomplete';

export interface ComparisonInfo {
  readonly baseRef: string;
  readonly checkout: 'merge' | 'head';
  readonly changedFiles: number;
  /** Changed paths inside the analysed directory. */
  readonly relevantPaths: number;
}

export interface Analysis {
  readonly mode: 'pull-request' | 'full';
  readonly result: ActionResult;
  /** Why the result is not `pass`, most important first. */
  readonly reasons: readonly string[];
  readonly failOn: FailOn;
  readonly pullRequest?: number;
  /** Workspace-relative POSIX prefix of the analysed directory ('' for the root). */
  readonly prefix: string;
  readonly head?: Report;
  readonly base?: Report;
  readonly findings: readonly ClassifiedFinding[];
  readonly comparison?: ComparisonInfo;
  readonly comparisonGaps: readonly string[];
  readonly apiCalls: readonly ApiCall[];
}

export interface AnalyseDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * Run the whole analysis and decide the result. Never throws: every failure,
 * including a bug in SetupGuard, ends as `incomplete` with a reason.
 */
export async function analyse(deps: AnalyseDeps): Promise<Analysis> {
  const env = deps.env;
  let failOn: FailOn = 'error';
  let prefix = '';
  let apiCalls: readonly ApiCall[] = [];
  let pullRequest: number | undefined;

  const mode: Analysis['mode'] = env['GITHUB_EVENT_NAME'] === 'pull_request' ? 'pull-request' : 'full';
  const incomplete = (reason: string, extra: Partial<Analysis> = {}): Analysis => ({
    mode,
    result: 'incomplete',
    reasons: [reason],
    failOn,
    prefix,
    findings: [],
    comparisonGaps: [],
    apiCalls,
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    ...extra,
  });

  try {
    const inputs = readInputs(env);
    failOn = inputs.failOn;
    const workspace = path.resolve(env['GITHUB_WORKSPACE'] ?? process.cwd());
    const root = resolveAnalysisRoot(workspace, inputs.path);
    try {
      if (!(await fs.stat(root.absolute)).isDirectory()) throw new Error();
    } catch {
      throw new InputError(`Input "path" does not name a directory in the workspace: ${inputs.path}`);
    }

    const context = await readRunContext(env);
    if (context.kind === 'pull-request') pullRequest = context.number;

    const headFs = new NodeWorkspaceFs(root.absolute, { maxFileBytes: MAX_FILE_BYTES });
    const head = await diagnose(headFs, deps.now);

    // Positions in a report are relative to the analysed directory; GitHub
    // wants them relative to the repository, i.e. to the checkout root.
    const repoRoot = await findRepoRoot(workspace, root.absolute);
    prefix = toPosix(path.relative(repoRoot ?? workspace, root.absolute));

    if (context.kind === 'full') return decideFull(head, failOn, prefix);

    if (repoRoot === null) {
      return incomplete(
        'No git checkout was found in the workspace. Run actions/checkout before SetupGuard.',
        { head },
      );
    }
    const client = new GitHubClient({
      token: inputs.token,
      ...(env['GITHUB_API_URL'] ? { baseUrl: env['GITHUB_API_URL'] } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });

    try {
      const compared = await compareWithBase({ context, client, repoRoot, prefix, headFs, head, now: deps.now });
      apiCalls = client.calls;
      if (typeof compared === 'string') return incomplete(compared, { head });
      return decidePullRequest(head, compared, failOn, prefix, client.calls, context.number);
    } catch (error) {
      apiCalls = client.calls;
      if (error instanceof GitHubApiError) return incomplete(error.message, { head });
      throw error;
    }
  } catch (error) {
    if (error instanceof InputError) return incomplete(error.message);
    return incomplete(`SetupGuard failed: ${describeError(error)}`);
  }
}

async function diagnose(fs: WorkspaceFs, now: (() => Date) | undefined, generous = false): Promise<Report> {
  const registry = new AdapterRegistry([nodeAdapter]);
  const config = await loadConfig({
    fs,
    knownCheckIds: registry.list().flatMap((adapter) => adapter.checks.map((check) => check.id)),
  });
  return runDiagnosis({
    fs,
    // Static level only, so no check consults the environment — and an empty
    // one guarantees nothing from the runner could reach a report if one did.
    environment: new NodeEnvironmentProbe({ env: {} }),
    registry,
    levels: LEVELS,
    config,
    // The base side reads changed files over the network; give it room so a
    // slow API turns into a slow run rather than a spurious internal error.
    ...(generous ? { adapterTimeoutMs: 180_000, checkTimeoutMs: 120_000 } : {}),
    ...(now ? { now } : {}),
  });
}

interface Compared {
  readonly base: Report;
  readonly info: ComparisonInfo;
  readonly findings: readonly ClassifiedFinding[];
  readonly gaps: readonly string[];
}

async function compareWithBase(options: {
  readonly context: Extract<RunContext, { kind: 'pull-request' }>;
  readonly client: GitHubClient;
  readonly repoRoot: string;
  readonly prefix: string;
  readonly headFs: WorkspaceFs;
  readonly head: Report;
  readonly now: (() => Date) | undefined;
}): Promise<Compared | string> {
  const { context, client, repo } = { ...options, repo: options.context.repo };

  const checkedOut = await readCheckedOutSha(options.repoRoot);
  if (checkedOut === null) {
    return 'Could not read which commit is checked out (.git/HEAD). Use actions/checkout without changing its ref.';
  }

  const stale = 'The pull request received new commits after this run started; the run for the newest commit is the one that counts.';
  const before = await getPullRequest(client, repo, context.number);
  if (before.headSha !== context.headSha) return stale;

  // The base to compare with depends on what is checked out:
  // - the merge commit (actions/checkout's default for pull_request) is the
  //   base branch tip plus the pull request, so the base is its first parent;
  // - the head commit sits on top of the merge base.
  let baseRef: string;
  let checkout: ComparisonInfo['checkout'];
  if (checkedOut === context.headSha) {
    baseRef = await getMergeBase(client, repo, before.baseSha, context.headSha);
    checkout = 'head';
  } else {
    const parents = await getCommitParents(client, repo, checkedOut);
    if (parents.length !== 2 || parents[1] !== context.headSha) {
      return 'The checked-out commit is neither the pull request merge commit nor its head commit, so there is no defined base to compare with. Use actions/checkout without changing its ref.';
    }
    baseRef = parents[0]!;
    checkout = 'merge';
  }

  if (before.changedFiles > MAX_LISTED_FILES) {
    return `The pull request changes ${before.changedFiles} files; GitHub lists at most ${MAX_LISTED_FILES}, so the changes cannot all be known.`;
  }
  const files = await listPullRequestFiles(client, repo, context.number);
  if (files.length !== before.changedFiles) {
    return `GitHub listed ${files.length} changed files but reports ${before.changedFiles}; the list of changes is not reliable.`;
  }
  const after = await getPullRequest(client, repo, context.number);
  if (after.headSha !== context.headSha) return stale;

  const changed = new Set<string>();
  for (const file of files) {
    for (const repoPath of [file.filename, file.previousFilename]) {
      if (repoPath === undefined) continue;
      if (!isUsableRepoPath(repoPath)) {
        return 'The pull request contains a file path SetupGuard cannot handle safely (control characters, backslashes, "..", ".git" or an absolute path), so the comparison was not attempted.';
      }
      const relative = underPrefix(repoPath, options.prefix);
      if (relative !== null) changed.add(relative);
    }
  }

  const apiFailures: string[] = [];
  const baseFs = new BaseWorkspaceFs({
    head: options.headFs,
    changed,
    maxFileBytes: MAX_FILE_BYTES,
    load: async (relative) => {
      try {
        return await getContentAt(client, repo, joinPrefix(options.prefix, relative), baseRef, MAX_FILE_BYTES);
      } catch (error) {
        apiFailures.push(error instanceof GitHubApiError ? error.message : describeError(error));
        throw error;
      }
    },
  });

  const base = await diagnose(baseFs, options.now, true);
  if (apiFailures.length > 0) return `Reading the base commit failed: ${apiFailures[0]}`;
  if (baseFs.problems.length > 0) return baseFs.problems[0]!;

  const comparison = compareReports(options.head, base);
  return {
    base,
    info: { baseRef, checkout, changedFiles: files.length, relevantPaths: changed.size },
    findings: comparison.findings,
    gaps: comparison.gaps,
  };
}

function headIsPartial(head: Report): boolean {
  return (
    head.readiness === 'INCOMPLETE' ||
    !head.config.valid ||
    head.results.some((result) => result.status === 'inconclusive' || result.status === 'internal-error')
  );
}

/**
 * Why the head analysis is partial: the engine's summary, then one line per
 * check that did not conclude, with the engine's own reason. A bare "2 checks
 * were inconclusive" gives a maintainer nothing to act on; "docs/ scan hit its
 * file limit" tells them to add an `ignore` entry.
 */
export function headPartialReasons(head: Report): string[] {
  const summary =
    head.incompleteReason ?? 'Part of the pull request could not be analysed (a check was inconclusive or failed).';
  const details = head.results
    .filter((result) => result.status === 'inconclusive' || result.status === 'internal-error')
    .map((result) => `${result.checkId} (${result.status}): ${result.reason ?? 'no reason given'}`);
  return [summary, ...details];
}

export function decideFull(head: Report, failOn: FailOn, prefix: string): Analysis {
  const findings = allFindings(head).map((finding) => ({ finding, classification: 'new' as const }));
  const base = { mode: 'full' as const, failOn, prefix, head, findings, comparisonGaps: [], apiCalls: [] };
  const errors = findings.filter((f) => f.finding.severity === 'error').length;
  const warnings = findings.filter((f) => f.finding.severity === 'warning').length;

  if (head.readiness === 'BLOCKED') {
    return { ...base, result: 'fail', reasons: [`${errors} blocking problem(s) found`, ...(headIsPartial(head) ? headPartialReasons(head) : [])] };
  }
  if (head.readiness === 'INCOMPLETE') return { ...base, result: 'incomplete', reasons: headPartialReasons(head) };
  if (head.readiness === 'WARNINGS' && failOn === 'warning') {
    return { ...base, result: 'fail', reasons: [`${warnings} warning(s) found and fail-on is "warning"`] };
  }
  return { ...base, result: 'pass', reasons: [] };
}

/**
 * The verdict for a pull request, in precedence order — the same shape as the
 * engine's own aggregation, where a proven problem outranks a gap:
 *
 * 1. a new error                       -> fail
 * 2. the pull request was not fully analysed -> incomplete
 * 3. an error that cannot be classified -> incomplete
 *    (also a warning, when fail-on is "warning")
 * 4. a new warning and fail-on "warning" -> fail
 * 5. otherwise                          -> pass
 */
export function decidePullRequest(
  head: Report,
  compared: Compared,
  failOn: FailOn,
  prefix: string,
  apiCalls: readonly ApiCall[],
  pullRequest: number,
): Analysis {
  const findings = compared.findings;
  const atThreshold = (severity: string): boolean => severity === 'error' || (failOn === 'warning' && severity === 'warning');
  const newErrors = findings.filter((f) => f.classification === 'new' && f.finding.severity === 'error').length;
  const newWarnings = findings.filter((f) => f.classification === 'new' && f.finding.severity === 'warning').length;
  const unclassified = findings.filter((f) => f.classification === 'unclassified' && atThreshold(f.finding.severity)).length;

  const common = {
    mode: 'pull-request' as const,
    failOn,
    prefix,
    pullRequest,
    head,
    base: compared.base,
    findings,
    comparison: compared.info,
    comparisonGaps: compared.gaps,
    apiCalls,
  };

  const reasons: string[] = [];
  if (newErrors > 0) reasons.push(`This pull request introduces ${newErrors} blocking problem(s)`);
  if (headIsPartial(head)) reasons.push(...headPartialReasons(head));
  if (unclassified > 0) {
    reasons.push(`${unclassified} problem(s) could not be compared with the base: ${compared.gaps.join('; ')}`);
  }
  if (newErrors > 0) return { ...common, result: 'fail', reasons };
  if (reasons.length > 0) return { ...common, result: 'incomplete', reasons };
  if (failOn === 'warning' && newWarnings > 0) {
    return { ...common, result: 'fail', reasons: [`This pull request introduces ${newWarnings} warning(s) and fail-on is "warning"`] };
  }
  return { ...common, result: 'pass', reasons: [] };
}

/** Nearest directory at or above `from`, and not above `workspace`, that holds `.git`. */
async function findRepoRoot(workspace: string, from: string): Promise<string | null> {
  let current = from;
  for (;;) {
    try {
      await fs.lstat(path.join(current, '.git'));
      return current;
    } catch {
      // keep climbing
    }
    if (current === workspace) return null;
    const parent = path.dirname(current);
    if (parent === current || path.relative(workspace, parent).startsWith('..')) return null;
    current = parent;
  }
}

/**
 * A repository path from the API that is safe to use as a workspace path.
 *
 * Git itself refuses `..` and `.git` components, so a path that has them did
 * not come from an honest response. Control characters and backslashes are
 * legal in Git but would not round-trip through the engine's POSIX paths on
 * every runner; they are refused rather than mangled.
 */
export function isUsableRepoPath(repoPath: string): boolean {
  if (repoPath === '' || repoPath.length > 4096 || repoPath.startsWith('/') || repoPath.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001F\u007F]/.test(repoPath)) return false;
  return repoPath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}

function underPrefix(repoPath: string, prefix: string): string | null {
  if (prefix === '') return repoPath;
  return repoPath.startsWith(`${prefix}/`) ? repoPath.slice(prefix.length + 1) : null;
}

export function joinPrefix(prefix: string, relative: string): string {
  return prefix === '' ? relative : `${prefix}/${relative}`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export type { RepoRef };
