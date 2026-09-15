import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  CONFIG_FILE_NAME,
  NodeWorkspaceFs,
  loadConfig,
  runDiagnosis,
  type Report,
} from '@setupguard/core';
import { stubEnvironment } from '@setupguard/testing';
import { CONFIG_CHECK_ID, DIAGNOSTIC_SEVERITY, toConfigDiagnostics, toDiagnostics } from 'setupguard';

/**
 * A broken `.setupguard.yml` has to reach the Problems panel, point at the
 * configuration file, and never be mistaken for a defect in the project.
 */

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function reportWithConfig(body: string): Promise<Report> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-vsc-'));
  created.push(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  await fs.writeFile(path.join(root, CONFIG_FILE_NAME), body);

  const workspace = new NodeWorkspaceFs(root);
  const registry = new AdapterRegistry([nodeAdapter]);
  const config = await loadConfig({
    fs: workspace,
    knownCheckIds: registry.list().flatMap((adapter) => adapter.checks.map((check) => check.id)),
  });

  return runDiagnosis({ fs: workspace, environment: stubEnvironment(), registry, config });
}

describe('toConfigDiagnostics', () => {
  it('produces nothing when the configuration is fine', async () => {
    const report = await reportWithConfig('version: 1\n');
    expect(report.config.valid).toBe(true);
    expect(toConfigDiagnostics(report)).toEqual([]);
  });

  it('places a diagnostic on the configuration file, at its position', async () => {
    const report = await reportWithConfig('version: 1\ncheks:\n  a: b\n');
    const [diagnostic] = toConfigDiagnostics(report);

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.file).toBe(CONFIG_FILE_NAME);
    expect(diagnostic?.checkId).toBe(CONFIG_CHECK_ID);
    expect(diagnostic?.source).toBe('SetupGuard');
    expect(diagnostic?.code.startsWith('config/')).toBe(true);
    // 1-based in the report, 0-based in the editor.
    expect(diagnostic?.range.start.line).toBe(1);
  });

  it('reports configuration problems as errors, because the run fell back', async () => {
    const report = await reportWithConfig('version: 2\n');
    expect(report.readiness).toBe('INCOMPLETE');

    for (const diagnostic of toConfigDiagnostics(report)) {
      expect(diagnostic.severity).toBe(DIAGNOSTIC_SEVERITY.Error);
    }
  });

  it('keeps configuration problems out of the project findings', async () => {
    const report = await reportWithConfig('version: 1\nignore:\n  - ../escape\n');

    const config = toConfigDiagnostics(report);
    expect(config.length).toBeGreaterThan(0);

    const project = toDiagnostics(report).diagnostics;
    expect(project.some((diagnostic) => diagnostic.code.startsWith('config/'))).toBe(false);
    expect(project.some((diagnostic) => diagnostic.file === CONFIG_FILE_NAME)).toBe(false);
  });

  it('carries the remediation into the message', async () => {
    const report = await reportWithConfig('version: 1\ncheks:\n  a: b\n');
    const [diagnostic] = toConfigDiagnostics(report);
    expect(diagnostic?.message).toContain('cheks');
  });
});
