import { describe, expect, it } from 'vitest';

import {
  AdapterRegistry,
  NodeWorkspaceFs,
  found,
  inconclusive,
  notApplicable,
  pass,
  runDiagnosis,
  type Adapter,
  type Check,
} from '@setupguard/core';
import { fixture, stubEnvironment } from '@setupguard/testing';

interface Facts {
  readonly value: number;
}

function adapterWith(checks: readonly Check<Facts>[], id = 'demo'): Adapter<Facts> {
  return {
    id,
    name: 'Demo',
    detect: () => Promise.resolve(true),
    collect: () => Promise.resolve({ value: 1 }),
    checks,
  };
}

function check(overrides: Partial<Check<Facts>> & Pick<Check<Facts>, 'id' | 'run'>): Check<Facts> {
  return {
    title: overrides.id,
    category: 'project',
    level: 'static',
    safety: 'read-only',
    applies: () => true,
    ...overrides,
  };
}

async function run(adapter: Adapter<Facts>, levels?: Parameters<typeof runDiagnosis>[0]['levels']) {
  return runDiagnosis({
    fs: new NodeWorkspaceFs(fixture('empty-dir')),
    environment: stubEnvironment(),
    registry: new AdapterRegistry([adapter]),
    ...(levels ? { levels } : {}),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

describe('runDiagnosis', () => {
  it('aggregates READY when nothing is found', async () => {
    const report = await run(adapterWith([check({ id: 'demo/ok', run: () => pass() })]));

    expect(report.readiness).toBe('READY');
    expect(report.results[0]?.status).toBe('pass');
    expect(report.summary.passed).toBe(1);
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.schemaVersion).toBe(1);
  });

  it('aggregates WARNINGS when only warnings are found', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/warn',
          run: () =>
            found([
              { code: 'demo/w', severity: 'warning', confidence: 'medium', message: 'careful' },
            ]),
        }),
      ]),
    );

    expect(report.readiness).toBe('WARNINGS');
    expect(report.summary).toMatchObject({ warnings: 1, errors: 0 });
  });

  it('aggregates BLOCKED when any error is found', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/warn',
          run: () =>
            found([
              { code: 'demo/w', severity: 'warning', confidence: 'medium', message: 'careful' },
            ]),
        }),
        check({
          id: 'demo/fail',
          run: () =>
            found([{ code: 'demo/e', severity: 'error', confidence: 'high', message: 'broken' }]),
        }),
      ]),
    );

    expect(report.readiness).toBe('BLOCKED');
    expect(report.summary).toMatchObject({ errors: 1, warnings: 1 });
  });

  it('stamps the check id on every finding', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/fail',
          run: () =>
            found([{ code: 'demo/e', severity: 'error', confidence: 'high', message: 'broken' }]),
        }),
      ]),
    );

    expect(report.results[0]?.findings[0]?.checkId).toBe('demo/fail');
    expect(report.results[0]?.findings[0]?.evidence).toEqual([]);
  });

  it('skips checks whose level was not requested', async () => {
    const report = await run(
      adapterWith([check({ id: 'demo/env', level: 'environment', run: () => pass() })]),
      ['static'],
    );

    expect(report.results[0]?.status).toBe('skipped');
    expect(report.results[0]?.reason).toContain('environment');
    // Nothing was actually verified, so this must not read as success.
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toMatch(/No check reached a conclusion/);
  });

  it('never runs a side-effecting check without authorisation', async () => {
    let ran = false;
    const report = await run(
      adapterWith([
        check({
          id: 'demo/build',
          safety: 'side-effects',
          run: () => {
            ran = true;
            return pass();
          },
        }),
      ]),
    );

    expect(ran).toBe(false);
    expect(report.results[0]?.status).toBe('skipped');
    expect(report.results[0]?.reason).toContain('side effects');
  });

  it('records not-applicable and inconclusive without affecting readiness', async () => {
    const report = await run(
      adapterWith([
        check({ id: 'demo/na', applies: () => false, run: () => pass() }),
        check({ id: 'demo/unknown', run: () => inconclusive('cannot tell') }),
        check({ id: 'demo/na2', run: () => notApplicable('nothing to do') }),
      ]),
    );

    expect(report.results.map((result) => result.status)).toEqual([
      'not-applicable',
      'inconclusive',
      'not-applicable',
    ]);
    expect(report.summary).toMatchObject({ notApplicable: 2, inconclusive: 1, conclusive: 0 });
    // None of these states says anything about the project, so there is no
    // positive evidence and readiness cannot be READY.
    expect(report.readiness).toBe('INCOMPLETE');
  });

  it('stays READY when a conclusive check sits alongside an inapplicable one', async () => {
    const report = await run(
      adapterWith([
        check({ id: 'demo/ok', run: () => pass() }),
        check({ id: 'demo/na', applies: () => false, run: () => pass() }),
      ]),
    );

    expect(report.readiness).toBe('READY');
    expect(report.summary).toMatchObject({ conclusive: 1, notApplicable: 1 });
    expect(report.incompleteReason).toBeUndefined();
  });

  it('turns a thrown check into an internal error, not a project failure', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/boom',
          run: () => {
            throw new Error('parser exploded');
          },
        }),
      ]),
    );

    expect(report.results[0]?.status).toBe('internal-error');
    expect(report.results[0]?.reason).toContain('parser exploded');
    expect(report.hasInternalErrors).toBe(true);
    // Not BLOCKED: a SetupGuard bug is not evidence the project is broken.
    // Not READY either: nothing was verified.
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.summary.errors).toBe(0);
  });

  it('downgrades to INCOMPLETE when one check fails even though others passed', async () => {
    const report = await run(
      adapterWith([
        check({ id: 'demo/ok', run: () => pass() }),
        check({
          id: 'demo/boom',
          run: () => {
            throw new Error('parser exploded');
          },
        }),
      ]),
    );

    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toMatch(/failed inside SetupGuard/);
  });

  it('turns a failing adapter into internal errors for all of its checks', async () => {
    const broken: Adapter<Facts> = {
      id: 'broken',
      name: 'Broken',
      detect: () => Promise.resolve(true),
      collect: () => Promise.reject(new Error('cannot collect')),
      checks: [check({ id: 'broken/a', run: () => pass() }), check({ id: 'broken/b', run: () => pass() })],
    };

    const report = await run(broken);

    expect(report.adapters[0]).toMatchObject({ id: 'broken', detected: false });
    expect(report.results).toHaveLength(2);
    expect(report.results.every((result) => result.status === 'internal-error')).toBe(true);
    expect(report.readiness).toBe('INCOMPLETE');
  });

  it('does not run checks of an undetected adapter', async () => {
    const undetected: Adapter<Facts> = {
      ...adapterWith([check({ id: 'demo/x', run: () => pass() })]),
      detect: () => Promise.resolve(false),
    };

    const report = await run(undetected);

    expect(report.adapters[0]?.detected).toBe(false);
    expect(report.results).toEqual([]);
    // The most dangerous false pass: a mistyped path or an unsupported
    // ecosystem must never look like a clean run.
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toMatch(/no supported project was detected/i);
  });

  it('gives up on a check that exceeds its time budget', async () => {
    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('empty-dir')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([
        adapterWith([
          check({
            id: 'demo/slow',
            run: () => new Promise<never>(() => {}),
          }),
        ]),
      ]),
      checkTimeoutMs: 20,
    });

    expect(report.results[0]?.status).toBe('internal-error');
    expect(report.results[0]?.reason).toContain('budget');
  });
});

