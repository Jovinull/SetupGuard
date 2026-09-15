import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolve = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against TypeScript sources, so `vitest` needs no prior build
    // and a failing test always points at the file you edit.
    alias: {
      '@setupguard/core': resolve('./packages/core/src/index.ts'),
      '@setupguard/adapter-node': resolve('./packages/adapter-node/src/index.ts'),
      '@setupguard/cli': resolve('./packages/cli/src/index.ts'),
      setupguard: resolve('./packages/vscode/src/index.ts'),
      '@setupguard/testing': resolve('./testing/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
