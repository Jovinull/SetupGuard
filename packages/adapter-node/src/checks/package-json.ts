import { found, pass, type Check, type FindingInput } from '@setupguard/core';

import type { NodeFacts } from '../facts/collect.js';

/**
 * The manifest is the root of the Node contract: without a readable
 * `package.json` nothing else in the repository can be trusted.
 */
export const packageJsonCheck: Check<NodeFacts> = {
  id: 'node/package-json',
  title: 'package.json is present and readable',
  category: 'project',
  level: 'static',
  safety: 'read-only',
  applies: () => true,
  run(facts) {
    const state = facts.packageJson;

    switch (state.kind) {
      case 'ok':
        return pass();

      case 'missing':
        return found([
          {
            code: 'node/package-json-missing',
            severity: 'error',
            confidence: 'high',
            message: 'No package.json at the repository root',
            explanation:
              'Other Node.js signals were found, so contributors will expect `npm install` (or an equivalent) to work. Without a manifest there is nothing to install and no scripts to run.',
            expected: 'package.json at the workspace root',
            actual: 'not found',
            remediation:
              'Add a package.json, or point SetupGuard at the directory that actually holds the Node project.',
            evidence: [{ file: 'package.json', detail: 'file does not exist' }],
          },
        ]);

      case 'invalid':
        return found([
          {
            code: 'node/package-json-invalid',
            severity: 'error',
            confidence: 'high',
            message: 'package.json is not valid JSON',
            explanation:
              'Every package manager refuses to run against a manifest it cannot parse, so installation and every script are blocked.',
            expected: 'valid JSON',
            // `state.error` is SetupGuard's own description, never the native
            // parser message: that one quotes the start of the file back, and a
            // malformed manifest can begin with a credential.
            actual: state.error,
            remediation: 'Fix the JSON syntax error in package.json.',
            evidence: [
              {
                file: 'package.json',
                ...(state.line !== undefined ? { line: state.line } : {}),
                ...(state.column !== undefined ? { column: state.column } : {}),
                detail: state.error,
              },
            ],
          },
        ]);

      case 'not-an-object':
        return found([
          {
            code: 'node/package-json-not-an-object',
            severity: 'error',
            confidence: 'high',
            message: 'package.json does not contain a JSON object',
            explanation: 'A manifest must be a JSON object; package managers reject anything else.',
            expected: 'a JSON object',
            actual: 'array, string or other non-object value',
            evidence: [{ file: 'package.json' }],
          },
        ]);

      case 'unreadable': {
        const finding: FindingInput = {
          code: 'node/package-json-unreadable',
          severity: 'warning',
          confidence: 'medium',
          message: 'package.json exists but could not be read',
          explanation:
            'SetupGuard could not open the manifest, so every other manifest-based check ran without it. This is usually a permission problem on the local machine rather than a repository defect.',
          actual: state.error,
          evidence: [{ file: 'package.json', detail: state.error }],
        };
        return found([finding]);
      }
    }
  },
};
