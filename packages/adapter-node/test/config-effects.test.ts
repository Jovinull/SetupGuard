import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeWorkspaceFs,
  allFindings,
  loadConfig,
  runDiagnosis,
  type Finding,
  type Report,
} from '@setupguard/core';
import { fixture, stubEnvironment } from '@setupguard/testing';

/**
 * What the configuration actually changes about a diagnosis.
 *
 * Every case runs the same workspace twice — once with the file and once
 * without — because the contract that matters most is the second one: a
 * repository with no `.setupguard.yml` must behave exactly as it did before
 * this feature existed.
 */

const created: string[] = [];
const KNOWN_CHECK_IDS = nodeAdapter.checks.map((check) => check.id);

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-cfg-'));
  created.push(root);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  return root;
}

async function diagnose(root: string): Promise<Report> {
  const wfs = new NodeWorkspaceFs(root);
  const config = await loadConfig({ fs: wfs, knownCheckIds: KNOWN_CHECK_IDS });
  return runDiagnosis({
    fs: wfs,
    environment: stubEnvironment(),
    registry: new AdapterRegistry([nodeAdapter]),
    config,
  });
}

function codes(report: Report): string[] {
  return allFindings(report).map((finding) => finding.code);
}

function findingFor(report: Report, code: string): Finding | undefined {
  return allFindings(report).find((finding) => finding.code === code);
}

/** A project whose README names a script that does not exist: an `error` by default. */
const DRIFTING = {
  'package.json': JSON.stringify({
    name: 'x',
    engines: { node: '>=20' },
    scripts: { build: 'tsc' },
  }),
  'package-lock.json': '{"lockfileVersion":3}',
  'README.md': '# x\n\n```bash\nnpm run ghost\n```\n',
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('no configuration means no change', () => {
  it('produces the same result as before the feature existed', async () => {
    const report = await diagnose(await workspace(DRIFTING));

    expect(codes(report)).toEqual(['node/docs-script-not-found']);
    expect(findingFor(report, 'node/docs-script-not-found')?.severity).toBe('error');
    expect(report.readiness).toBe('BLOCKED');
    expect(report.config).toEqual({ valid: true, diagnostics: [] });
  });

  it('is also unchanged by a file that only declares its version', async () => {
    const report = await diagnose(await workspace({ ...DRIFTING, '.setupguard.yml': 'version: 1\n' }));

    expect(codes(report)).toEqual(['node/docs-script-not-found']);
    expect(findingFor(report, 'node/docs-script-not-found')?.severity).toBe('error');
    expect(report.readiness).toBe('BLOCKED');
  });
});

describe('checks.<id>.severity', () => {
  it('downgrades error to warning', async () => {
    const report = await diagnose(
      await workspace({
        ...DRIFTING,
        '.setupguard.yml': 'version: 1\nchecks:\n  node/docs-script-drift:\n    severity: warning\n',
      }),
    );

    expect(findingFor(report, 'node/docs-script-not-found')?.severity).toBe('warning');
    // The status of the check follows the re-levelled findings.
    expect(report.results.find((r) => r.checkId === 'node/docs-script-drift')?.status).toBe('warning');
    expect(report.readiness).toBe('WARNINGS');
  });

  it('upgrades warning to error', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { b: 'tsc' } }),
      '.setupguard.yml': 'version: 1\nchecks:\n  node/package-manager:\n    severity: error\n',
    });

    const report = await diagnose(root);

    // node/lockfile-missing is a warning by default.
    expect(findingFor(report, 'node/lockfile-missing')?.severity).toBe('error');
    expect(report.readiness).toBe('BLOCKED');
  });

  it('off stops the check from running at all', async () => {
    const report = await diagnose(
      await workspace({
        ...DRIFTING,
        '.setupguard.yml': 'version: 1\nchecks:\n  node/docs-script-drift:\n    severity: off\n',
      }),
    );

    const result = report.results.find((r) => r.checkId === 'node/docs-script-drift');
    expect(result?.status).toBe('skipped');
    expect(result?.reason).toContain('Disabled by');
    expect(codes(report)).toEqual([]);
    // Other checks still concluded, so the project is genuinely READY.
    expect(report.readiness).toBe('READY');
  });

  it('leaves every other check untouched', async () => {
    const root = await workspace({
      ...DRIFTING,
      '.setupguard.yml': 'version: 1\nchecks:\n  node/docs-script-drift:\n    severity: off\n',
    });
    const withConfig = await diagnose(root);
    await fs.rm(path.join(root, '.setupguard.yml'));
    const without = await diagnose(root);

    const unaffected = (report: Report) =>
      report.results.filter((r) => r.checkId !== 'node/docs-script-drift').map((r) => r.status);

    expect(unaffected(withConfig)).toEqual(unaffected(without));
  });

  it('cannot turn an internal state into a project finding', async () => {
    // `.nvmrc` is unreadable, so node/node-version-declaration is inconclusive.
    // An override must not promote that into an error about the project.
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'x', scripts: { b: 'tsc' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      '.nvmrc': 'x'.repeat(4096),
      '.setupguard.yml': 'version: 1\nchecks:\n  node/node-version-declaration:\n    severity: error\n',
    });

    const wfs = new NodeWorkspaceFs(root, { maxFileBytes: 1024 });
    const config = await loadConfig({ fs: wfs, knownCheckIds: KNOWN_CHECK_IDS });
    const report = await runDiagnosis({
      fs: wfs,
      environment: stubEnvironment(),
      registry: new AdapterRegistry([nodeAdapter]),
      config,
    });

    const result = report.results.find((r) => r.checkId === 'node/node-version-declaration');
    expect(result?.status).toBe('inconclusive');
    expect(result?.findings).toEqual([]);
    expect(report.readiness).toBe('INCOMPLETE');
  });
});

