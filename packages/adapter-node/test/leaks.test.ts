import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeAdapter } from '@setupguard/adapter-node';
import { AdapterRegistry, NodeWorkspaceFs, reportToJson, runDiagnosis } from '@setupguard/core';
import { stubEnvironment } from '@setupguard/testing';

/**
 * Regression tests for the three channels through which repository content
 * reached the report verbatim. Each one is written as the reproduction, not as
 * a unit test of the fix, so it keeps failing if the fix is bypassed later by a
 * different code path.
 */

const created: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-leak-'));
  created.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function diagnose(root: string, options: { env?: string[] } = {}): Promise<string> {
  const report = await runDiagnosis({
    fs: new NodeWorkspaceFs(root),
    environment: stubEnvironment(options.env ? { envVars: options.env } : {}),
    registry: new AdapterRegistry([nodeAdapter]),
  });
  return reportToJson(report);
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('secrets never reach the report', () => {
  it('does not echo a credential written inline in a documented command', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      'README.md': ['# x', '', '```bash', 'TOKEN=QA-FAKE-CREDENTIAL-0005 npm run missing', '```'].join(
        '\n',
      ),
    });

    const serialized = await diagnose(root);

    expect(serialized).not.toContain('QA-FAKE-CREDENTIAL-0005');
    // The finding itself is still produced and still actionable.
    expect(serialized).toContain('node/docs-script-not-found');
    expect(serialized).toContain('missing');
  });

  it('does not echo the file contents through a JSON parser message', async () => {
    const root = await workspace({
      // Malformed on purpose, and starting with a credential: the native
      // JSON.parse message quotes the first characters of the input.
      'package.json': 'QA-FAKE-CREDENTIAL-0001\n{ "name": "x" }',
      'package-lock.json': '{"lockfileVersion":3}',
    });

    const serialized = await diagnose(root);

    expect(serialized).not.toContain('QA-FAKE-CREDENTIAL-0001');
    expect(serialized).toContain('node/package-json-invalid');
    expect(serialized).toContain('invalid JSON');
  });

  // See the note in packages/core/test/workspace-fs.test.ts: symlink creation
  // is privileged on Windows.
  const symlinkIt = process.platform === 'win32' ? it.skip : it;

  symlinkIt('does not read, or quote, a file symlinked outside the workspace', async () => {
    const outside = await workspace({ 'secret.txt': 'OUTSIDE-ROOT-SECRET-VALUE' });
    const root = await workspace({ 'package-lock.json': '{"lockfileVersion":3}' });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'package.json'));

    const serialized = await diagnose(root);

    expect(serialized).not.toContain('OUTSIDE-ROOT-SECRET-VALUE');
    // The symlinked manifest is treated as absent, which is the honest answer.
    expect(serialized).toContain('node/package-json-missing');
  });

  it('does not quote a dotenv value anywhere in the report', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      '.env.example': 'API_TOKEN=\nDATABASE_URL=',
      '.env': 'API_TOKEN=live-token-DO-NOT-LEAK\nDATABASE_URL=postgres://u:pw-secret@h/db',
      'src/index.js': "export const t = process.env.API_TOKEN ?? 'inline-fallback-SECRET';",
    });

    const serialized = await diagnose(root);

    expect(serialized).not.toContain('live-token-DO-NOT-LEAK');
    expect(serialized).not.toContain('pw-secret');
    expect(serialized).not.toContain('inline-fallback-SECRET');
  });
});
