import type { AnyAdapter, CheckContext, CheckOutput, DiscoveryContext } from '../adapter/adapter.js';
import type { AdapterRegistry } from '../adapter/registry.js';
import type { EnvironmentProbe } from '../env/environment.js';
import type { WorkspaceFs } from '../fs/workspace-fs.js';
import {
  DEFAULT_LEVELS,
  REPORT_SCHEMA_VERSION,
  type AdapterReport,
  type CheckResult,
  type Finding,
  type Report,
  type VerificationLevel,
} from '../model/types.js';
import { describeError } from '../util/redact.js';
import { aggregateReadiness, incompleteReason, statusFromFindings, summarize } from './aggregate.js';
import { sanitizeResult } from './sanitize.js';

/** Wall-clock budget for a single check before it is reported as inconclusive. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** Budget for one adapter's `detect` + `collect`. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;

export interface RunOptions {
  readonly fs: WorkspaceFs;
  readonly environment: EnvironmentProbe;
  readonly registry: AdapterRegistry;
  /** Levels authorised for this run. Defaults to `static` + `environment`. */
  readonly levels?: readonly VerificationLevel[];
  /**
   * Authorise checks declared as `side-effects`. Defaults to `false`: builds,
   * tests, migrations and container commands never run implicitly
   * (`Notes/09-seguranca-e-confiabilidade.md`).
   */
  readonly allowSideEffects?: boolean;
  /** Per-check timeout. Defaults to {@link DEFAULT_CHECK_TIMEOUT_MS}. */
  readonly checkTimeoutMs?: number;
  /** Per-adapter discovery timeout. Defaults to {@link DEFAULT_ADAPTER_TIMEOUT_MS}. */
  readonly adapterTimeoutMs?: number;
  /** Cancels the whole run. Propagated to every adapter and check. */
  readonly signal?: AbortSignal;
  /** Injectable clock, so report snapshots are reproducible in tests. */
  readonly now?: () => Date;
}

/**
 * Execute the diagnosis pipeline:
 *
 * ```text
 * detect adapters -> collect facts -> select checks by level
 *   -> run allowed checks -> sanitise -> aggregate readiness
 * ```
 *
 * The function never throws because of a failing adapter or check: failures are
 * captured as `internal-error` results so a SetupGuard bug is never presented as
 * a broken project.
 */
export async function runDiagnosis(options: RunOptions): Promise<Report> {
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const levels = options.levels ?? DEFAULT_LEVELS;
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const allowSideEffects = options.allowSideEffects ?? false;

  const adapterReports: AdapterReport[] = [];
  const results: CheckResult[] = [];

  for (const adapter of options.registry.list()) {
    let detected = false;
    let facts: unknown;

    const discovery = withDeadline(options.signal, adapterTimeoutMs);
    const discoveryContext: DiscoveryContext = {
      fs: options.fs,
      environment: options.environment,
      signal: discovery.signal,
    };
    const timeoutMessage = `Adapter "${adapter.id}" exceeded its ${adapterTimeoutMs}ms discovery budget`;

    try {
      detected = await runWithDeadline(() => adapter.detect(discoveryContext), discovery, timeoutMessage);
      if (detected) {
        facts = await runWithDeadline(() => adapter.collect(discoveryContext), discovery, timeoutMessage);
      }
    } catch (error) {
      const reason = describeError(error);
      adapterReports.push({ id: adapter.id, name: adapter.name, detected: false, error: reason });
      results.push(...adapterFailureResults(adapter, reason));
      continue;
    } finally {
      discovery.dispose();
    }

    adapterReports.push({ id: adapter.id, name: adapter.name, detected });
    if (!detected) continue;

    for (const check of adapter.checks) {
      results.push(
        await runCheck(check, facts, options, {
          levels,
          timeoutMs: checkTimeoutMs,
          allowSideEffects,
        }),
      );
    }
  }

  // Single choke point: every result — findings, evidence, and the `reason`
  // attached to skipped/not-applicable/inconclusive/internal-error — is
  // sanitised here, on the way out. A check that forgets cannot leak.
  const sanitized = results.map(sanitizeResult);

  const readiness = aggregateReadiness(sanitized);
  const reason = readiness === 'INCOMPLETE' ? incompleteReason(sanitized) : undefined;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    root: options.fs.root,
    readiness,
    levelsRequested: [...levels],
    adapters: adapterReports,
    results: sanitized,
    summary: summarize(sanitized),
    hasInternalErrors: sanitized.some((result) => result.status === 'internal-error'),
    ...(reason !== undefined ? { incompleteReason: reason } : {}),
    durationMs: Date.now() - started,
  };
}

