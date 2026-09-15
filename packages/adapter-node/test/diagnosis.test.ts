import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectNodeFacts, nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeEnvironmentProbe,
  NodeWorkspaceFs,
  allFindings,
  reportToJson,
  runDiagnosis,
  type EnvironmentProbe,
  type Report,
  type VerificationLevel,
} from '@setupguard/core';
import { discoveryContext, fixture, stubEnvironment } from '@setupguard/testing';

interface DiagnoseOptions {
  readonly environment?: EnvironmentProbe;
  readonly levels?: readonly VerificationLevel[];
}

async function diagnose(name: string, options: DiagnoseOptions = {}): Promise<Report> {
  return runDiagnosis({
    fs: new NodeWorkspaceFs(fixture(name)),
    environment: options.environment ?? stubEnvironment(),
    registry: new AdapterRegistry([nodeAdapter]),
    ...(options.levels ? { levels: options.levels } : {}),
  });
}

function codes(report: Report): string[] {
  return allFindings(report).map((finding) => finding.code);
}

function statusOf(report: Report, checkId: string): string | undefined {
  return report.results.find((result) => result.checkId === checkId)?.status;
}

describe('healthy fixtures', () => {
  it('reports READY for a consistent npm project', async () => {
    const report = await diagnose('healthy-npm');

    expect(codes(report)).toEqual([]);
    expect(report.readiness).toBe('READY');
    expect(report.hasInternalErrors).toBe(false);
    expect(report.adapters).toEqual([{ id: 'node', name: 'Node.js', detected: true }]);
  });

  it('reports READY for a consistent pnpm project', async () => {
    const report = await diagnose('healthy-pnpm');

    expect(codes(report)).toEqual([]);
    expect(report.readiness).toBe('READY');
  });

  it('runs only the requested levels', async () => {
    const report = await diagnose('healthy-npm', { levels: ['static'] });

    expect(statusOf(report, 'node/node-version-runtime')).toBe('skipped');
    expect(statusOf(report, 'node/package-manager-available')).toBe('skipped');
    expect(statusOf(report, 'node/package-json')).toBe('pass');
    expect(report.levelsRequested).toEqual(['static']);
  });

  it('works with the real environment probe at the static level', async () => {
    const report = await diagnose('healthy-npm', {
      environment: new NodeEnvironmentProbe(),
      levels: ['static'],
    });

    expect(report.readiness).toBe('READY');
    expect(report.hasInternalErrors).toBe(false);
  });
});

describe('broken-node-project', () => {
  it('finds every planted defect and blocks', async () => {
    const report = await diagnose('broken-node-project');

    expect(report.readiness).toBe('BLOCKED');
    expect(new Set(codes(report))).toEqual(
      new Set([
        'node/package-manager-lockfile-mismatch',
        'node/node-version-declaration-conflict',
        'node/script-empty',
        'node/script-reference-missing',
        'node/env-var-undocumented',
        'node/env-file-missing',
        'node/docs-script-not-found',
      ]),
    );
  });

  it('cannot verify the runtime while declarations contradict each other', async () => {
    const report = await diagnose('broken-node-project');
    const runtime = report.results.find((result) => result.checkId === 'node/node-version-runtime');

    expect(runtime?.status).toBe('inconclusive');
    expect(runtime?.reason).toMatch(/conflicting/);
  });

  it('points documentation findings at the exact line', async () => {
    const report = await diagnose('broken-node-project');
    const drift = allFindings(report).filter((finding) => finding.code === 'node/docs-script-not-found');

    expect(drift.map((finding) => finding.evidence[0]?.file)).toEqual(['README.md', 'README.md', 'README.md']);
    expect(drift.map((finding) => finding.evidence[0]?.line)).toEqual([7, 10, 16]);
    expect(drift.map((finding) => finding.severity)).toEqual(['warning', 'error', 'error']);
  });

  it('locates manifest findings inside package.json', async () => {
    const report = await diagnose('broken-node-project');
    const missing = allFindings(report).find(
      (finding) => finding.code === 'node/script-reference-missing',
    );

    expect(missing?.evidence[0]).toMatchObject({ file: 'package.json', line: 12 });
    expect(missing?.severity).toBe('error');
  });

  it('reports the package manager as unavailable when it is not on PATH', async () => {
    const report = await diagnose('broken-node-project', {
      environment: stubEnvironment({ binaries: {} }),
    });

    expect(codes(report)).toContain('node/package-manager-unavailable');
  });
});

