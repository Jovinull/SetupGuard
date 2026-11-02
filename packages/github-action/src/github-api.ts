/**
 * Minimal GitHub REST client.
 *
 * Deliberately small: global `fetch`, no Octokit. The action makes a handful of
 * GET requests, and every one of them is listed in the job log and the
 * summary, so the integration can be audited from the run itself.
 *
 * Every response body is treated as untrusted input: the caller validates its
 * shape before using a single field.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'not-found'
  | 'server'
  | 'network'
  | 'unexpected'
  | 'budget';

/**
 * A GitHub API failure, already phrased for a maintainer.
 *
 * The message never includes the token, and never includes the response body:
 * GitHub's error bodies are harmless, but a proxy or GHES instance in between
 * could echo anything.
 */
export class GitHubApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly route: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface ApiCall {
  readonly method: 'GET';
  /** Path and query, e.g. `/repos/o/r/pulls/7/files?per_page=100&page=1`. */
  readonly path: string;
  /** Status of the final attempt, or `undefined` when no response arrived. */
  readonly status?: number;
  readonly attempts: number;
}

export interface GitHubClientOptions {
  /** `GITHUB_API_URL`; defaults to `https://api.github.com`. */
  readonly baseUrl?: string;
  /** Empty means anonymous, which only works for public repositories. */
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Hard cap on requests per run. Default {@link DEFAULT_MAX_REQUESTS}. */
  readonly maxRequests?: number;
  /** Per-request timeout. Default 30 s. */
  readonly timeoutMs?: number;
  /** Delays before each retry of a 5xx or network failure. Default 1 s, 3 s. */
  readonly retryDelaysMs?: readonly number[];
}

/**
 * A run is bounded so a huge pull request degrades to an explicit
 * `INCOMPLETE` instead of eating the repository's hourly `GITHUB_TOKEN` quota.
 */
export const DEFAULT_MAX_REQUESTS = 400;

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export class GitHubClient {
  readonly calls: ApiCall[] = [];
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRequests: number;
  readonly #timeoutMs: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(options: GitHubClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? 'https://api.github.com');
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retryDelaysMs = options.retryDelaysMs ?? [1_000, 3_000];
  }

  get authenticated(): boolean {
    return this.#token !== '';
  }

  /**
   * GET a JSON resource.
   *
   * `allowNotFound` turns a 404 into `{ status: 404 }` for the one caller that
   * needs it (a file absent from the base commit). Everywhere else a 404 is an
   * error: on a private repository GitHub answers 404, not 403, when the token
   * cannot see the resource.
   */
  async get(path: string, options: { readonly allowNotFound?: boolean } = {}): Promise<ApiResponse> {
    if (this.calls.length >= this.#maxRequests) {
      throw new GitHubApiError(
        'budget',
        path,
        `SetupGuard stopped after ${this.#maxRequests} GitHub API requests for this run, so the comparison was not finished`,
      );
    }

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'setupguard-action',
    };
    if (this.#token !== '') headers['authorization'] = `Bearer ${this.#token}`;

    let attempts = 0;
    for (;;) {
      attempts += 1;
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        // The thrown value is not described: undici's messages can include the
        // full URL, and nothing in it helps a maintainer more than this does.
        if (await this.#retry(attempts)) continue;
        this.calls.push({ method: 'GET', path, attempts });
        throw new GitHubApiError('network', path, `Could not reach the GitHub API (${path})`);
      }

      const status = response.status;
      if (status >= 500 && (await this.#retry(attempts))) continue;
      this.calls.push({ method: 'GET', path, status, attempts });

      if (status === 404 && options.allowNotFound) return { status, body: undefined };
      if (status < 200 || status >= 300) throw this.#statusError(path, response);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GitHubApiError('unexpected', path, `GitHub returned a response that is not JSON (${path})`, status);
      }
      return { status, body };
    }
  }

  async #retry(attempts: number): Promise<boolean> {
    const delay = this.#retryDelaysMs[attempts - 1];
    if (delay === undefined) return false;
    await this.#sleep(delay);
    return true;
  }

  #statusError(path: string, response: Response): GitHubApiError {
    const status = response.status;
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    const reset = Number(response.headers.get('x-ratelimit-reset'));

    if (status === 429 || ((status === 403 || status === 429) && (remaining === '0' || retryAfter !== null))) {
      const when =
        Number.isFinite(reset) && reset > 0
          ? ` The limit resets at ${new Date(reset * 1000).toISOString()}.`
          : retryAfter !== null && /^\d+$/.test(retryAfter)
            ? ` GitHub asked to retry after ${retryAfter} s.`
            : '';
      return new GitHubApiError('rate-limited', path, `GitHub API rate limit reached (${path}).${when}`, status);
    }
    if (status === 401) {
      return new GitHubApiError(
        'unauthorized',
        path,
        `GitHub rejected the token (401, ${path}). Pass the workflow's GITHUB_TOKEN as the "token" input.`,
        status,
      );
    }
    if (status === 403) {
      return new GitHubApiError(
        'forbidden',
        path,
        `The token is not allowed to read ${path} (403). The job needs "contents: read" and "pull-requests: read".`,
        status,
      );
    }
    if (status === 404) {
      return new GitHubApiError(
        'not-found',
        path,
        `GitHub answered 404 for ${path}. Either it does not exist or the token cannot see it; the job needs "contents: read" and "pull-requests: read".`,
        status,
      );
    }
    if (status >= 500) {
      return new GitHubApiError('server', path, `GitHub API error ${status} (${path}), still failing after retries`, status);
    }
    return new GitHubApiError('unexpected', path, `Unexpected GitHub API status ${status} (${path})`, status);
  }
}

function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GITHUB_API_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('GITHUB_API_URL must use https');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('GITHUB_API_URL must be a plain https URL');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Encode a repository path for use in a URL, one segment at a time. */
export function encodeRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}
