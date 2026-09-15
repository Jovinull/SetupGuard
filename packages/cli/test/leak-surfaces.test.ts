import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '@setupguard/cli';

/**
 * End-to-end proof that a credential written into a repository cannot reach any
 * output surface.
 *
 * The unit tests in `packages/core/test/redact-adversarial.test.ts` pin the
 * rules; these pin the *plumbing*. A leak has twice been reintroduced not by
 * weakening the rules but by adding a field, or a renderer, that bypassed them,
 * so every assertion here searches the finished output rather than a single
 * field.
 */

const created: string[] = [];

/** Distinct markers so a failure says exactly which channel leaked. */
const SECRETS = {
  readmeFlag: 'QA-LEAK-README-FLAG-0001',
  readmeSpaced: 'QA-LEAK-README-SPACED-0002',
  readmeHeader: 'QA-LEAK-README-HEADER-0003',
  scriptFlag: 'QA-LEAK-SCRIPT-FLAG-0004',
  scriptAssignment: 'QA-LEAK-SCRIPT-ASSIGN-0005',
  envValue: 'QA-LEAK-ENV-VALUE-0006',
  fileName: 'QA-LEAK-FILENAME-0007',
} as const;

async function hostileWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-leak-cli-'));
  created.push(root);

  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'hostile',
        engines: { node: '>=20' },
        scripts: {
          build: 'tsc',
          // Both a flag-style and an assignment-style credential, each on a line
          // that also references a script that does not exist.
          deploy: `npm run ghost-a --token=${SECRETS.scriptFlag}`,
          release: `API_KEY=${SECRETS.scriptAssignment} npm run ghost-b`,
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  await fs.writeFile(path.join(root, '.env.example'), 'API_TOKEN=\n');
  await fs.writeFile(path.join(root, '.env'), `API_TOKEN=${SECRETS.envValue}\n`);

  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.js'), 'export const t = process.env.API_TOKEN;\n');
  // A file whose own name carries a credential.
  await fs.writeFile(path.join(root, 'src', `TOKEN=${SECRETS.fileName}.js`), 'export const x = 1;\n');

  await fs.writeFile(
    path.join(root, 'README.md'),
    [
      '# hostile',
      '',
      '```bash',
      `npm run ghost-c --otp=${SECRETS.readmeFlag}`,
      `npm run ghost-d --password ${SECRETS.readmeSpaced}`,
      '```',
      '',
      `Set \`Authorization: Bearer ${SECRETS.readmeHeader}\` and run \`npm run ghost-e\`.`,
      '',
    ].join('\n'),
  );

  return root;
}

function capture(): { io: CliIo; text: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      isTty: false,
      env: {},
    },
    text: () => [...out, ...err].join('\n'),
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('no credential reaches any CLI surface', () => {
  it('not the JSON report', async () => {
    const root = await hostileWorkspace();
    const { io, text } = capture();
    await runCli([root, '--json'], io, '0.0.0');

    const output = text();
    for (const [channel, secret] of Object.entries(SECRETS)) {
      expect(output, channel).not.toContain(secret);
    }
    // The findings themselves still exist: redaction must not silence the tool.
    expect(output).toContain('ghost-a');
    expect(output).toContain('ghost-c');
  });

  it('not the human output', async () => {
    const root = await hostileWorkspace();
    const { io, text } = capture();
    await runCli([root, '--verbose'], io, '0.0.0');

    const output = text();
    for (const [channel, secret] of Object.entries(SECRETS)) {
      expect(output, channel).not.toContain(secret);
    }
    expect(output).toContain('node/docs-script-not-found');
  });

  it('not an unexpected internal failure', async () => {
    const root = await hostileWorkspace();
    const out: string[] = [];
    const err: string[] = [];
    const marker = 'QA-LEAK-CRASH-0008';

    const result = await runCli(
      [root],
      {
        // Fail while writing the report. This path sits outside runDiagnosis,
        // so nothing has sanitised the message by the time it reaches stderr.
        stdout: () => {
          throw new Error(`write failed for --token=${marker}`);
        },
        stderr: (t) => err.push(t),
        isTty: false,
        env: {},
      },
      '0.0.0',
    );

    const text = [...out, ...err].join('\n');
    // A crash is an incomplete diagnosis, never a verdict on the project.
    expect(result.exitCode).toBe(3);
    expect(text).not.toContain(marker);
    // Still says what happened, and still names the failure.
    expect(text).toContain('SetupGuard failed');
    expect(text).toContain('write failed');
    expect(text).toContain('***');
  });

  it('not the human output with colour enabled', async () => {
    const root = await hostileWorkspace();
    const { io, text } = capture();
    await runCli([root, '--color'], io, '0.0.0');

    for (const [channel, secret] of Object.entries(SECRETS)) {
      expect(text(), channel).not.toContain(secret);
    }
  });
});
