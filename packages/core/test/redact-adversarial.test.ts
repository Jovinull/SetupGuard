import { describe, expect, it } from 'vitest';

import { isSensitiveKey, redact, redactPath } from '@setupguard/core';

/**
 * Adversarial corpus for the redactor.
 *
 * The first version of these rules keyed off the *delimiter*: anything preceded
 * by `-` was left alone, so `--otp=123456` survived while `OTP=123456` was
 * redacted. These cases exist to keep the rules keyed off the **name**, and to
 * make sure the fix did not swing the other way and gut ordinary commands.
 */

const SECRET = 'QA-FAKE-CREDENTIAL-VALUE';

describe('credential shapes that must always be redacted', () => {
  const cases: readonly [string, string][] = [
    ['flag, long', `npm publish --otp=${SECRET}`],
    ['flag, token', `deploy --token=${SECRET}`],
    ['flag, password', `psql --password=${SECRET} -h db`],
    ['flag, secret', `run --secret=${SECRET}`],
    ['flag, api key', `run --api-key=${SECRET}`],
    ['flag, kebab compound', `aws --secret-access-key=${SECRET}`],
    ['flag, camelCase', `vercel --apiKey=${SECRET}`],
    ['flag, SCREAMING_SNAKE', `x --ACCESS_TOKEN=${SECRET}`],
    ['flag, private key', `ssh --private-key=${SECRET}`],
    ['flag, short form', `x --auth=${SECRET}`],
    ['flag, space separated', `npm publish --otp ${SECRET}`],
    ['flag, quoted value', `x --password="${SECRET}"`],
    ['bare assignment', `export TOKEN=${SECRET}`],
    ['inline assignment', `TOKEN=${SECRET} npm run build`],
    ['colon, no space', `token:${SECRET}`],
    ['colon, with space', `token: ${SECRET}`],
    ['header', `Authorization: ${SECRET}`],
    ['header with scheme', `Authorization: Bearer ${SECRET}`],
    ['header, hyphenated', `X-Api-Key: ${SECRET}`],
    ['header, camelCase', `clientSecret: ${SECRET}`],
    ['bare bearer', `Bearer ${SECRET}`],
    ['url credentials', `postgres://admin:${SECRET}@db.internal/app`],
    ['header nested in a flag value', `curl --header=Authorization:${SECRET}`],
    ['header nested in a quoted flag value', `curl -H "Authorization: Bearer ${SECRET}"`],
    ['registry auth token', `npm config set //registry.npmjs.org/:_authToken=${SECRET}`],
    ['session cookie', `cookie: ${SECRET}`],
    ['passphrase', `--passphrase=${SECRET}`],
  ];

  for (const [name, input] of cases) {
    it(`redacts ${name}`, () => {
      const output = redact(input);
      expect(output, input).not.toContain(SECRET);
      expect(output).toContain('***');
    });
  }
});

describe('ordinary content that must survive redaction', () => {
  const cases: readonly string[] = [
    'pnpm --filter=web run build',
    'pnpm --filter web run build',
    'npm run build --workspace=api',
    'vite --port=3000 --host=0.0.0.0',
    'tsc --noEmit --project tsconfig.json',
    'npm install --save-dev typescript',
    'engines.node says ">=20" but .nvmrc says "18"',
    'set config.key=value',
    'DATABASE_URL= is an unfilled placeholder',
    'Multiple lockfiles present: package-lock.json, npm-shrinkwrap.json',
    'package.json scripts: build, start, ci',
    'Conflicting Node.js requirements: engines vs .nvmrc',
    'expected: a script named "web"',
    'see https://example.com/docs for details',
    'Run the suite: vitest run',
  ];

  for (const input of cases) {
    it(`preserves ${JSON.stringify(input)}`, () => {
      expect(redact(input)).toBe(input);
    });
  }
});

describe('isSensitiveKey', () => {
  it('splits keys into words across every naming convention', () => {
    for (const key of ['token', 'API_KEY', 'apiKey', 'x-api-key', '--secret-access-key', 'clientSecret']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not fire on keys that merely contain a sensitive word', () => {
    for (const key of ['keyword', 'tokenizer', 'pinned', 'filter', 'workspace', 'port', 'host']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redactPath', () => {
  it('redacts a credential-shaped file name at any depth', () => {
    expect(redactPath(`TOKEN=${SECRET}.js`)).not.toContain(SECRET);
    expect(redactPath(`src/deep/API_KEY=${SECRET}.ts`)).not.toContain(SECRET);
    expect(redactPath(`--otp=${SECRET}.js`)).not.toContain(SECRET);
  });

  it('leaves ordinary paths untouched', () => {
    for (const p of ['README.md', 'src/index.ts', 'packages/core/src/a.ts', '.env.example']) {
      expect(redactPath(p)).toBe(p);
    }
  });
});
