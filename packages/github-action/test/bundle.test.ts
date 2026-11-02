import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fixture } from '@setupguard/testing';
import { describe, expect, it } from 'vitest';

/**
 * Tests the file `action.yml` runs, not the sources.
 *
 * The bundle is copied out of the repository before it runs, so it cannot
 * resolve anything from `node_modules`: what passes here is a file that works
 * the way the runner starts it, `node dist/index.cjs`, with no install step.
 *
 * What this does not prove: that the GitHub-hosted runner accepts `node24`,
 * or that the real API answers like the fakes in acceptance.test.ts. The
 * first run on GitHub is the evidence for that — see Notes/17.
 */

const run = promisify(execFile);
const bundle = path.resolve(fileURLToPath(new URL('../dist/index.cjs', import.meta.url)));

interface Result {
  code: number;
  stdout: string;
  summary: string;
  output: string;
}

async function runBundle(project: string, env: Record<string, string>): Promise<Result> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-bundle-'));
  const isolated = path.join(temp, 'action', 'index.cjs');
  await fs.mkdir(path.dirname(isolated), { recursive: true });
  await fs.copyFile(bundle, isolated);

  const workspace = path.join(temp, 'repo');
  await fs.cp(project, workspace, { recursive: true });
  const summary = path.join(temp, 'summary.md');
  const output = path.join(temp, 'output.txt');
  await fs.writeFile(summary, '');
  await fs.writeFile(output, '');

  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await run(process.execPath, [isolated], {
      cwd: temp,
      env: {
        PATH: process.env['PATH'] ?? '',
        SYSTEMROOT: process.env['SYSTEMROOT'] ?? '',
        GITHUB_WORKSPACE: workspace,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
        INPUT_PATH: '.',
        'INPUT_FAIL-ON': 'error',
        ...env,
      },
    }));
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    code = failed.code ?? -1;
    stdout = failed.stdout ?? '';
  }
  return { code, stdout, summary: await fs.readFile(summary, 'utf8'), output: await fs.readFile(output, 'utf8') };
}

describe.skipIf(!existsSync(bundle))('dist/index.cjs', () => {
  it('passes a healthy project on push', async () => {
    const result = await runBundle(fixture('healthy-npm'), { GITHUB_EVENT_NAME: 'push' });
    expect(result.code).toBe(0);
    expect(result.output).toBe('result=pass\nreadiness=READY\nnew-errors=0\nnew-warnings=0\n');
    expect(result.summary).toContain('## SetupGuard: PASS');
  });

  it('fails a broken project on push, with the same findings as the CLI', async () => {
    const result = await runBundle(fixture('broken-node-project'), { GITHUB_EVENT_NAME: 'push' });
    expect(result.code).toBe(1);
    expect(result.output).toContain('result=fail\n');
    expect(result.output).toContain('new-errors=5\n');
    expect(result.stdout.split('\n').filter((l) => l.startsWith('::error title='))).toHaveLength(5);
  });

  it('fails closed on a pull request when the API cannot be reached', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-bundle-event-'));
    const event = path.join(temp, 'event.json');
    await fs.writeFile(event, JSON.stringify({ pull_request: { number: 1, head: { sha: 'c'.repeat(40) } } }));
    const project = path.join(temp, 'project');
    await fs.cp(fixture('healthy-npm'), project, { recursive: true });
    await fs.mkdir(path.join(project, '.git'));
    await fs.writeFile(path.join(project, '.git', 'HEAD'), `${'d'.repeat(40)}\n`);

    const result = await runBundle(project, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'acme/widgets',
      // Port 1 on loopback: refused immediately, no traffic leaves the machine.
      GITHUB_API_URL: 'https://127.0.0.1:1',
      INPUT_TOKEN: 'not-a-real-token',
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('result=incomplete\n');
    expect(result.stdout).toContain('Could not reach the GitHub API');
    expect(result.stdout).not.toContain('not-a-real-token');
  }, 30_000);
});
