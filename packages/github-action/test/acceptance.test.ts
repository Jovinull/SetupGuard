import { promises as fs } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runAction, type Analysis } from '../src/index.js';
import {
  BASE_SHA,
  caseDirs,
  checkout,
  fakeGitHub,
  HEAD_SHA,
  noSleep,
  type FakeGitHubOptions,
} from './support.js';

/**
 * End-to-end behaviour of the action against a controlled GitHub API.
 *
 * Each case is a real pair of trees under `fixtures/pull-requests/<case>/`.
 * The engine runs for real on the checked-out head and on the base view; only
 * the network is replaced. What these tests do **not** prove: that GitHub's
 * live API answers the way the fake does, or that the runner renders the
 * output — see `Notes/17-github-action-implementada.md` for that evidence.
 */

interface Outcome {
  readonly exitCode: number;
  readonly analysis: Analysis;
  readonly stdout: string;
  readonly summary: string;
  readonly outputs: string;
  readonly requests: Array<{ path: string; authorization: string | null }>;
}

async function run(
  caseName: string,
  options: { github?: FakeGitHubOptions; checkout?: Parameters<typeof checkout>[1] } = {},
): Promise<Outcome> {
  const dirs = caseDirs(caseName);
  const github = await fakeGitHub(dirs.base, dirs.head, options.github);
  const co = await checkout(caseName, options.checkout);
  const lines: string[] = [];
  const result = await runAction({
    env: co.env,
    fetch: github.fetch,
    sleep: noSleep,
    now: () => new Date('2026-11-02T00:00:00Z'),
    stopToken: 'setupguard-test-token',
    io: {
      stdout: (text) => lines.push(text),
      appendSummary: (markdown) => fs.appendFile(co.summaryPath, markdown),
      appendOutput: (text) => fs.appendFile(co.outputPath, text),
    },
  });
  return {
    exitCode: result.exitCode,
    analysis: result.analysis,
    stdout: lines.join('\n'),
    summary: await fs.readFile(co.summaryPath, 'utf8'),
    outputs: await fs.readFile(co.outputPath, 'utf8'),
    requests: github.requests,
  };
}

const byClass = (analysis: Analysis, classification: string) =>
  analysis.findings.filter((f) => f.classification === classification);

/** Lines outside the stop-commands region: the only ones the runner interprets. */
function commandLines(stdout: string): string[] {
  const out: string[] = [];
  let inert = false;
  for (const line of stdout.split('\n')) {
    if (line === '::stop-commands::setupguard-test-token') inert = true;
    else if (line === '::setupguard-test-token::') inert = false;
    else if (!inert) out.push(line);
  }
  return out;
}

describe('case 1: healthy repository, innocuous change', () => {
  it('passes, with no findings and a real comparison against the base', async () => {
    const outcome = await run('healthy');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.analysis.result).toBe('pass');
    expect(outcome.analysis.findings).toEqual([]);
    expect(outcome.analysis.head?.readiness).toBe('READY');
    expect(outcome.analysis.base?.readiness).toBe('READY');
    expect(outcome.analysis.comparison).toMatchObject({ baseRef: BASE_SHA, checkout: 'merge', changedFiles: 2 });
    expect(outcome.outputs).toBe('result=pass\nreadiness=READY\nnew-errors=0\nnew-warnings=0\n');
    expect(outcome.summary).toContain('No readiness problems introduced by this pull request.');
  });

  it('authenticates every request with the token and never prints it', async () => {
    const outcome = await run('healthy');
    expect(outcome.requests.length).toBeGreaterThan(0);
    for (const request of outcome.requests) expect(request.authorization).toBe('Bearer test-token-not-a-secret');
    expect(outcome.stdout).not.toContain('test-token-not-a-secret');
    expect(outcome.summary).not.toContain('test-token-not-a-secret');
  });
});

