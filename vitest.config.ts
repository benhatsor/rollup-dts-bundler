/**
 * Tests spawn full TypeScript + api-extractor pipelines per assertion and
 * run in parallel across test files, so individual runs can exceed the
 * default 5s timeout under CPU contention.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 30_000, // 30s
  },
})
