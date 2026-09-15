import { describe, expect, it } from 'vitest';

import { nodeAdapter } from '@setupguard/adapter-node';
import { AdapterRegistry, NodeWorkspaceFs, runDiagnosis, type Report } from '@setupguard/core';
import { fixture, stubEnvironment } from '@setupguard/testing';
import { DIAGNOSTIC_SEVERITY, toDiagnostics } from 'setupguard';

async function reportFor(name: string): Promise<Report> {
  return runDiagnosis({
    fs: new NodeWorkspaceFs(fixture(name)),
    environment: stubEnvironment(),
    registry: new AdapterRegistry([nodeAdapter]),
  });
}

describe('toDiagnostics', () => {
  it('produces one 0-based diagnostic per located finding', async () => {
    const { diagnostics, unplaced } = toDiagnostics(await reportFor('docs-drift-project'));

    expect(unplaced).toEqual([]);
    const drift = diagnostics.filter((diagnostic) => diagnostic.code === 'node/docs-script-not-found');
    expect(drift).toHaveLength(2);

    expect(drift[0]).toMatchObject({
      file: 'README.md',
      severity: DIAGNOSTIC_SEVERITY.Error,
      source: 'SetupGuard',
      checkId: 'node/docs-script-drift',
    });
    // SetupGuard reports README.md line 12 (1-based); the editor wants line 11.
    expect(drift[0]?.range.start).toEqual({ line: 11, character: 0 });
  });

  it('maps severities onto the editor scale', async () => {
    const { diagnostics } = toDiagnostics(await reportFor('broken-node-project'));
    const severities = new Set(diagnostics.map((diagnostic) => diagnostic.severity));

    expect(severities.has(DIAGNOSTIC_SEVERITY.Error)).toBe(true);
    expect(severities.has(DIAGNOSTIC_SEVERITY.Warning)).toBe(true);
  });

  it('includes the expectation gap in the message', async () => {
    const { diagnostics } = toDiagnostics(await reportFor('docs-drift-project'));
    const message = diagnostics[0]?.message ?? '';

    expect(message).toContain('pnpm start');
    expect(message).toContain('Expected:');
    expect(message).toContain('Found:');
  });

  it('anchors a file-only finding at the start of the file', async () => {
    const { diagnostics } = toDiagnostics(await reportFor('no-package-json'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: 'package.json',
      severity: DIAGNOSTIC_SEVERITY.Error,
      range: { start: { line: 0, character: 0 } },
    });
  });

  it('produces nothing for a healthy project', async () => {
    const { diagnostics, unplaced } = toDiagnostics(await reportFor('healthy-npm'));

    expect(diagnostics).toEqual([]);
    expect(unplaced).toEqual([]);
  });
});
