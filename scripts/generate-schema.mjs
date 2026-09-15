#!/usr/bin/env node
/**
 * Regenerate `schemas/setupguard.schema.json` from the TypeScript source of
 * truth.
 *
 * The schema is never edited by hand. `configJsonSchema()` in
 * `packages/core/src/config/schema.ts` is the only definition, and a test
 * asserts this file matches its output byte for byte, so the two cannot drift.
 *
 * Run `pnpm run schema` after changing the configuration shape.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configJsonSchema } from '../packages/core/dist/index.js';

const target = path.resolve(fileURLToPath(new URL('../schemas/setupguard.schema.json', import.meta.url)));
writeFileSync(target, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
process.stdout.write(`wrote ${path.relative(process.cwd(), target)}\n`);
