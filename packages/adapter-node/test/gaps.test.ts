import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findNestedProjectDirs, nodeAdapter, scanEnvUsage } from '@setupguard/adapter-node';
import { AdapterRegistry, NodeWorkspaceFs, runDiagnosis, type Report } from '@setupguard/core';
import { stubEnvironment } from '@setupguard/testing';

/**
 * A file SetupGuard cannot read must never become a statement about the
 * project. Every case here previously ended in a clean `READY`, because the gap
 * was either recorded and ignored, or hidden behind `not-applicable` when
 * `applies()` looked only at the facts the failed read was supposed to produce.
 */

const created: string[] = [];
const OVERSIZED = 'x'.repeat(4096);

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-gap-'));
  created.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

/** Diagnose with a 1 KiB read limit, so an oversized file is unreadable. */
async function diagnose(root: string): Promise<Report> {
  return runDiagnosis({
    fs: new NodeWorkspaceFs(root, { maxFileBytes: 1024 }),
    environment: stubEnvironment(),
    registry: new AdapterRegistry([nodeAdapter]),
  });
}

function statusOf(report: Report, checkId: string): string | undefined {
  return report.results.find((result) => result.checkId === checkId)?.status;
}

const HEALTHY = {
  'package.json': JSON.stringify({
    name: 'x',
    engines: { node: '>=20' },
    scripts: { build: 'tsc' },
  }),
  'package-lock.json': '{"lockfileVersion":3}',
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('an unreadable file never yields READY', () => {
  it('unreadable .nvmrc', async () => {
    const report = await diagnose(await workspace({ ...HEALTHY, '.nvmrc': OVERSIZED }));

    expect(statusOf(report, 'node/node-version-declaration')).toBe('inconclusive');
    expect(statusOf(report, 'node/node-version-runtime')).toBe('inconclusive');
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toMatch(/could not reach a conclusion/);
  });

  it('unreadable README', async () => {
    const report = await diagnose(await workspace({ ...HEALTHY, 'README.md': OVERSIZED }));

    // `documents` ends up empty, so a facts-only applies() would have made this
    // not-applicable and the whole report READY.
    expect(statusOf(report, 'node/docs-script-drift')).toBe('inconclusive');
    expect(report.readiness).toBe('INCOMPLETE');
  });

  it('unreadable .env.example', async () => {
    const report = await diagnose(await workspace({ ...HEALTHY, '.env.example': OVERSIZED }));

    expect(statusOf(report, 'node/env-contract')).toBe('inconclusive');
    expect(statusOf(report, 'node/env-local-file')).toBe('inconclusive');
    expect(report.readiness).toBe('INCOMPLETE');
  });

  it('unreadable package.json', async () => {
    const report = await diagnose(
      await workspace({ 'package.json': OVERSIZED, 'package-lock.json': '{"lockfileVersion":3}' }),
    );

    for (const checkId of [
      'node/package-manager',
      'node/node-version-declaration',
      'node/scripts',
      'node/package-manager-available',
    ]) {
      expect(statusOf(report, checkId), checkId).toBe('inconclusive');
    }
    expect(report.readiness).toBe('INCOMPLETE');
  });
});

describe('scan limits are reported, not absorbed', () => {
  it('a truncated source walk is reported as a gap, not as a clean scan', async () => {
    const files: Record<string, string> = { ...HEALTHY };
    for (let index = 0; index < 10; index += 1) {
      files[`src/file-${index}.js`] = 'export const x = 1;';
    }
    const root = await workspace(files);
    const wfs = new NodeWorkspaceFs(root);

    const truncated = await scanEnvUsage(wfs, { maxFiles: 3 });
    expect(truncated.gaps.map((gap) => gap.scope)).toContain('source-scan');
    expect(truncated.gaps[0]?.reason).toMatch(/file limit/);

    // With room for every file there is nothing to report.
    expect((await scanEnvUsage(wfs, { maxFiles: 100 })).gaps).toEqual([]);
  });

  it('a truncated nested-project search is reported, because it moves a boundary', async () => {
    const root = await workspace({
      ...HEALTHY,
      'packages/a/package.json': '{"name":"a"}',
      'packages/b/package.json': '{"name":"b"}',
      'packages/c/package.json': '{"name":"c"}',
    });
    const wfs = new NodeWorkspaceFs(root);

    // Missing a nested project means the source scan crosses that boundary and
    // blames the root project for a child package's variables.
    const partial = await findNestedProjectDirs(wfs, { maxFiles: 2 });
    expect(partial.gaps.map((gap) => gap.scope)).toContain('source-scan');

    const complete = await findNestedProjectDirs(wfs);
    expect(complete.gaps).toEqual([]);
    expect(complete.dirs).toEqual(['packages/a/', 'packages/b/', 'packages/c/']);
  });

  it('a docs tree deeper than the limit is reported as a gap', async () => {
    const deep = 'docs/a/b/c/d/e/deep.md';
    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(
        await workspace({ ...HEALTHY, [deep]: '# deep\n\n```bash\nnpm run ghost\n```' }),
      ),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([nodeAdapter]),
    });

    // collectDocuments walks docs/ with maxDepth 3; this file sits below that.
    // Silently omitting it would hide the `npm run ghost` drift.
    expect(statusOf(report, 'node/docs-script-drift')).toBe('inconclusive');
    expect(report.readiness).toBe('INCOMPLETE');
  });
});