interface RunCheckPolicy {
  readonly levels: readonly VerificationLevel[];
  readonly timeoutMs: number;
  readonly allowSideEffects: boolean;
}

async function runCheck(
  check: AnyAdapter['checks'][number],
  facts: unknown,
  options: RunOptions,
  policy: RunCheckPolicy,
): Promise<CheckResult> {
  const base = {
    checkId: check.id,
    title: check.title,
    category: check.category,
    level: check.level,
  } as const;

  if (!policy.levels.includes(check.level)) {
    return {
      ...base,
      status: 'skipped',
      findings: [],
      durationMs: 0,
      reason: `Verification level "${check.level}" was not requested`,
    };
  }

  if (check.safety === 'side-effects' && !policy.allowSideEffects) {
    return {
      ...base,
      status: 'skipped',
      findings: [],
      durationMs: 0,
      reason: 'Check can cause side effects and was not explicitly authorised',
    };
  }

  const startedAt = Date.now();
  const deadline = withDeadline(options.signal, policy.timeoutMs);
  const context: CheckContext = {
    fs: options.fs,
    environment: options.environment,
    signal: deadline.signal,
    levels: policy.levels,
  };

  try {
    if (!check.applies(facts, context)) {
      return {
        ...base,
        status: 'not-applicable',
        findings: [],
        durationMs: Date.now() - startedAt,
        reason: 'Check does not apply to this project',
      };
    }

    const output = await runWithDeadline(
      () => check.run(facts, context),
      deadline,
      `Check "${check.id}" exceeded its ${policy.timeoutMs}ms budget`,
    );

    return normalizeOutput(base, output, Date.now() - startedAt);
  } catch (error) {
    return {
      ...base,
      status: 'internal-error',
      findings: [],
      durationMs: Date.now() - startedAt,
      reason: describeError(error),
    };
  } finally {
    deadline.dispose();
  }
}

function normalizeOutput(
  base: Pick<CheckResult, 'checkId' | 'title' | 'category' | 'level'>,
  output: CheckOutput,
  durationMs: number,
): CheckResult {
  switch (output.kind) {
    case 'not-applicable':
      return { ...base, status: 'not-applicable', findings: [], durationMs, reason: output.reason };
    case 'inconclusive':
      return { ...base, status: 'inconclusive', findings: [], durationMs, reason: output.reason };
    case 'findings': {
      const findings: Finding[] = output.findings.map((finding) => ({
        ...finding,
        checkId: base.checkId,
        evidence: finding.evidence ?? [],
      }));
      return { ...base, status: statusFromFindings(findings), findings, durationMs };
    }
  }
}

function adapterFailureResults(adapter: AnyAdapter, reason: string): CheckResult[] {
  return adapter.checks.map((check) => ({
    checkId: check.id,
    title: check.title,
    category: check.category,
    level: check.level,
    status: 'internal-error' as const,
    findings: [],
    durationMs: 0,
    reason: `Adapter "${adapter.id}" failed before this check could run: ${reason}`,
  }));
}

interface Deadline {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Build an {@link AbortSignal} that fires on timeout, or when the caller's own
 * signal aborts.
 *
 * `Promise.race` alone stops *waiting* for a slow task; it does not stop the
 * task. That is tolerable while every check only reads files, but not for the
 * connectivity and verification levels, where an abandoned task could still
 * hold a socket or a child process after SetupGuard has reported. The signal is
 * in the context now so those checks have something to honour when they arrive.
 */
function withDeadline(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();

  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Await `task`, rejecting as soon as `deadline` aborts. */
async function runWithDeadline<T>(
  task: () => Promise<T> | T,
  deadline: Deadline,
  message: string,
): Promise<T> {
  if (deadline.signal.aborted) throw new Error(message);

  return Promise.race([
    Promise.resolve().then(task),
    new Promise<never>((_resolve, reject) => {
      deadline.signal.addEventListener('abort', () => reject(new Error(message)), { once: true });
    }),
  ]);
}
