#!/usr/bin/env node
import process from 'node:process';

import { describeError } from '@setupguard/core';

import { EXIT_CODES } from './exit-codes.js';
import { runCli } from './run.js';
import { CLI_VERSION } from './version.js';

/**
 * Thin process shell. Everything testable lives in `run.ts`.
 *
 * The catch matters twice over. Without it an unexpected throw becomes an
 * unhandled rejection and Node exits 1 — the code this CLI reserves for "the
 * project has findings" — so a crash would read as a verdict on the repository.
 * And the message has to go through `describeError`: this is the one path
 * outside `runDiagnosis`, so nothing else has redacted it, and an exception
 * message can quote repository content.
 */
try {
  const result = await runCli(
    process.argv.slice(2),
    {
      stdout: (text) => process.stdout.write(`${text}\n`),
      stderr: (text) => process.stderr.write(`${text}\n`),
      isTty: process.stdout.isTTY === true,
      env: process.env,
    },
    CLI_VERSION,
  );
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`SetupGuard failed unexpectedly: ${describeError(error)}\n`);
  process.exitCode = EXIT_CODES.INCOMPLETE;
}