describe('case 2: the pull request removes a script the README uses', () => {
  it('fails with one new blocker pinned to the README line', async () => {
    const outcome = await run('script-removed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.analysis.result).toBe('fail');
    const added = byClass(outcome.analysis, 'new');
    expect(added).toHaveLength(1);
    expect(added[0]!.finding).toMatchObject({ code: 'node/docs-script-not-found', severity: 'error' });
    expect(added[0]!.finding.message).toContain('"npm dev"');
    expect(commandLines(outcome.stdout)).toContainEqual(
      expect.stringMatching(/^::error title=SetupGuard%3A new · node\/docs-script-drift,file=README\.md,line=13::README\.md tells the reader to run "npm dev"/),
    );
    expect(outcome.outputs).toContain('result=fail\n');
    expect(outcome.outputs).toContain('new-errors=1\n');
  });
});

describe('case 3: the pull request reads an undocumented environment variable', () => {
  it('reports a new warning that does not fail the job by default', async () => {
    const outcome = await run('env-var-added');
    expect(outcome.analysis.result).toBe('pass');
    expect(outcome.exitCode).toBe(0);
    const added = byClass(outcome.analysis, 'new');
    expect(added.map((f) => f.finding.message)).toEqual([
      'PAYMENTS_API_URL is read by the code but not listed in .env.example',
    ]);
    expect(commandLines(outcome.stdout)).toContainEqual(
      expect.stringMatching(/^::warning title=SetupGuard%3A new · node\/env-contract,file=src\/payments\.js,line=1::/),
    );
  });

  it('fails when fail-on is "warning"', async () => {
    const outcome = await run('env-var-added', { checkout: { failOn: 'warning' } });
    expect(outcome.analysis.result).toBe('fail');
    expect(outcome.exitCode).toBe(1);
  });
});

describe('case 4: a problem that is already on the base branch', () => {
  it('is reported as pre-existing, not as a regression, even though its line moved', async () => {
    const outcome = await run('preexisting');
    expect(outcome.analysis.result).toBe('pass');
    expect(outcome.exitCode).toBe(0);
    expect(byClass(outcome.analysis, 'new')).toEqual([]);
    const old = byClass(outcome.analysis, 'preexisting');
    expect(old).toHaveLength(1);
    expect(old[0]!.finding.message).toContain('"npm deploy"');
    // Base has it on line 18, the pull request moved it to line 22.
    expect(outcome.analysis.base?.results.flatMap((r) => r.findings)[0]?.evidence[0]?.line).toBe(18);
    expect(old[0]!.finding.evidence[0]?.line).toBe(22);
    // Not pinned to the diff; listed in the summary.
    expect(commandLines(outcome.stdout).filter((l) => l.startsWith('::'))).toEqual([]);
    expect(outcome.summary).toContain('Already on the base branch');
  });
});

describe('case 5: hostile content in the pull request', () => {
  it('cannot inject workflow commands, outputs or markup', async () => {
    const outcome = await run('malicious');
    expect(outcome.analysis.result).toBe('fail');

    // Every line the runner would interpret is one the action meant to write:
    // an annotation it built. None starts a command chosen by the content.
    const commands = commandLines(outcome.stdout);
    for (const line of commands) {
      expect(line).toMatch(/^::(error|warning|notice) title=SetupGuard%3A [^:]*::/);
    }
    // The hostile strings survive only inside escaped messages, never at the
    // start of a line, which is the only place the runner looks for a command.
    expect(commands.some((line) => line.includes('injected'))).toBe(true);
    expect(commands.filter((line) => /^::(warning|error)::/.test(line) || line.startsWith('::error file='))).toEqual([]);
    // The encoded newline from the README is escaped, so the runner decodes it
    // to the literal text "%0A", not to a line break.
    expect(commands.join('\n')).toContain('npm %250A::warning::injected');

    // The stop-commands region is closed exactly once, by the action.
    expect(outcome.stdout.split('\n').filter((l) => l === '::setupguard-test-token::')).toHaveLength(1);

    // Outputs stay a fixed, known set of simple values.
    expect(outcome.outputs.split('\n').filter(Boolean)).toEqual([
      'result=fail',
      'readiness=BLOCKED',
      expect.stringMatching(/^new-errors=\d+$/),
      expect.stringMatching(/^new-warnings=\d+$/),
    ]);

    // The hostile command text reaches the summary only as entities. (Link and
    // image escaping is covered directly in render.test.ts: the engine does not
    // turn a URL into a script reference, so no finding here carries one.)
    expect(outcome.summary).toContain('&#58;&#58;warning&#58;&#58;injected');
    expect(outcome.summary).not.toContain('::warning::injected');
  });

  it('keeps an annotation on one command line even when a file name carries an encoded newline', async () => {
    const outcome = await run('malicious');
    const injected = commandLines(outcome.stdout).find((l) => l.includes('INJECTED_VAR'));
    expect(injected).toBeDefined();
    // `%0A` in the file name is escaped to `%250A`, so the runner decodes it
    // back to the literal text instead of a line break.
    expect(injected).toContain('file=src/evil%250Aname%2Cx.js');
  });
});

describe('case 6: the GitHub API is unavailable', () => {
  it('reports INCOMPLETE and fails when the network is down, after retrying', async () => {
    const outcome = await run('healthy', { github: { fault: () => 'network' } });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.analysis.reasons[0]).toContain('Could not reach the GitHub API');
    // One request, three attempts (two retries).
    expect(outcome.requests).toHaveLength(3);
    expect(outcome.outputs).toContain('result=incomplete\n');
    expect(commandLines(outcome.stdout)[0]).toMatch(/^::error title=SetupGuard%3A analysis incomplete::/);
    expect(outcome.summary).toContain('Incomplete is not a pass.');
  });

  it.each([
    [401, {}, 'rejected the token'],
    [403, {}, 'not allowed'],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1798848000' }, 'rate limit'],
    [429, { 'retry-after': '60' }, 'rate limit'],
    [404, {}, '404'],
    [503, {}, 'still failing after retries'],
  ])('maps HTTP %i to an explicit INCOMPLETE', async (status, headers, text) => {
    const outcome = await run('healthy', {
      github: { fault: () => new Response('{"message":"x"}', { status, headers }) },
    });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.analysis.reasons[0]).toContain(text);
  });

  it('recovers when a 5xx is transient', async () => {
    const outcome = await run('healthy', {
      github: { fault: (_p, attempt) => (attempt === 1 ? new Response('', { status: 502 }) : undefined) },
    });
    expect(outcome.analysis.result).toBe('pass');
  });

  it('fails as INCOMPLETE when only reading the base content fails', async () => {
    const outcome = await run('script-removed', {
      github: { fault: (p) => (p.includes('/contents/') ? new Response('', { status: 500 }) : undefined) },
    });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.analysis.reasons[0]).toContain('Reading the base commit failed');
  });

  it('rejects a malformed response instead of trusting it', async () => {
    const outcome = await run('healthy', {
      github: {
        fault: (p) => (p.includes('/files') ? new Response('{"not":"an array"}', { status: 200 }) : undefined),
      },
    });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.analysis.reasons[0]).toContain('Unexpected response');
  });
});

