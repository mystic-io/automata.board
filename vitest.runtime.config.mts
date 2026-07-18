import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const schemaPath = resolve('schema.sql');

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './test/runtime/worker.ts',
      remoteBindings: false,
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          RUNTIME_TEST_SCHEMA: readFileSync(schemaPath, 'utf8'),
        },
      },
    }),
  ],
  test: {
    include: ['test/runtime/**/*.runtime.test.ts'],
    setupFiles: ['./test/runtime/setup.ts'],
    testTimeout: 10_000,
  },
});
