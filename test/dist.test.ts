/**
 * Smoke test against the built `dist/` artifact — what `npm publish` ships.
 * The source-level suite can pass while `dist/` is broken (bad rollup config,
 * missing externalization, stripped exports), so we verify the published
 * shape end-to-end before release.
 *
 * `beforeAll` rebuilds `dist/` so the test runs against a fresh artifact
 * regardless of CI step order or local state.
 */

import { test, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { rollup } from 'rollup'
import { withFixture } from './helpers'

const distEntry = join(import.meta.dirname, '..', 'dist', 'index.js')

beforeAll(() => {
  // Always rebuild — a stale dist out-of-sync with current source is a
  // failure mode this test exists to catch. `stdio: 'pipe'` keeps rollup's
  // build output quiet on success; failures still throw with captured output.
  execSync('npm run build', { stdio: 'pipe' })
}, 60_000)

test('built dist/ bundles a fixture end-to-end', async () => {
  // Import the published artifact, not the source. Catches issues only
  // visible after rollup bundling (broken `exports`, mis-bundled deps,
  // missing externalization of `@microsoft/api-extractor`, etc.).
  const mod = await import(distEntry)

  // Surface check — what consumers `import` from the package.
  expect(typeof mod.dts).toBe('function')

  // Run the plugin from dist against the simplest fixture.
  const output = await withFixture('basic', async () => {
    const build = await rollup({ input: 'src/index.ts', plugins: [mod.dts()] })
    const { output: chunks } = await build.generate({ format: 'es' })
    // The plugin always emits `.d.ts` content as a string asset; guard
    // narrows the `string | Uint8Array` union and surfaces a clear failure
    // if that contract ever changes.
    const asset = chunks.find((c) => c.type === 'asset')
    if (!asset || typeof asset.source !== 'string') {
      throw new Error('expected a single string .d.ts asset')
    }
    return asset.source
  })

  expect(output).toContain('interface Options')
  expect(output).toContain('function greet')
})
