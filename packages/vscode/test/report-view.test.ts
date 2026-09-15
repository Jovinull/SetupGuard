import { describe, expect, it } from 'vitest';

import { renderReport, renderReports } from 'setupguard';

import { reportFor, syntheticReport } from './support.js';

/**
 * The report document is the only place the extension shows free text, so the
 * tests care about two things: that it explains the verdict, and that it cannot
 * say more than the sanitised report already says.
 */

describe('renderReport', () => {
  it('states the verdict and what was verified', async () => {
    const text = renderReport(await reportFor('healthy-pnpm'));

    expect(text).toContain('READY');
    expect(text).toContain('checks verified');
    expect(text).toContain('Verified against levels: static, environment.');
  });

  it('lists findings with their file, code and remediation', async () => {
    const text = renderReport(await reportFor('broken-node-project'));

    expect(text).toContain('BLOCKED');
    expect(text).toMatch(/error\s+\S/);
    expect(text).toContain('node/');
  });

  it('explains an incomplete diagnosis instead of implying success', async () => {
    const report = await reportFor('empty-dir');
    const text = renderReport(report);

    expect(text).toContain('INCOMPLETE');
    expect(text).toContain(report.incompleteReason ?? '');
    expect(text).not.toContain('READY');
  });

  it('separates what was not verified from what is wrong', () => {
    const text = renderReport(
      syntheticReport('INCOMPLETE', {
        results: [
          {
            checkId: 'node/env-contract',
            title: 'Environment contract',
            category: 'environment',
            level: 'static',
            status: 'inconclusive',
            reason: 'the source scan hit its file limit',
            findings: [],
            durationMs: 1,
          },
        ],
      }),
    );

    expect(text).toContain('Not verified');
    expect(text).toContain('the source scan hit its file limit');
    expect(text).toContain('limits of the diagnosis');
  });

  it('reports a broken configuration as a configuration problem', () => {
    const text = renderReport(
      syntheticReport('INCOMPLETE', {
        config: {
          source: '.setupguard.yml',
          valid: false,
          diagnostics: [
            {
              code: 'config/unknown-key',
              message: 'Unknown key "cheks"',
              file: '.setupguard.yml',
              line: 3,
              column: 1,
              path: 'cheks',
              remediation: 'Did you mean "checks"?',
            },
          ],
        },
      }),
    );

    expect(text).toContain('Configuration');
    expect(text).toContain('.setupguard.yml:3:1');
    expect(text).toContain('config/unknown-key');
    expect(text).toContain('Did you mean "checks"?');
    expect(text).toContain('default settings');
  });

  it('never shows a value the engine redacted', async () => {
    const report = await reportFor('secret-env');
    const text = renderReport(report);

    // The fixture's secrets are in its files; whatever the report says about
    // them has already been through the engine's sanitiser. The rendering adds
    // nothing, so if a value appears here the engine leaked it.
    expect(text).not.toContain('QA-FAKE-CREDENTIAL-0003');
  });

  it('adds no field the report does not have', () => {
    const text = renderReport(syntheticReport('READY'));
    expect(text.split('\n')[0]).toBe('SetupGuard');
    expect(text).toContain('/workspace');
  });
});

describe('renderReports', () => {
  it('says so when nothing has run yet', () => {
    expect(renderReports([])).toContain('No diagnosis has run yet');
  });

  it('omits the folder heading when there is only one folder', () => {
    const text = renderReports([{ label: 'app', report: syntheticReport('READY') }]);
    expect(text).not.toContain('— app');
  });

  it('labels each folder in a multi-root workspace', () => {
    const text = renderReports([
      { label: 'api', report: syntheticReport('READY') },
      { label: 'web', report: syntheticReport('BLOCKED') },
    ]);

    expect(text).toContain('SetupGuard — api');
    expect(text).toContain('SetupGuard — web');
    expect(text).toContain('READY');
    expect(text).toContain('BLOCKED');
  });
});
