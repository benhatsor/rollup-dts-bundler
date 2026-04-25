/**
 * Pipeline for each Rollup output:
 *   1. Make a scratch tempdir inside Rollup's output dir (so TS can resolve
 *      imported external modules by walking up to the user's `node_modules`).
 *   2. Collect entries from the bundle and group them by tsconfig.
 *   3. For each group: emit `.d.ts` with `tsc`, bundle with api-extractor,
 *      then swap Rollup's stub JS chunks for the bundled `.d.ts` assets.
 */

import type { NormalizedOutputOptions, OutputBundle, PluginContext } from 'rollup'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, mkdtempDisposableSync } from 'node:fs'
import { createReporter } from './diagnostics'
import { collectEntries, groupByTsconfig } from './entries'
import { emitDeclarations } from './emit'
import { buildTasks, runExtractors, type ExtractTask } from './extractor'
import type { DtsOptions } from './index'

// Standard cache-directory tag (https://bford.info/cachedir/)
// so backup tools auto-skip leftovers.
const CACHEDIR_TAG =
  'Signature: 8a477f597d28d172789f06886806bc55\n' +
  '# This file is a cache directory tag created by rollup-dts-bundler.\n' +
  '# For information about cache directory tags, see https://bford.info/cachedir/\n'

export async function bundleDeclarations(
  ctx: PluginContext,
  bundle: OutputBundle,
  options: NormalizedOutputOptions,
  opts: DtsOptions,
): Promise<void> {

  const cwd = process.cwd()

  // - Scratch (temp) dir can't be under `node_modules/`, as TS flags any path
  //   containing `/node_modules/` as `isExternalLibraryImport`, which would
  //   make api-extractor misclassify our internal modules as third-party.
  // - Scratch dir must be under the project root, as emitted `.d.ts` files import
  //   real packages, and TS resolution (via api-extractor) walks up the file tree
  //   from each scratch file to find `node_modules`. `os.tmpdir()` would walk up
  //   to `/` and wouldn't find it.
  // As such, we've opted to put the scratch directory in rollup's output directory,
  // falling back to cwd if the caller used `rollup().generate()` with neither
  // `output.dir` nor `output.file`. `.gitignore` hides crash leftovers from Git
  // and `CACHEDIR.TAG` makes backup tools skip them.
  //
  // `isExternalLibraryImport` check:
  // - api-extractor uses TS's `resolvedModule.isExternalLibraryImport` to mark external modules:
  //   https://github.com/microsoft/rushstack/blob/488875fdd2027136bba2e72d0930136b0cab0324/apps/api-extractor/src/analyzer/ExportAnalyzer.ts#L312
  // - TS's `tryResolve` sets `isExternalLibraryImport` to `pathContainsNodeModules(resolved.path)`
  //   on a local `SearchResult`: https://github.com/microsoft/TypeScript/blob/55423abe4d029017f19b6e4c32097591994836b4/src/compiler/moduleNameResolver.ts#L1917
  // - `createResolvedModuleWithFailedLookupLocations` then copies that flag onto the public
  //   `resolvedModule.isExternalLibraryImport` field: https://github.com/microsoft/TypeScript/blob/55423abe4d029017f19b6e4c32097591994836b4/src/compiler/moduleNameResolver.ts#L290
  //
  // `node_modules` walk-up:
  // - api-extractor invokes TS module resolution via `getResolvedModule`, passing the importing source file:
  //   https://github.com/microsoft/rushstack/blob/488875fdd2027136bba2e72d0930136b0cab0324/apps/api-extractor/src/analyzer/ExportAnalyzer.ts#L283
  // - TS's `loadModuleFromNearestNodeModulesDirectoryWorker` walks ancestor directories from the containing file
  //   via `forEachAncestorDirectoryStoppingAtGlobalCache`:
  //   https://github.com/microsoft/TypeScript/blob/55423abe4d029017f19b6e4c32097591994836b4/src/compiler/moduleNameResolver.ts#L3029
  const outputDir =
    options.dir ?? (options.file ? dirname(options.file) : cwd)
  mkdirSync(outputDir, { recursive: true })

  using tempDir = mkdtempDisposableSync(join(outputDir, '.rollup-dts-bundler-'))
  writeFileSync(join(tempDir.path, '.gitignore'), '*')
  writeFileSync(join(tempDir.path, 'CACHEDIR.TAG'), CACHEDIR_TAG)

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
