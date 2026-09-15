import { promises as fs } from 'node:fs';
import path from 'node:path';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeEnvironmentProbe,
  NodeWorkspaceFs,
  describeError,
  loadConfig,
  reportToJson,
  runDiagnosis,
  type Report,
} from '@setupguard/core';

import { parseArgs, UsageError, type DoctorOptions } from './args.js';
import { EXIT_CODES, exitCodeFor, type ExitCode } from './exit-codes.js';
import { renderHuman } from './render.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Used to decide whether colour is appropriate when not forced. */
  readonly isTty: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export interface CliResult {
  readonly exitCode: ExitCode;
  /** Present when a diagnosis actually ran. Exposed for tests and embedders. */
  readonly report?: Report;
}

export const HELP_TEXT = `SetupGuard — repository development readiness

Usage:
  setupguard [doctor] [path] [options]

Commands:
  doctor              Diagnose the repository at <path> (default command)
  check               Alias of doctor
  help                Show this help
  version             Show the version

Options:
  --level <levels>    Comma-separated verification levels to run.
                      Available: static, environment, connectivity, verification.
                      Default: static,environment
  --fail-on <what>    Exit non-zero on: error (default), warning, never
  --json              Print the machine-readable report instead of the human one
  --verbose           Also list checks that passed, were skipped or did not apply
  --color/--no-color  Force colour on or off (default: auto)
  -h, --help          Show this help
  -v, --version       Show the version

Exit codes:
  0  the project was checked and nothing reached the --fail-on threshold
  1  findings at or above the threshold
  2  invalid usage or unusable path
  3  INCOMPLETE: the diagnosis is partial - something could not be verified, or
     no check reached a conclusion at all. Not a pass, and not a failure of the
     project. --fail-on never does not suppress this.

SetupGuard never runs build, test, migration or container commands on its own.
The default levels read repository files and inspect the local machine only.`;

/**
 * Whole CLI as a pure-ish function: it takes an argv and an IO surface and
 * returns an exit code. `bin.ts` is the only place that touches `process`.
 */
export async function runCli(argv: readonly string[], io: CliIo, version: string): Promise<CliResult> {
  let options: DoctorOptions;

  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      io.stdout(HELP_TEXT);
      return { exitCode: EXIT_CODES.OK };
    }
    if (parsed.command === 'version') {
      io.stdout(version);
      return { exitCode: EXIT_CODES.OK };
    }
    options = parsed;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\nRun "setupguard --help" for usage.`);
      return { exitCode: EXIT_CODES.USAGE };
    }
    throw error;
  }

  const root = path.resolve(options.path);
  try {
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) {
      io.stderr(`Not a directory: ${root}`);
      return { exitCode: EXIT_CODES.USAGE };
    }
  } catch {
    io.stderr(`Path does not exist: ${root}`);
    return { exitCode: EXIT_CODES.USAGE };
  }

  // Everything past argument parsing runs inside one guard. Diagnosis,
  // serialisation and rendering can all throw, and an exception escaping here
  // would bypass `runDiagnosis`'s sanitisation entirely: its message goes
  // straight to stderr, and a message can quote repository content. Hence
  // `describeError`, which redacts and caps like every other report field.
  try {
    const workspace = new NodeWorkspaceFs(root);
    const registry = new AdapterRegistry([nodeAdapter]);

    // One discovery/parse/validate pass, before anything else runs. Checks
    // receive configuration already normalised and never see YAML.
    const config = await loadConfig({
      fs: workspace,
      knownCheckIds: registry.list().flatMap((adapter) => adapter.checks.map((check) => check.id)),
    });

    const report = await runDiagnosis({
      fs: workspace,
      environment: new NodeEnvironmentProbe({ env: io.env }),
      registry,
      levels: options.levels,
      config,
    });

    const nothingDetected = report.adapters.every((adapter) => !adapter.detected);
    const unsupportedHint =
      'No supported project was detected in this directory. SetupGuard v0.1 only understands Node.js projects.';

    if (options.format === 'json') {
      io.stdout(reportToJson(report));
      // The JSON goes to stdout for a machine; a human tailing the job log still
      // needs to be told why the exit code is 3.
      if (report.readiness === 'INCOMPLETE') {
        io.stderr(
          nothingDetected ? unsupportedHint : (report.incompleteReason ?? 'The diagnosis is incomplete.'),
        );
      }
    } else {
      io.stdout(renderHuman(report, { color: shouldUseColor(options, io), verbose: options.verbose }));
      // The rendered footer already states the reason; only the ecosystem hint
      // adds anything, so it is the only thing repeated on stderr.
      if (report.readiness === 'INCOMPLETE' && nothingDetected) io.stderr(unsupportedHint);
    }

    return { exitCode: exitCodeFor(report, options.failOn), report };
  } catch (error) {
    io.stderr(`SetupGuard failed: ${describeError(error)}`);
    return { exitCode: EXIT_CODES.INCOMPLETE };
  }
}

/** Honour `--color`/`--no-color` first, then `NO_COLOR`, then TTY detection. */
function shouldUseColor(options: DoctorOptions, io: CliIo): boolean {
  if (options.color !== undefined) return options.color;
  if (io.env['NO_COLOR'] !== undefined && io.env['NO_COLOR'] !== '') return false;
  return io.isTty;
}