describe('case 7: only files no check reads', () => {
  it('passes, and only asks the API about what the engine actually looked at', async () => {
    const outcome = await run('irrelevant');
    expect(outcome.analysis.result).toBe('pass');
    expect(outcome.analysis.findings).toEqual([]);
    expect(outcome.analysis.comparison?.changedFiles).toBe(3);
    // The base view is lazy. No check reads an SVG or a workflow file, so the
    // nested ones are never fetched. LICENSE is: the configuration loader
    // lists the root directory, and whether LICENSE was on the base is part
    // of that listing.
    expect(outcome.requests.filter((r) => r.path.includes('/contents/')).map((r) => r.path)).toEqual([
      `/repos/acme/widgets/contents/LICENSE?ref=${BASE_SHA}`,
    ]);
  });
});

describe('removed and renamed files', () => {
  it('reads the removed side from the base and classifies only the real regression', async () => {
    const outcome = await run('removed-and-renamed', { github: { renames: [['src/index.js', 'src/main.js']] } });
    const added = byClass(outcome.analysis, 'new');
    expect(added.map((f) => f.finding.code)).toEqual(['node/env-example-missing']);
    expect(outcome.analysis.result).toBe('pass');
    // Both sides of the rename were considered.
    const contentPaths = outcome.requests.filter((r) => r.path.includes('/contents/')).map((r) => r.path);
    expect(contentPaths.some((p) => p.includes('/contents/.env.example?'))).toBe(true);
    expect(contentPaths.some((p) => p.includes('/contents/src/index.js?'))).toBe(true);
  });
});

describe('checkout and pull request identity', () => {
  it('compares against the merge base when the head commit is checked out', async () => {
    const outcome = await run('script-removed', { checkout: { sha: HEAD_SHA } });
    expect(outcome.analysis.comparison).toMatchObject({ checkout: 'head', baseRef: BASE_SHA });
    expect(outcome.requests.some((r) => r.path.includes('/compare/'))).toBe(true);
    expect(outcome.analysis.result).toBe('fail');
  });

  it('refuses to compare when the checkout is some other commit', async () => {
    const outcome = await run('script-removed', { checkout: { sha: 'a'.repeat(40) } });
    expect(outcome.analysis.result).toBe('incomplete');
  });

  it('refuses to compare a stale run once the pull request moved on', async () => {
    const outcome = await run('healthy', { github: { pull: { headShaSequence: ['9'.repeat(40)] } } });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.analysis.reasons[0]).toContain('new commits');
  });

  it('notices the pull request moving between listing its files and finishing', async () => {
    const outcome = await run('healthy', { github: { pull: { headShaSequence: [HEAD_SHA, '9'.repeat(40)] } } });
    expect(outcome.analysis.result).toBe('incomplete');
  });

  it('refuses pull_request_target', async () => {
    const outcome = await run('healthy', { checkout: { event: 'pull_request_target' } });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.analysis.reasons[0]).toContain('pull_request_target');
    expect(outcome.requests).toEqual([]);
  });

  it('fails as INCOMPLETE without a usable token', async () => {
    const outcome = await run('healthy', {
      checkout: { token: '' },
      github: { fault: () => new Response('{}', { status: 401 }) },
    });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.requests[0]!.authorization).toBeNull();
  });
});

