import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeWorkspaceFs,
  REPORT_SCHEMA_VERSION,
  loadConfig,
  runDiagnosis,
  type Readiness,
  type Report,
  type ReportSummary,
} from '@setupguard/core';
import { fixture, stubEnvironment } from '@setupguard/testing';

/**
 * Report builders for the editor layer's tests.
 *
 * `reportFor` runs the real engine on a real fixture, which is what the
 * extension actually shows. `syntheticReport` exists only for states a fixture
 * cannot produce on demand — an internal error, a specific summary — and never
 * replaces a real run where one is available.
 */

export async function reportFor(name: string): Promise<Report> {
  const fs = new NodeWorkspaceFs(fixture(name));
  const registry = new AdapterRegistry([nodeAdapter]);
  const config = await loadConfig({
    fs,
    knownCheckIds: registry.list().flatMap((adapter) => adapter.checks.map((check) => check.id)),
  });

  return runDiagnosis({ fs, environment: stubEnvironment(), registry, config });
}

const EMPTY_SUMMARY: ReportSummary = {
  errors: 0,
  warnings: 0,
  infos: 0,
  passed: 0,
  skipped: 0,
  notApplicable: 0,
  inconclusive: 0,
  internalErrors: 0,
  conclusive: 0,
};

export function syntheticReport(
  readiness: Readiness,
  overrides: Partial<Report> = {},
): Report {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    root: '/workspace',
    readiness,
    levelsRequested: ['static', 'environment'],
    adapters: [],
    results: [],
    summary: EMPTY_SUMMARY,
    config: { source: undefined, valid: true, diagnostics: [] },
    hasInternalErrors: false,
    durationMs: 1,
    ...overrides,
  };
}

export function summaryOf(overrides: Partial<ReportSummary>): ReportSummary {
  return { ...EMPTY_SUMMARY, ...overrides };
}
