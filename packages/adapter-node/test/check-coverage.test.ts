import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeWorkspaceFs,
  allFindings,
  runDiagnosis,
  type Report,
  type VerificationLevel,
} from '@setupguard/core';
import { fixture, stubEnvironment } from '@setupguard/testing';

/**
 * One case per finding code that no other suite asserts.
 *
 * A code with no test is a code nobody has seen fire since it was written; the
 * QA that prompted this file found seven of them, including
 * `node/node-version-mismatch`, which is the only finding the real CLI produced
 * against the "healthy" fixtures.
 */

const created: string[] = [];

interface Options {
  readonly nodeVersion?: string;
  readonly binaries?: Readonly<Record<string, string>>;
  readonly levels?: readonly VerificationLevel[];
  readonly maxFileBytes?: number;
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-cov-'));
  created.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function diagnose(root: string, options: Options = {}): Promise<Report> {
  return runDiagnosis({
    fs: new NodeWorkspaceFs(root, options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {}),
    environment: stubEnvironment({
      ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
      ...(options.binaries ? { binaries: options.binaries } : {}),
    }),
    registry: new AdapterRegistry([nodeAdapter]),
    ...(options.levels ? { levels: options.levels } : {}),
  });
}

function codes(report: Report): string[] {
  return allFindings(report).map((finding) => finding.code);
}

const LOCK = '{"lockfileVersion":3}';

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('finding codes with no other coverage', () => {
  it('node/node-version-mismatch', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=22' }, scripts: { b: 'tsc' } }),
      'package-lock.json': LOCK,
    });

    const report = await diagnose(root, { nodeVersion: '20.11.0' });
    const finding = allFindings(report).find((f) => f.code === 'node/node-version-mismatch');

    expect(finding).toMatchObject({ severity: 'error', confidence: 'high' });
    expect(finding?.message).toContain('20.11.0');
    expect(report.readiness).toBe('BLOCKED');
  });

  it('node/node-version-mismatch tolerates a prerelease inside the range', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { b: 'tsc' } }),
      'package-lock.json': LOCK,
    });

    // A release-candidate runtime is inside `>=20`; semver excludes prereleases
    // by default, which would report a false mismatch.
    expect(codes(await diagnose(root, { nodeVersion: '25.0.0-rc.1' }))).not.toContain(
      'node/node-version-mismatch',
    );
  });

  it('node/node-version-unresolvable', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', scripts: { b: 'tsc' } }),
      'package-lock.json': LOCK,
      '.nvmrc': 'lts/iron\n',
    });

    const finding = allFindings(await diagnose(root)).find(
      (f) => f.code === 'node/node-version-unresolvable',
    );
    expect(finding).toMatchObject({ severity: 'warning' });
    expect(finding?.message).toContain('.nvmrc');
  });

  it('node/scripts-absent', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' } }),
      'package-lock.json': LOCK,
    });

    expect(codes(await diagnose(root))).toContain('node/scripts-absent');
  });

  it('node/env-example-missing', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { b: 'tsc' } }),
      'package-lock.json': LOCK,
      'src/a.js': 'export const u = process.env.SERVICE_URL;\n',
    });

    const finding = allFindings(await diagnose(root)).find(
      (f) => f.code === 'node/env-example-missing',
    );
    expect(finding).toMatchObject({ severity: 'warning', confidence: 'medium' });
  });

  it('node/package-json-not-an-object', async () => {
    const root = await workspace({ 'package.json': '[1, 2, 3]', 'package-lock.json': LOCK });

    const report = await diagnose(root);
    expect(codes(report)).toContain('node/package-json-not-an-object');
    expect(report.readiness).toBe('BLOCKED');
  });

  it('node/package-json-invalid reports a position, never the file contents', async () => {
    const root = await workspace({
      'package.json': '{\n  "name": "x"\n  "missing": "comma"\n}',
      'package-lock.json': LOCK,
    });

    const finding = allFindings(await diagnose(root)).find(
      (f) => f.code === 'node/package-json-invalid',
    );
    expect(finding?.actual).toMatch(/invalid JSON/);
    expect(finding?.actual).not.toContain('missing');
  });

  it('node/package-json-unreadable', async () => {
    const root = await workspace({
      'package.json': 'x'.repeat(4096),
      'package-lock.json': LOCK,
    });

    const report = await diagnose(root, { maxFileBytes: 1024 });
    expect(codes(report)).toContain('node/package-json-unreadable');
    // Unreadable is SetupGuard's limit, not a proven defect in the project.
    expect(report.readiness).toBe('INCOMPLETE');
  });

  it('node/multiple-lockfiles fires only for genuinely different managers', async () => {
    const manifest = JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { b: 'tsc' } });

    // Two npm lockfiles are a legal npm layout, not a conflict.
    const sameManager = await workspace({
      'package.json': manifest,
      'package-lock.json': LOCK,
      'npm-shrinkwrap.json': LOCK,
    });
    expect(codes(await diagnose(sameManager))).not.toContain('node/multiple-lockfiles');

    // Both Bun formats are still just Bun.
    const bothBunFormats = await workspace({
      'package.json': manifest,
      'bun.lock': '{}',
      'bun.lockb': '',
    });
    expect(codes(await diagnose(bothBunFormats, { binaries: { bun: '/usr/bin/bun' } }))).not.toContain(
      'node/multiple-lockfiles',
    );

    // npm and pnpm together genuinely is ambiguous.
    const twoManagers = await workspace({
      'package.json': manifest,
      'package-lock.json': LOCK,
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
    });
    const finding = allFindings(await diagnose(twoManagers)).find(
      (f) => f.code === 'node/multiple-lockfiles',
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('npm');
    expect(finding?.message).toContain('pnpm');
    // The old message claimed the files belonged to different managers even
    // when they did not; the wording has to stay factual.
    expect(finding?.message).toMatch(/different package managers/);
  });
});

describe('monorepo-scripts fixture', () => {
  it('never resolves another workspace’s script against the root manifest', async () => {
    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('monorepo-scripts')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([nodeAdapter]),
    });

    // The root declares none of `build`; `api` and `web` do. Resolving those
    // references against the root produced a confident, blocking, wrong finding.
    expect(codes(report)).not.toContain('node/script-reference-missing');
    expect(codes(report)).not.toContain('node/docs-script-not-found');
    expect(report.readiness).toBe('READY');
  });

  it('keeps the nested packages outside the root source scan', async () => {
    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('monorepo-scripts')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([nodeAdapter]),
    });

    // packages/api reads API_ONLY_TOKEN; the root is not responsible for it.
    expect(codes(report)).not.toContain('node/env-example-missing');
  });
});
