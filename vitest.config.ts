
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests spawn full TypeScript + api-extractor pipelines per assertion and
    // run in parallel across test files, so individual runs can exceed the
    // default 5s timeout under CPU contention.
    testTimeout: 30_000, // 30s
    
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 85,
        branches: 65,
        functions: 95,
        lines: 95,
      },
    },
  },
})