describe('API limits and untrusted file lists', () => {
  it('refuses a pull request larger than the files endpoint can list', async () => {
    const outcome = await run('healthy', { github: { pull: { changed_files: 3001 } } });
    expect(outcome.analysis.result).toBe('incomplete');
    expect(outcome.analysis.reasons[0]).toContain('at most 3000');
  });

  it('refuses a file list that disagrees with changed_files', async () => {
    const outcome = await run('healthy', { github: { pull: { changed_files: 5 } } });
    expect(outcome.analysis.result).toBe('incomplete');
  });

  it('follows pagination across several pages', async () => {
    const outcome = await run('irrelevant', {
      github: {
        mapFiles: (files) => [
          ...files,
          ...Array.from({ length: 247 }, (_, i) => ({ filename: `assets/img-${String(i).padStart(3, '0')}.png`, status: 'added' })),
        ],
      },
    });
    expect(outcome.analysis.comparison?.changedFiles).toBe(250);
    expect(outcome.requests.filter((r) => r.path.includes('/files?')).map((r) => r.path)).toEqual([
      '/repos/acme/widgets/pulls/7/files?per_page=100&page=1',
      '/repos/acme/widgets/pulls/7/files?per_page=100&page=2',
      '/repos/acme/widgets/pulls/7/files?per_page=100&page=3',
    ]);
    expect(outcome.analysis.result).toBe('pass');
  });

  it.each(['../../etc/passwd', '.git/config', 'a\nb.js', '/abs/path', 'dir\\file.js', 'a//b'])(
    'refuses the path %j from the API',
    async (filename) => {
      const outcome = await run('healthy', {
        github: { mapFiles: (files) => [...files, { filename, status: 'added' }] },
      });
      expect(outcome.analysis.result).toBe('incomplete');
      expect(outcome.analysis.reasons[0]).toContain('cannot handle safely');
    },
  );
});

describe('determinism', () => {
  it('produces the same verdict, annotations and summary on a re-run', async () => {
    const first = await run('preexisting');
    const second = await run('preexisting');
    expect(second.analysis.result).toBe(first.analysis.result);
    expect(commandLines(second.stdout)).toEqual(commandLines(first.stdout));
    expect(second.summary).toBe(first.summary);
  });
});

describe('outside pull requests', () => {
  it('diagnoses the whole checkout on push, with no API call', async () => {
    const outcome = await run('script-removed', { checkout: { event: 'push' } });
    expect(outcome.analysis.mode).toBe('full');
    expect(outcome.analysis.result).toBe('fail');
    expect(outcome.requests).toEqual([]);
  });

  it('reports a directory with no supported project as INCOMPLETE, never as a pass', async () => {
    const co = await checkout('healthy', { event: 'push' });
    await fs.rm(`${co.workspace}/package.json`);
    await fs.rm(`${co.workspace}/package-lock.json`);
    const lines: string[] = [];
    const result = await runAction({ env: co.env, io: { stdout: (t) => lines.push(t) } });
    expect(result.analysis.result).toBe('incomplete');
    expect(result.exitCode).toBe(1);
  });

  // Reproduces what happened on vitejs/vite: docs/ holds more files than the
  // engine scans, so the run is INCOMPLETE. The verdict must name the check
  // and the reason, and the documented remedy must actually work.
  it('names the check and the reason when a scan limit is reached, and ignore resolves it', async () => {
    const co = await checkout('healthy', { event: 'push' });
    await fs.mkdir(`${co.workspace}/docs`);
    for (let i = 0; i < 51; i += 1) await fs.writeFile(`${co.workspace}/docs/page-${i}.md`, `# Page ${i}\n`);

    const partial = await runAction({ env: co.env, io: { stdout: () => undefined } });
    expect(partial.analysis.result).toBe('incomplete');
    expect(partial.analysis.reasons.some((r) => r.startsWith('node/docs-script-drift (inconclusive): ') && r.includes('docs/'))).toBe(true);

    await fs.writeFile(`${co.workspace}/.setupguard.yml`, 'version: 1\nignore:\n  - docs/**\n');
    const fixed = await runAction({ env: co.env, io: { stdout: () => undefined } });
    expect(fixed.analysis.result).toBe('pass');
  });

  it('rejects a path input that leaves the workspace', async () => {
    const co = await checkout('healthy', { event: 'push' });
    const result = await runAction({ env: { ...co.env, INPUT_PATH: '../..' }, io: { stdout: () => undefined } });
    expect(result.analysis.result).toBe('incomplete');
    expect(result.analysis.reasons[0]).toContain('inside the workspace');
  });
});
