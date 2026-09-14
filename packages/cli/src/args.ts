import { VERIFICATION_LEVELS, type VerificationLevel } from '@setupguard/core';

/**
 * Hand-written argument parser.
 *
 * The CLI surface is small and its exit-code contract matters more than its
 * ergonomics, so v0.1 avoids a parser dependency and keeps the whole contract
 * visible and directly testable (`Notes/06-cli.md`).
 */

export const COMMANDS = ['doctor', 'help', 'version'] as const;
export type Command = (typeof COMMANDS)[number];

/** Which findings make the process exit non-zero. */
export const FAIL_ON_VALUES = ['error', 'warning', 'never'] as const;
export type FailOn = (typeof FAIL_ON_VALUES)[number];

export interface DoctorOptions {
  readonly command: 'doctor';
  /** Directory to analyse, as given on the command line. */
  readonly path: string;
  readonly levels: readonly VerificationLevel[];
  readonly format: 'human' | 'json';
  readonly failOn: FailOn;
  readonly color: boolean | undefined;
  /** Include checks that passed or did not apply in the human output. */
  readonly verbose: boolean;
}

export type ParsedArgs =
  | DoctorOptions
  | { readonly command: 'help' }
  | { readonly command: 'version' };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];

  if (args.length === 0) return { command: 'help' };

  const first = args[0] ?? '';
  if (first === '--help' || first === '-h' || first === 'help') return { command: 'help' };
  if (first === '--version' || first === '-v' || first === 'version') return { command: 'version' };

  // Only the two known verbs are consumed as a command; anything else is a
  // path, so `setupguard ./some-project` works without a subcommand.
  // `check` is an alias kept because the CI examples in Notes/08 use it.
  if (first === 'doctor' || first === 'check') args.shift();

  let path: string | undefined;
  const levels: VerificationLevel[] = [];
  let format: 'human' | 'json' = 'human';
  let failOn: FailOn = 'error';
  let color: boolean | undefined;
  let verbose = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (arg === '--version' || arg === '-v') return { command: 'version' };

    if (arg === '--json') {
      format = 'json';
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--color') {
      color = true;
      continue;
    }
    if (arg === '--no-color') {
      color = false;
      continue;
    }

    if (arg === '--level' || arg.startsWith('--level=')) {
      const value = valueFor(arg, args, index, '--level');
      if (!arg.includes('=')) index += 1;
      for (const level of value.split(',')) {
        levels.push(parseLevel(level.trim()));
      }
      continue;
    }

    if (arg === '--fail-on' || arg.startsWith('--fail-on=')) {
      const value = valueFor(arg, args, index, '--fail-on');
      if (!arg.includes('=')) index += 1;
      failOn = parseFailOn(value.trim());
      continue;
    }

    if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option: ${arg}`);
    }

    if (path !== undefined) {
      throw new UsageError(`Unexpected extra argument: ${arg}`);
    }
    path = arg;
  }

  return {
    command: 'doctor',
    path: path ?? '.',
    levels: levels.length > 0 ? dedupeLevels(levels) : ['static', 'environment'],
    format,
    failOn,
    color,
    verbose,
  };
}

function valueFor(arg: string, args: readonly string[], index: number, name: string): string {
  if (arg.includes('=')) {
    const value = arg.slice(arg.indexOf('=') + 1);
    if (value === '') throw new UsageError(`${name} requires a value`);
    return value;
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new UsageError(`${name} requires a value`);
  }
  return next;
}

function parseLevel(value: string): VerificationLevel {
  const match = VERIFICATION_LEVELS.find((level) => level === value);
  if (!match) {
    throw new UsageError(
      `Unknown verification level: ${value} (expected one of ${VERIFICATION_LEVELS.join(', ')})`,
    );
  }
  return match;
}

function parseFailOn(value: string): FailOn {
  const match = FAIL_ON_VALUES.find((candidate) => candidate === value);
  if (!match) {
    throw new UsageError(
      `Unknown --fail-on value: ${value} (expected one of ${FAIL_ON_VALUES.join(', ')})`,
    );
  }
  return match;
}

function dedupeLevels(levels: readonly VerificationLevel[]): VerificationLevel[] {
  return VERIFICATION_LEVELS.filter((level) => levels.includes(level));
}