describe('docs-drift-project', () => {
  it('blocks on a README command that no longer exists', async () => {
    const report = await diagnose('docs-drift-project');
    const drift = allFindings(report).filter((finding) => finding.code === 'node/docs-script-not-found');

    expect(report.readiness).toBe('BLOCKED');
    expect(drift).toHaveLength(2);

    // `pnpm start` is an npm lifecycle shortcut, so it is an unambiguous
    // script reference: high confidence, blocking.
    expect(drift[0]).toMatchObject({ severity: 'error', confidence: 'high' });
    expect(drift[0]?.message).toContain('pnpm start');
    expect(drift[0]?.evidence[0]).toMatchObject({ file: 'README.md', line: 12 });

    // `pnpm dev` uses the implicit form, which could also be an unknown
    // sub-command, so it only warns — and it suggests the closest script.
    expect(drift[1]).toMatchObject({ severity: 'warning', confidence: 'medium' });
    expect(drift[1]?.expected).toContain('web');
    expect(drift[1]?.evidence[0]).toMatchObject({ file: 'README.md', line: 15 });
  });
});

describe('no-package-json', () => {
  it('detects the project from the lockfile and blocks on the missing manifest', async () => {
    const report = await diagnose('no-package-json');

    expect(report.adapters[0]?.detected).toBe(true);
    expect(codes(report)).toEqual(['node/package-json-missing']);
    expect(report.readiness).toBe('BLOCKED');
    expect(statusOf(report, 'node/package-manager')).toBe('not-applicable');
    expect(statusOf(report, 'node/docs-script-drift')).toBe('not-applicable');
  });
});

describe('warnings-only', () => {
  it('warns about the missing lockfile and undeclared runtime without blocking', async () => {
    const report = await diagnose('warnings-only');

    expect(new Set(codes(report))).toEqual(
      new Set(['node/lockfile-missing', 'node/node-version-undeclared']),
    );
    expect(report.readiness).toBe('WARNINGS');
  });
});

describe('empty-dir', () => {
  it('reports INCOMPLETE rather than a clean pass when nothing was analysed', async () => {
    const report = await diagnose('empty-dir');

    expect(report.adapters).toEqual([{ id: 'node', name: 'Node.js', detected: false }]);
    expect(report.results).toEqual([]);
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toMatch(/no supported project was detected/i);
  });
});

describe('requesting a level with no checks', () => {
  it('does not validate readiness on a level that verified nothing', async () => {
    const report = await diagnose('broken-node-project', { levels: ['connectivity'] });

    expect(report.results.every((result) => result.status === 'skipped')).toBe(true);
    expect(report.summary.conclusive).toBe(0);
    expect(report.readiness).toBe('INCOMPLETE');
  });
});

describe('unreadable sources', () => {
  it('reports inconclusive instead of inventing a clean result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-unreadable-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'x', scripts: { start: 'node .' } }),
      );
      await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      // Larger than the reader's limit, so .nvmrc cannot be read at all.
      await fs.writeFile(path.join(root, '.nvmrc'), 'x'.repeat(4096));

      const report = await runDiagnosis({
        fs: new NodeWorkspaceFs(root, { maxFileBytes: 1024 }),
        environment: stubEnvironment(),
        registry: new AdapterRegistry([nodeAdapter]),
      });

      const declaration = report.results.find(
        (result) => result.checkId === 'node/node-version-declaration',
      );

      // The old behaviour turned an unreadable file into "no version declared",
      // which is a statement about the project that was never verified.
      expect(declaration?.status).toBe('inconclusive');
      expect(declaration?.reason).toMatch(/could not be read/);
      expect(codes(report)).not.toContain('node/node-version-undeclared');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('monorepo-root', () => {
  it('stops source inference at a nested project boundary', async () => {
    const report = await diagnose('monorepo-root');

    // API_ONLY_SENTRY_DSN is read by packages/api, which is its own project;
    // the root .env.example is not expected to document it.
    expect(codes(report)).toEqual([]);
    expect(report.readiness).toBe('READY');
  });

  it('records the nested project directories it found', async () => {
    const facts = await collectNodeFacts(
      discoveryContext(new NodeWorkspaceFs(fixture('monorepo-root'))),
    );

    expect(facts.nestedProjectDirs).toEqual(['packages/api/']);
    expect(facts.envUsages.map((usage) => usage.name)).toEqual(['ROOT_TOKEN']);
  });
});

describe('secret handling', () => {
  it('never puts an environment value in the report', async () => {
    const report = await diagnose('secret-env');
    const serialized = reportToJson(report);

    expect(serialized).not.toContain('QA-FAKE-CREDENTIAL-0003');
    expect(serialized).not.toContain('QA-FAKE-CREDENTIAL-0002');
    // The variable names themselves are still reported, which is the point.
    expect(serialized).toContain('STRIPE_SECRET_KEY');
  });

  it('flags the documented variable that is missing locally as a blocker', async () => {
    const report = await diagnose('secret-env');
    const missing = allFindings(report).find((finding) => finding.code === 'node/env-var-missing');

    expect(missing).toMatchObject({ severity: 'error', confidence: 'high' });
    expect(missing?.message).toContain('STRIPE_SECRET_KEY');
  });
});
