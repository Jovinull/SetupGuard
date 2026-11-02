import { analyse, type AnalyseDeps, type Analysis } from './analyse.js';
import { buildAnnotations, buildOutputs, renderLog, renderSummary } from './render.js';
import { formatAnnotation, formatOutputs, inertBlock, newStopToken } from './workflow-commands.js';

export interface ActionIo {
  readonly stdout: (text: string) => void;
  /** Append to `$GITHUB_STEP_SUMMARY`; absent when not running in Actions. */
  readonly appendSummary?: (markdown: string) => Promise<void>;
  /** Append to `$GITHUB_OUTPUT`; absent when not running in Actions. */
  readonly appendOutput?: (text: string) => Promise<void>;
}

export interface ActionRun {
  readonly exitCode: 0 | 1;
  readonly analysis: Analysis;
}

/**
 * The action, minus `process`. Everything observable goes through `io`, so the
 * tests assert on exactly what the runner would receive.
 *
 * Exit code: 0 only for `pass`. `fail` and `incomplete` both exit 1 — a job
 * cannot report "incomplete" as a third state, and the one thing it must never
 * do is turn green when the analysis did not happen. The `result` output tells
 * the two apart for workflows that need to.
 */
export async function runAction(deps: AnalyseDeps & { readonly io: ActionIo; readonly stopToken?: string }): Promise<ActionRun> {
  const analysis = await analyse(deps);
  const token = deps.stopToken ?? newStopToken();

  deps.io.stdout(inertBlock(renderLog(analysis), token));
  for (const annotation of buildAnnotations(analysis)) deps.io.stdout(formatAnnotation(annotation));

  // A summary or output that cannot be written must not hide the verdict: the
  // log and annotations above already carry it, and the exit code still does.
  try {
    await deps.io.appendSummary?.(renderSummary(analysis));
  } catch {
    deps.io.stdout(formatAnnotation({ level: 'warning', message: 'Could not write the job summary' }));
  }
  try {
    await deps.io.appendOutput?.(formatOutputs(buildOutputs(analysis)));
  } catch {
    deps.io.stdout(formatAnnotation({ level: 'warning', message: 'Could not write the step outputs' }));
  }

  return { exitCode: analysis.result === 'pass' ? 0 : 1, analysis };
}
