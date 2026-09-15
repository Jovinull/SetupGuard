import type { Report } from '@setupguard/core';

/**
 * Diagnosis lifecycle for one workspace folder.
 *
 * Deliberately free of any `vscode` import. Everything that is easy to get
 * wrong — coalescing edits, discarding a stale result, cancelling a run that no
 * longer matters, disposing cleanly — lives here so it can be tested without an
 * Extension Host. `extension.ts` supplies the real timer and the real engine
 * and does nothing else.
 */

export type DiagnosisPhase = 'idle' | 'running' | 'settled';

export interface SessionState {
  readonly phase: DiagnosisPhase;
  /** The most recent successful report, kept while a new run is in flight. */
  readonly report?: Report;
  /** Sanitised message from a run that failed inside SetupGuard. */
  readonly error?: string;
  /** Increments on every started run. Exposed for assertions and logging. */
  readonly generation: number;
}

/** Cancels a scheduled callback. */
export type CancelScheduled = () => void;

export interface SessionOptions {
  /** Runs one diagnosis. Must honour `signal`. */
  run(signal: AbortSignal): Promise<Report>;
  /** Called on every observable state change. */
  onStateChange(state: SessionState): void;
  /** Injected so tests do not depend on wall-clock timing. */
  schedule(callback: () => void, delayMs: number): CancelScheduled;
  /** Turns a thrown value into a message that is safe to display. */
  describeError(error: unknown): string;
  /** Quiet period before a requested run starts. Default 400 ms. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 400;

export class DiagnosisSession {
  readonly #options: SessionOptions;
  readonly #debounceMs: number;

  #state: SessionState = { phase: 'idle', generation: 0 };
  #generation = 0;
  #cancelScheduled: CancelScheduled | undefined;
  #inFlight: AbortController | undefined;
  #disposed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  get state(): SessionState {
    return this.#state;
  }

  /**
   * Ask for a diagnosis after the quiet period.
   *
   * Repeated calls collapse into one run: a checkout, a `pnpm install` or a
   * find-and-replace touches many watched files at once, and analysing the
   * workspace once per file would be both slow and pointless.
   */
  request(): void {
    if (this.#disposed) return;
    this.#cancelScheduled?.();
    this.#cancelScheduled = this.#options.schedule(() => {
      this.#cancelScheduled = undefined;
      this.#start();
    }, this.#debounceMs);
  }

  /** Run now, skipping the quiet period. Used by the explicit command. */
  runNow(): void {
    if (this.#disposed) return;
    this.#cancelScheduled?.();
    this.#cancelScheduled = undefined;
    this.#start();
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelScheduled?.();
    this.#cancelScheduled = undefined;
    // Aborting matters for the levels that will run commands later; today it
    // simply stops a finished run from publishing anything.
    this.#inFlight?.abort();
    this.#inFlight = undefined;
  }

  #start(): void {
    this.#inFlight?.abort();

    const controller = new AbortController();
    this.#inFlight = controller;
    this.#generation += 1;
    const generation = this.#generation;

    this.#emit({ phase: 'running', report: this.#state.report, generation });

    void this.#options
      .run(controller.signal)
      .then(
        (report) => {
          // The guard that makes concurrency safe: a run that finishes after a
          // newer one started has nothing true to say about the workspace as it
          // is now, so its result is dropped rather than published.
          if (this.#disposed || generation !== this.#generation) return;
          this.#emit({ phase: 'settled', report, generation });
        },
        (error: unknown) => {
          if (this.#disposed || generation !== this.#generation) return;
          this.#emit({
            phase: 'settled',
            report: this.#state.report,
            error: this.#options.describeError(error),
            generation,
          });
        },
      )
      .finally(() => {
        if (this.#inFlight === controller) this.#inFlight = undefined;
      });
  }

  #emit(state: SessionState): void {
    this.#state = stripUndefined(state);
    this.#options.onStateChange(this.#state);
  }
}

/** Keep absent fields absent, so state snapshots compare cleanly in tests. */
function stripUndefined(state: SessionState): SessionState {
  return {
    phase: state.phase,
    generation: state.generation,
    ...(state.report !== undefined ? { report: state.report } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
}
