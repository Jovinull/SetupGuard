import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODES, runCli, type CliIo } from '@setupguard/cli';
import type { Report } from '@setupguard/core';
import { fixture } from '@setupguard/testing';

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(overrides: Partial<CliIo> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      isTty: false,
      env: {},
      ...overrides,
    },
  };
}

describe('runCli', () => {
  it('prints help and exits cleanly', async () => {
    const { io, out } = capture();
    const result = await runCli([], io, '0.1.0');

    expect(result.exitCode).toBe(EXIT_CODES.OK);
    expect(out.join('\n')).toContain('Usage:');
    expect(out.join('\n')).toContain('never runs build, test, migration or container commands');
  });

  it('prints the version', async () => {
    const { io, out } = capture();
    await runCli(['--version'], io, '9.9.9');
    expect(out).toEqual(['9.9.9']);
  });

  it('rejects an unknown flag with the usage exit code', async () => {
    const { io, err } = capture();
    const result = await runCli(['--bogus'], io, '0.1.0');

    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
    expect(err.join('\n')).toContain('Unknown option: --bogus');
  });

  it('rejects a path that does not exist', async () => {
    const { io, err } = capture();
    const result = await runCli([fixture('does-not-exist')], io, '0.1.0');

    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
    expect(err.join('\n')).toContain('Path does not exist');
  });

  it('rejects a path that is a file', async () => {
    const { io, err } = capture();
    const result = await runCli([path.join(fixture('healthy-npm'), 'package.json')], io, '0.1.0');

    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
    expect(err.join('\n')).toContain('Not a directory');
  });

  it('exits 0 and prints READY for a healthy project', async () => {
    const { io, out } = capture();
    const result = await runCli([fixture('healthy-npm'), '--level', 'static'], io, '0.1.0');

    expect(result.exitCode).toBe(EXIT_CODES.OK);
    const text = out.join('\n');
    expect(text).toContain('READY');
    expect(text).toContain('0 blockers');
    expect(text).toContain('Deeper levels were not executed');
    expect(text).not.toContain('\u001B['); // colour is off for a non-TTY
  });

  it('exits 1 and explains each blocker for a broken project', async () => {
    const { io, out } = capture();
    const result = await runCli([fixture('broken-node-project'), '--level', 'static'], io, '0.1.0');

    expect(result.exitCode).toBe(EXIT_CODES.FINDINGS);
    const text = out.join('\n');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('node/docs-script-not-found');
    expect(text).toContain('README.md:10');
    expect(text).toContain('fix:');
  });

  it('exits 0 for warnings by default and 1 with --fail-on warning', async () => {
    const lenient = capture();
    expect((await runCli([fixture('warnings-only')], lenient.io, '0.1.0')).exitCode).toBe(
      EXIT_CODES.OK,
    );

    const strict = capture();
    const result = await runCli(
      [fixture('warnings-only'), '--fail-on', 'warning'],
      strict.io,
      '0.1.0',
    );
    expect(result.exitCode).toBe(EXIT_CODES.FINDINGS);
  });

  it('emits a machine-readable report with --json', async () => {
    const { io, out } = capture();
    const result = await runCli([fixture('broken-node-project'), '--json'], io, '0.1.0');

    const report = JSON.parse(out.join('\n')) as Report;
    expect(report.schemaVersion).toBe(1);
    expect(report.readiness).toBe('BLOCKED');
    expect(report.root).toBe(fixture('broken-node-project'));
    expect(result.report?.readiness).toBe('BLOCKED');
  });

  it('does not exit 0 when no supported project was found', async () => {
    const { io, out, err } = capture();
    const result = await runCli([fixture('empty-dir')], io, '0.1.0');

    // A mistyped path or an unsupported ecosystem in a CI workflow used to
    // produce a green job. It must not.
    expect(result.exitCode).toBe(EXIT_CODES.INCOMPLETE);
    expect(out.join('\n')).toContain('INCOMPLETE');
    expect(err.join('\n')).toContain('No supported project was detected');
  });

  it('marks the JSON report INCOMPLETE too, not just the human output', async () => {
    const { io, out } = capture();
    const result = await runCli([fixture('empty-dir'), '--json'], io, '0.1.0');

    const report = JSON.parse(out.join('\n')) as Report;
    expect(report.readiness).toBe('INCOMPLETE');
    expect(report.incompleteReason).toBeTruthy();
    expect(result.exitCode).toBe(EXIT_CODES.INCOMPLETE);
  });

  it('refuses to call a level green when it has no checks', async () => {
    const { io, out } = capture();
    const result = await runCli(
      [fixture('broken-node-project'), '--level', 'connectivity'],
      io,
      '0.1.0',
    );

    const text = out.join('\n');
    expect(text).toContain('INCOMPLETE');
    expect(text).toContain('no checks for this level');
    expect(text).not.toContain('READY');
    expect(result.exitCode).toBe(EXIT_CODES.INCOMPLETE);
  });

  it('lists every check with --verbose', async () => {
    const { io, out } = capture();
    await runCli([fixture('healthy-npm'), '--verbose', '--level', 'static'], io, '0.1.0');

    const text = out.join('\n');
    expect(text).toContain('All checks');
    expect(text).toContain('node/package-manager-available');
    expect(text).toContain('Verification level "environment" was not requested');
  });

  it('honours NO_COLOR and --color', async () => {
    const plain = capture({ isTty: true, env: { NO_COLOR: '1' } });
    await runCli([fixture('healthy-npm')], plain.io, '0.1.0');
    expect(plain.out.join('\n')).not.toContain('\u001B[');

    const colored = capture({ env: {} });
    await runCli([fixture('healthy-npm'), '--color'], colored.io, '0.1.0');
    expect(colored.out.join('\n')).toContain('\u001B[');
  });
});
