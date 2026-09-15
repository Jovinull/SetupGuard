import { describe, expect, it } from 'vitest';

import type { Report } from '@setupguard/core';
import { DiagnosisSession, type CancelScheduled, type SessionState } from 'setupguard';

import { syntheticReport } from './support.js';

/**
 * The session is where every concurrency mistake would live, so the timer is
 * injected and driven by hand: no `setTimeout`, no `vi.useFakeTimers`, no
 * sleeping. Every assertion below is about a sequence that really happened.
 */

class ManualClock {
  #pending: { callback: () => void; cancelled: boolean }[] = [];

  schedule = (callback: () => void): CancelScheduled => {
    const entry = { callback, cancelled: false };
    this.#pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  /** Number of timers that are still live. */
  get armed(): number {
    return this.#pending.filter((entry) => !entry.cancelled).length;
  }

  /** Fire every live timer, in order. */
  flush(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const entry of pending) if (!entry.cancelled) entry.callback();
  }
}

interface Harness {
  readonly session: DiagnosisSession;
  readonly clock: ManualClock;
  readonly states: SessionState[];
  readonly signals: AbortSignal[];
  settle(index: number, report: Report): void;
  fail(index: number, error: unknown): void;
  readonly started: number;
}

function harness(): Harness {
  const clock = new ManualClock();
  const states: SessionState[] = [];
  const signals: AbortSignal[] = [];
  const resolvers: { resolve(report: Report): void; reject(error: unknown): void }[] = [];

  const session = new DiagnosisSession({
    schedule: clock.schedule,
    onStateChange: (state) => states.push(state),
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    run: (signal) => {
      signals.push(signal);
      return new Promise<Report>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    },
  });

  return {
    session,
    clock,
    states,
    signals,
    settle: (index, report) => resolvers[index]?.resolve(report),
    fail: (index, error) => resolvers[index]?.reject(error),
    get started() {
      return resolvers.length;
    },
  };
}

/** Let the promise callbacks queued by a settle/fail actually run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('DiagnosisSession', () => {
  it('starts idle and runs nothing on its own', () => {
    const { session, states, started } = harness();
    expect(session.state).toEqual({ phase: 'idle', generation: 0 });
    expect(states).toEqual([]);
    expect(started).toBe(0);
  });

  it('collapses a burst of requests into a single run', () => {
    const h = harness();
    h.session.request();
    h.session.request();
    h.session.request();

    // Three requests, one live timer: the previous ones were cancelled.
    expect(h.clock.armed).toBe(1);
    h.clock.flush();
    expect(h.started).toBe(1);
  });

  it('publishes a report and reaches settled', async () => {
    const h = harness();
    const report = syntheticReport('READY');

    h.session.request();
    h.clock.flush();
    expect(h.session.state).toMatchObject({ phase: 'running', generation: 1 });

    h.settle(0, report);
    await tick();

    expect(h.session.state).toEqual({ phase: 'settled', report, generation: 1 });
    expect(h.states.map((state) => state.phase)).toEqual(['running', 'settled']);
  });

  it('keeps the previous report visible while a new run is in flight', async () => {
    const h = harness();
    const first = syntheticReport('WARNINGS');

    h.session.runNow();
    h.settle(0, first);
    await tick();

    h.session.runNow();
    expect(h.session.state).toEqual({ phase: 'running', report: first, generation: 2 });
  });

  it('discards a stale result when a newer run has started', async () => {
    const h = harness();
    const stale = syntheticReport('BLOCKED');
    const fresh = syntheticReport('READY');

    h.session.runNow();
    h.session.runNow();
    expect(h.started).toBe(2);

    // The first run finishes last. It describes a workspace that no longer
    // exists, so nothing it says may reach the screen.
    h.settle(1, fresh);
    await tick();
    h.settle(0, stale);
    await tick();

    expect(h.session.state).toEqual({ phase: 'settled', report: fresh, generation: 2 });
    expect(h.states.filter((state) => state.report === stale)).toEqual([]);
  });

  it('aborts the run it supersedes', () => {
    const h = harness();
    h.session.runNow();
    h.session.runNow();

    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.signals[1]?.aborted).toBe(false);
  });

  it('reports a failed run as an error without inventing a verdict', async () => {
    const h = harness();
    h.session.runNow();
    h.fail(0, new Error('EACCES'));
    await tick();

    expect(h.session.state).toEqual({ phase: 'settled', error: 'EACCES', generation: 1 });
    expect(h.session.state.report).toBeUndefined();
  });

  it('clears a previous error once a run succeeds', async () => {
    const h = harness();
    h.session.runNow();
    h.fail(0, new Error('EACCES'));
    await tick();

    const report = syntheticReport('READY');
    h.session.runNow();
    h.settle(1, report);
    await tick();

    expect(h.session.state.error).toBeUndefined();
    expect(h.session.state.report).toBe(report);
  });

  it('runNow cancels a pending debounce instead of running twice', () => {
    const h = harness();
    h.session.request();
    h.session.runNow();

    expect(h.started).toBe(1);
    h.clock.flush();
    expect(h.started).toBe(1);
  });

  it('stops scheduling, aborts and publishes nothing after dispose', async () => {
    const h = harness();
    h.session.runNow();
    const before = h.states.length;

    h.session.dispose();
    expect(h.signals[0]?.aborted).toBe(true);

    h.settle(0, syntheticReport('READY'));
    await tick();
    expect(h.states).toHaveLength(before);

    h.session.request();
    h.session.runNow();
    expect(h.clock.armed).toBe(0);
    expect(h.started).toBe(1);
  });

  it('tracks a running generation per start, so logs can name the run', () => {
    const h = harness();
    h.session.runNow();
    h.session.runNow();
    h.session.runNow();
    expect(h.session.state.generation).toBe(3);
  });
});