describe('env.optional', () => {
  const USING_OPTIONAL = {
    'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { b: 'tsc' } }),
    'package-lock.json': '{"lockfileVersion":3}',
    '.env.example': 'DATABASE_URL=\nSENTRY_DSN=\n',
    '.env': 'DATABASE_URL=postgres://localhost/app\n',
    'src/a.js': 'export const s = process.env.SENTRY_DSN;\nexport const d = process.env.DATABASE_URL;\n',
  };

  it('silences the findings a declared-optional variable would produce', async () => {
    const before = await diagnose(await workspace(USING_OPTIONAL));
    expect(codes(before)).toContain('node/env-var-missing');

    const after = await diagnose(
      await workspace({
        ...USING_OPTIONAL,
        '.setupguard.yml': 'version: 1\nenv:\n  optional:\n    - SENTRY_DSN\n',
      }),
    );
    expect(codes(after)).toEqual([]);
    expect(after.readiness).toBe('READY');
  });

  it('silences an undocumented variable too', async () => {
    const files = {
      ...USING_OPTIONAL,
      '.env.example': 'DATABASE_URL=\n',
      'src/a.js': 'export const a = process.env.ANALYTICS_KEY;\nexport const d = process.env.DATABASE_URL;\n',
    };
    expect(codes(await diagnose(await workspace(files)))).toContain('node/env-var-undocumented');

    const after = await diagnose(
      await workspace({
        ...files,
        '.setupguard.yml': 'version: 1\nenv:\n  optional:\n    - ANALYTICS_KEY\n',
      }),
    );
    expect(codes(after)).toEqual([]);
  });

  it('accepts a name the project never uses without complaining', async () => {
    const report = await diagnose(
      await workspace({
        ...USING_OPTIONAL,
        '.setupguard.yml': 'version: 1\nenv:\n  optional:\n    - SENTRY_DSN\n    - NEVER_REFERENCED\n',
      }),
    );

    // Listing a variable that is not used is harmless: it is a statement about
    // intent, and flagging it would punish the very people being careful.
    expect(report.config.valid).toBe(true);
    expect(codes(report)).toEqual([]);
  });

  it('never gains access to the value of an optional variable', async () => {
    const report = await diagnose(
      await workspace({
        ...USING_OPTIONAL,
        '.env': 'DATABASE_URL=postgres://localhost/app\nSENTRY_DSN=QA-FAKE-OPTIONAL-SECRET\n',
        '.setupguard.yml': 'version: 1\nenv:\n  optional:\n    - SENTRY_DSN\n',
      }),
    );

    expect(JSON.stringify(report)).not.toContain('QA-FAKE-OPTIONAL-SECRET');
  });
});

describe('ignore narrows the auxiliary scans', () => {
  it('excludes source files from the environment scan', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { b: 'tsc' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      '.env.example': '',
      'examples/demo.js': 'export const x = process.env.EXAMPLE_ONLY;\n',
    };
    expect(codes(await diagnose(await workspace(files)))).toContain('node/env-var-undocumented');

    const after = await diagnose(
      await workspace({ ...files, '.setupguard.yml': 'version: 1\nignore:\n  - examples/**\n' }),
    );
    expect(codes(after)).toEqual([]);
  });

  it('excludes documentation from the drift scan', async () => {
    const files = {
      ...DRIFTING,
      'README.md': '# x\n',
      'docs/generated/api.md': '# gen\n\n```bash\nnpm run generated-ghost\n```\n',
    };
    expect(codes(await diagnose(await workspace(files)))).toContain('node/docs-script-not-found');

    const after = await diagnose(
      await workspace({ ...files, '.setupguard.yml': 'version: 1\nignore:\n  - docs/generated/**\n' }),
    );
    expect(codes(after)).toEqual([]);
  });
});

describe('a broken configuration is never a verdict on the project', () => {
  it('reports INCOMPLETE and runs with defaults', async () => {
    const report = await diagnose(
      await workspace({ ...DRIFTING, '.setupguard.yml': 'version: 99\n' }),
    );

    expect(report.config.valid).toBe(false);
    expect(report.config.diagnostics[0]?.code).toBe('config/version-unsupported');
    // Not BLOCKED, even though the default run found a blocking drift: the
    // diagnosis the repository asked for did not happen.
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toMatch(/could not be applied/);
    // The findings are still there, produced with default settings.
    expect(codes(report)).toContain('node/docs-script-not-found');
  });
});

describe('configured-project fixture', () => {
  it('applies severity, env.optional and ignore together', async () => {
    const wfs = new NodeWorkspaceFs(fixture('configured-project'));
    const config = await loadConfig({ fs: wfs, knownCheckIds: KNOWN_CHECK_IDS });
    const report = await runDiagnosis({
      fs: wfs,
      environment: stubEnvironment(),
      registry: new AdapterRegistry([nodeAdapter]),
      config,
    });

    expect(config.valid).toBe(true);
    // Downgraded by configuration.
    expect(findingFor(report, 'node/docs-script-not-found')?.severity).toBe('warning');
    // SENTRY_DSN missing locally and ANALYTICS_KEY undocumented: both optional.
    expect(codes(report)).not.toContain('node/env-var-missing');
    expect(codes(report)).not.toContain('node/env-var-undocumented');
    // examples/ and docs/generated/ never reached a scanner.
    expect(JSON.stringify(report)).not.toContain('EXAMPLE_ONLY_VARIABLE');
    expect(JSON.stringify(report)).not.toContain('generated-ghost');
    expect(report.readiness).toBe('WARNINGS');
  });
});
