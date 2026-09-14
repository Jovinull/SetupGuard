import { describe, expect, it } from 'vitest';

import { EXIT_CODES, UsageError, exitCodeFor, parseArgs, type DoctorOptions } from '@setupguard/cli';
import type { Report } from '@setupguard/core';

function doctor(argv: readonly string[]): DoctorOptions {
  const parsed = parseArgs(argv);
  if (parsed.command !== 'doctor') throw new Error(`Expected doctor, got ${parsed.command}`);
  return parsed;
}

describe('parseArgs', () => {
  it('defaults to help with no arguments', () => {
    expect(parseArgs([])).toEqual({ command: 'help' });
  });

  it('recognises help and version in all their spellings', () => {
    for (const argv of [['help'], ['--help'], ['-h'], ['doctor', '--help']]) {
      expect(parseArgs(argv)).toEqual({ command: 'help' });
    }
    for (const argv of [['version'], ['--version'], ['-v']]) {
      expect(parseArgs(argv)).toEqual({ command: 'version' });
    }
  });

  it('defaults to the current directory and the two safe levels', () => {
    expect(doctor(['doctor'])).toEqual({
      command: 'doctor',
      path: '.',
      levels: ['static', 'environment'],
      format: 'human',
      failOn: 'error',
      color: undefined,
      verbose: false,
    });
  });

  it('accepts a path with or without the command word', () => {
    expect(doctor(['doctor', './app']).path).toBe('./app');
    expect(doctor(['./app']).path).toBe('./app');
    expect(doctor(['check', '/tmp/app']).path).toBe('/tmp/app');
  });

  it('parses levels in both syntaxes and normalises their order', () => {
    expect(doctor(['--level', 'environment,static']).levels).toEqual(['static', 'environment']);
    expect(doctor(['--level=static']).levels).toEqual(['static']);
    expect(doctor(['--level', 'static', '--level', 'connectivity']).levels).toEqual([
      'static',
      'connectivity',
    ]);
  });

  it('parses the remaining flags', () => {
    const options = doctor(['--json', '--verbose', '--no-color', '--fail-on', 'warning']);
    expect(options).toMatchObject({
      format: 'json',
      verbose: true,
      color: false,
      failOn: 'warning',
    });
    expect(doctor(['--color']).color).toBe(true);
  });

  it('rejects invalid input', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--level'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--level', 'galaxy'])).toThrow(/Unknown verification level/);
    expect(() => parseArgs(['--fail-on', 'maybe'])).toThrow(/Unknown --fail-on value/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/Unexpected extra argument/);
  });
});

describe('exitCodeFor', () => {
  const report = (
    overrides: Partial<Report['summary']> & { readiness?: Report['readiness'] } = {},
  ): Report =>
    ({
      readiness: overrides.readiness ?? 'READY',
      summary: {
        errors: 0,
        warnings: 0,
        infos: 0,
        passed: 1,
        skipped: 0,
        notApplicable: 0,
        inconclusive: 0,
        internalErrors: 0,
        conclusive: 1,
        ...overrides,
      },
      hasInternalErrors: false,
    }) as Report;

  it('fails on errors by default and ignores warnings', () => {
    expect(exitCodeFor(report({ errors: 1 }), 'error')).toBe(EXIT_CODES.FINDINGS);
    expect(exitCodeFor(report({ warnings: 3 }), 'error')).toBe(EXIT_CODES.OK);
  });

  it('can be tightened to fail on warnings', () => {
    expect(exitCodeFor(report({ warnings: 1 }), 'warning')).toBe(EXIT_CODES.FINDINGS);
  });

  it('can be told never to fail', () => {
    expect(exitCodeFor(report({ errors: 5 }), 'never')).toBe(EXIT_CODES.OK);
  });

  it('reports an incomplete diagnosis without claiming the project is broken', () => {
    expect(exitCodeFor(report({ readiness: 'INCOMPLETE' }), 'error')).toBe(EXIT_CODES.INCOMPLETE);
    // A real finding takes precedence over an incomplete diagnosis.
    expect(exitCodeFor(report({ errors: 1, readiness: 'BLOCKED' }), 'error')).toBe(
      EXIT_CODES.FINDINGS,
    );
  });

  it('does not let --fail-on never hide an incomplete diagnosis', () => {
    // `never` tolerates findings the user has seen. It must not turn "nothing
    // was checked" into a green CI job.
    expect(exitCodeFor(report({ errors: 5, readiness: 'BLOCKED' }), 'never')).toBe(EXIT_CODES.OK);
    expect(exitCodeFor(report({ readiness: 'INCOMPLETE' }), 'never')).toBe(EXIT_CODES.INCOMPLETE);
  });
});
