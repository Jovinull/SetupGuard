/**
 * `@setupguard/cli` — terminal interface over `@setupguard/core`.
 *
 * All logic is exported as plain functions so the CLI can be exercised in tests
 * without spawning a process, and reused by other runners (a future GitHub
 * Action) without shelling out.
 */

export { runCli, HELP_TEXT, type CliIo, type CliResult } from './run.js';
export {
  parseArgs,
  UsageError,
  COMMANDS,
  FAIL_ON_VALUES,
  type Command,
  type DoctorOptions,
  type FailOn,
  type ParsedArgs,
} from './args.js';
export { EXIT_CODES, exitCodeFor, type ExitCode } from './exit-codes.js';
export { renderHuman, formatLocation, type RenderOptions } from './render.js';
export { CLI_VERSION } from './version.js';