describe('cancellation', () => {
  it('signals the check when its budget expires, not just the caller', async () => {
    let aborted = false;

    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('empty-dir')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([
        adapterWith([
          check({
            id: 'demo/slow',
            run: (_facts, context) =>
              new Promise<never>((_resolve, reject) => {
                context.signal.addEventListener('abort', () => {
                  aborted = true;
                  reject(new Error('aborted'));
                });
              }),
          }),
        ]),
      ]),
      checkTimeoutMs: 20,
    });

    // Promise.race alone would abandon the task still running. The signal is
    // what a connectivity or build check will use to release its resources.
    expect(aborted).toBe(true);
    expect(report.results[0]?.status).toBe('internal-error');
    expect(report.results[0]?.reason).toContain('budget');
  });

  it('propagates the caller signal to adapters and checks', async () => {
    const controller = new AbortController();
    let detectSawSignal = false;

    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('empty-dir')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([
        {
          id: 'demo',
          name: 'Demo',
          detect: (context) => {
            detectSawSignal = context.signal.aborted;
            return Promise.resolve(true);
          },
          collect: () => Promise.resolve({ value: 1 }),
          checks: [check({ id: 'demo/ok', run: () => pass() })],
        } satisfies Adapter<Facts>,
      ]),
      signal: controller.signal,
    });

    expect(detectSawSignal).toBe(false);
    expect(report.readiness).toBe('READY');

    controller.abort();
    const aborted = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('empty-dir')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([adapterWith([check({ id: 'demo/ok', run: () => pass() })])]),
      signal: controller.signal,
    });

    expect(aborted.results.every((result) => result.status === 'internal-error')).toBe(true);
    expect(aborted.readiness).toBe('INCOMPLETE');
  });

  it('times out an adapter that never finishes collecting', async () => {
    const report = await runDiagnosis({
      fs: new NodeWorkspaceFs(fixture('empty-dir')),
      environment: stubEnvironment(),
      registry: new AdapterRegistry([
        {
          id: 'slow',
          name: 'Slow',
          detect: () => Promise.resolve(true),
          collect: () => new Promise<Facts>(() => {}),
          checks: [check({ id: 'slow/x', run: () => pass() })],
        } satisfies Adapter<Facts>,
      ]),
      adapterTimeoutMs: 20,
    });

    expect(report.adapters[0]?.error).toContain('discovery budget');
    expect(report.results[0]?.status).toBe('internal-error');
  });
});

