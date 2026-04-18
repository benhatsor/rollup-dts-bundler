/**
 * Pipeline for each Rollup output:
 *   1. Make a scratch tempdir inside Rollup's output dir (so TS module
 *      resolution can see the user's `node_modules`).
 *   2. Collect entries from the bundle and group them by tsconfig.
 *   3. For each group: emit `.d.ts` with `tsc`, bundle with api-extractor,
 *      then swap Rollup's stub JS chunks for the bundled `.d.ts` assets.
 */

import type { NormalizedOutputOptions, OutputBundle, PluginContext } from 'rollup'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, mkdtempDisposableSync } from 'node:fs'
import { createReporter } from './diagnostics'
import { collectEntries, groupByTsconfig } from './entries'
import { emitDeclarations } from './emit'
import { buildTasks, runExtractors, type ExtractTask } from './extractor'
import type { DtsOptions } from './index'

export async function bundleDeclarations(
  ctx: PluginContext,
  bundle: OutputBundle,
  options: NormalizedOutputOptions,
  opts: DtsOptions,
): Promise<void> {
  
  const cwd = process.cwd()

  // Put the scratch dir inside Rollup's output dir so TS module resolution
  // can find the user's `node_modules`. Fall back to cwd if the caller used
  // `rollup().generate()` with neither `output.dir` nor `output.file`.
  const outputDir =
    options.dir ?? (options.file ? dirname(options.file) : cwd)

  mkdirSync(outputDir, { recursive: true })

  using tempDir = mkdtempDisposableSync(join(outputDir, '.rollup-dts-bundler-'))

  const report = createReporter(ctx, cwd)
  const entries = collectEntries(ctx, bundle)
  if (entries.length === 0) return
  const groups = groupByTsconfig(ctx, entries, opts.tsconfig, cwd)

  let groupIndex = 0
  for (const [tsconfigPath, groupEntries] of groups) {
    // Each group gets its own subdir so source paths from different programs
    // can't collide in a shared `declarationDir`.
    const groupDir = join(tempDir.path, `g${groupIndex++}`)
    mkdirSync(groupDir, { recursive: true })

    const emitted = emitDeclarations(ctx, tsconfigPath, groupEntries, groupDir, report)
    const tasks = buildTasks(ctx, {
      tsconfigPath,
      groupDir,
      emitted,
      bundledPackages: opts.bundledPackages,
    })
    runExtractors(ctx, tasks)

    await emitBundledAssets(ctx, tasks, bundle, options)
  }

}

// Replace each stub JS chunk with a .d.ts asset at the same path. We delete
// and re-emit (rather than mutating `chunk.code`) so downstream plugins and
// sourcemap handling don't treat the output as JS.
async function emitBundledAssets(
  ctx: PluginContext,
  tasks: ExtractTask[],
  bundle: OutputBundle,
  options: NormalizedOutputOptions,
): Promise<void> {

  for (const { entry, bundledDtsPath } of tasks) {

    const dtsContent = readFileSync(bundledDtsPath, 'utf-8')
    const banner = await options.banner(entry.chunk)

    delete bundle[entry.fileName]

    ctx.emitFile({
      type: 'asset',
      fileName: entry.fileName,
      source: banner ? `${banner}\n${dtsContent}` : dtsContent,
    })

  }

}
