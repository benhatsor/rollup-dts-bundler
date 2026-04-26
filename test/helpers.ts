/**
 * Shared test helpers.
 */

import { rollup, type InputOption, type OutputOptions } from 'rollup'
import { join } from 'node:path'
import { dts, type DtsOptions } from '../src/index'

const fixturesDir = join(import.meta.dirname, 'fixtures')

/**
 * Runs `fn` with the process cwd pointed at the named fixture, restoring the
 * original cwd afterward (even on error). The plugin resolves tsconfig and
 * `node_modules` relative to cwd, so each fixture is a self-contained "project
 * root" and tests must chdir into it before invoking Rollup.
 */
export async function withFixture<T>(fixture: string, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd()
  try {
    process.chdir(join(fixturesDir, fixture))
    return await fn()
  } finally {
    process.chdir(cwd)
  }
}

/**
 * Options accepted by `bundle` / `bundleOne`.
 */
export interface BundleOpts {
  /**
   * Rollup input; defaults to `'src/index.ts'` (the conventional
   * single-entry fixture layout). Pass a record for multi-entry fixtures.
   */
  input?: InputOption
  /**
   * Merged into Rollup's `generate` options (on top of `format: 'es'`).
   */
  output?: OutputOptions
  /**
   * Forwarded to `dts(...)`.
   */
  plugin?: DtsOptions
}

/**
 * Runs the full Rollup pipeline against a fixture and returns every emitted
 * asset keyed by Rollup's output fileName. Rejections from `rollup()` or
 * `generate()` propagate unchanged (error-case tests rely on this).
 *
 * The returned keys are whatever filenames Rollup picked. Rollup is a JS
 * bundler and its default `entryFileNames` is `'[name].js'`, so keys end in
 * `.js` by default, even though they map to `.d.ts` content; the plugin always
 * reuses Rollup's name rather than risk changing what the user intended. Tests
 * that care about the keys should pass `output: { entryFileNames: '[name].d.ts' }`.
 */
export async function bundle(fixture: string, opts: BundleOpts = {}): Promise<Record<string, string>> {

  const { input = 'src/index.ts', output = {}, plugin } = opts

  return withFixture(fixture, async () => {

    const build = await rollup({ input, plugins: [dts(plugin)] })

    const { output: chunks } = await build.generate({ format: 'es', ...output })

    // `OutputAsset.source` is `string | Uint8Array`; the plugin always
    // emits strings for `.d.ts`, but the typeof check makes that explicit
    // and gives a clear error if the contract ever changes.
    return Object.fromEntries(
      chunks.filter(c => c.type === 'asset').map(c => {
        if (typeof c.source !== 'string') {
          throw new Error(`expected string asset source for ${c.fileName}`)
        }
        return [c.fileName, c.source]
      }),
    )

  })

}

/**
 * Single-entry convenience: same as `bundle`, but asserts exactly one asset
 * was emitted and returns its source directly. Lets single-entry happy-path
 * tests skip the Rollup-invented filename (see `bundle`'s note) and just
 * assert against the `.d.ts` content.
 *
 * The runtime length check guards against a test accidentally producing
 * multiple outputs (e.g. a misconfigured fixture), as a silent first-element
 * return would mask the bug.
 */
export async function bundleOne(fixture: string, opts: BundleOpts = {}): Promise<string> {

  const assets = Object.values(await bundle(fixture, opts))
  const [single, ...extras] = assets
  if (!single || extras.length > 0) {
    throw new Error(`Expected 1 asset, got ${assets.length}`)
  }
  return single

}