describe('redaction', () => {
  it('strips credential-shaped text from every finding field', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/leak',
          run: () =>
            found([
              {
                code: 'demo/leak',
                severity: 'error',
                confidence: 'high',
                message: 'README says TOKEN=sg-live-SECRET-9127 npm run deploy',
                explanation: 'connect with postgres://admin:hunter2@db.internal/app',
                expected: 'API_KEY=expected-secret-value',
                actual: 'Bearer abcdefghijklmnop0123',
                remediation: 'set PASSWORD=another-secret',
                evidence: [{ file: 'README.md', excerpt: 'TOKEN=sg-live-SECRET-9127' }],
              },
            ]),
        }),
      ]),
    );

    const serialized = JSON.stringify(report);
    for (const secret of [
      'sg-live-SECRET-9127',
      'hunter2',
      'expected-secret-value',
      'abcdefghijklmnop0123',
      'another-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // The names survive: they are the useful, non-secret half.
    expect(serialized).toContain('TOKEN=***');
    expect(serialized).toContain('API_KEY=***');
    expect(serialized).toContain('postgres://admin:***@');
  });

  it('leaves ranges, flags and empty assignments alone', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/keep',
          run: () =>
            found([
              {
                code: 'demo/keep',
                severity: 'warning',
                confidence: 'high',
                message: 'engines.node says ">=20" but .nvmrc says "18"',
                expected: 'pnpm --filter=web run build',
                actual: 'DATABASE_URL= is an unfilled placeholder',
              },
            ]),
        }),
      ]),
    );

    const finding = report.results[0]?.findings[0];
    expect(finding?.message).toBe('engines.node says ">=20" but .nvmrc says "18"');
    expect(finding?.expected).toBe('pnpm --filter=web run build');
    expect(finding?.actual).toBe('DATABASE_URL= is an unfilled placeholder');
  });

  it('sanitises the evidence file name, which is repository content', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/path',
          run: () =>
            found([
              {
                code: 'demo/path',
                severity: 'warning',
                confidence: 'medium',
                message: 'a file was found',
                evidence: [
                  { file: 'TOKEN=sg-file-SECRET-7788.js' },
                  { file: 'src/deep/API_KEY=nested-SECRET.ts', line: 3 },
                ],
              },
            ]),
        }),
      ]),
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sg-file-SECRET-7788');
    // The nested case is the one a naive redactor misses: the assignment
    // lookbehind excludes `/`, so the path must be split before redacting.
    expect(serialized).not.toContain('nested-SECRET');

    const evidence = report.results[0]?.findings[0]?.evidence;
    expect(evidence?.[0]?.file).toBe('TOKEN=***');
    expect(evidence?.[1]?.file).toBe('src/deep/API_KEY=***');
    expect(evidence?.[1]?.line).toBe(3);
  });

  it('sanitises the reason of a non-conclusive result', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/gap',
          run: () => inconclusive('could not read TOKEN=reason-SECRET-1234.env'),
        }),
      ]),
    );

    expect(JSON.stringify(report)).not.toContain('reason-SECRET-1234');
    expect(report.results[0]?.reason).toContain('TOKEN=***');
  });

  it('caps runaway field lengths', async () => {
    const report = await run(
      adapterWith([
        check({
          id: 'demo/long',
          run: () =>
            found([
              {
                code: 'demo/long',
                severity: 'warning',
                confidence: 'low',
                message: 'x'.repeat(5000),
              },
            ]),
        }),
      ]),
    );

    expect(report.results[0]?.findings[0]?.message.length).toBeLessThanOrEqual(400);
  });
});

describe('AdapterRegistry', () => {
  it('rejects duplicate adapter ids', () => {
    const registry = new AdapterRegistry([adapterWith([])]);
    expect(() => registry.register(adapterWith([]))).toThrow(/already registered/);
  });

  it('rejects check ids that are not namespaced by their adapter', () => {
    expect(() => new AdapterRegistry([adapterWith([check({ id: 'other/x', run: () => pass() })])])).toThrow(
      /must be namespaced/,
    );
  });

  it('rejects duplicate check ids inside one adapter', () => {
    const duplicate = check({ id: 'demo/x', run: () => pass() });
    expect(() => new AdapterRegistry([adapterWith([duplicate, duplicate])])).toThrow(/duplicate check id/);
  });
});
