import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/** Fake secrets for tests only (the real ones are `wrangler secret put`, see README.md). */
const TEST_SECRETS = {
  META_TOKEN: 'test-meta-token',
  APP_SECRET: 'test-app-secret',
  VERIFY_TOKEN: 'test-verify-token',
  PC_SECRET: 'test-pc-secret',
  PHONE_NUMBER_ID: '1234567890',
  MY_NUMBER: '447700900123',
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: TEST_SECRETS },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
