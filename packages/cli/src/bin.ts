#!/usr/bin/env node
import process from 'node:process';

import { runCli } from './run.js';
import { CLI_VERSION } from './version.js';

/** Thin process shell. Everything testable lives in `run.ts`. */
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
