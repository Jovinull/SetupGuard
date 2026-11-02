import { appendFile } from 'node:fs/promises';

import { runAction } from './run.js';

/**
 * Entry point of the bundle (`dist/index.cjs`). The only module that touches
 * `process`; everything else is driven through `runAction`.
 */
async function main(): Promise<void> {
  const env = process.env;
  const summaryPath = env['GITHUB_STEP_SUMMARY'];
  const outputPath = env['GITHUB_OUTPUT'];

  const { exitCode } = await runAction({
    env,
    io: {
      stdout: (text) => process.stdout.write(`${text}\n`),
      ...(summaryPath ? { appendSummary: (markdown: string) => appendFile(summaryPath, `${markdown}\n`, 'utf8') } : {}),
      ...(outputPath ? { appendOutput: (text: string) => appendFile(outputPath, text, 'utf8') } : {}),
    },
  });
  process.exitCode = exitCode;
}

main().catch(() => {
  // `runAction` already turns every failure into an `incomplete` verdict; this
  // only catches a failure to write to stdout itself. No detail is printed: it
  // could quote repository content outside the stop-commands region.
  process.stdout.write('::error title=SetupGuard::SetupGuard failed before it could report\n');
  process.exitCode = 1;
});
