/**
 * `generateBundle` handler. Paired with `index.ts`, which populates the
 * bundle with stub chunks during the build phase. Runs once per Rollup output.
 *
 * `bundleDeclarations` drives the pipeline:
 *
 *   1. Allocate a scratch tempdir under Rollup's output dir
 *      (location is constrained; see note below).
 *   2. Collect entries and partition them by tsconfig
 *      (`collectEntries` + `groupByTsconfig`).
 *   3. For each tsconfig group:
 *        a. Emit `.d.ts` with `tsc`        — `emitDeclarations`.
 *        b. Bundle them with api-extractor — `buildTasks` + `runExtractors`.
 *   4. Replace each stub chunk with its bundled `.d.ts`
 *      (`emitBundledAssets`).
 */

import type { NormalizedOutputOptions, OutputBundle, PluginContext } from 'rollup'
import { join, dirname } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { collectEntries, groupByTsconfig } from './entries'
import { emitDeclarations } from './emit'
import { buildTasks, runExtractors, type ExtractTask } from './extractor'
import type { DtsOptions } from './index'

// Standard cache-directory tag (https://bford.info/cachedir/). Backup tools
// detect this signature and skip the directory's contents.
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

  // The scratch dir's location is constrained on both sides by how
  // api-extractor (via TS) resolves modules from emitted `.d.ts` files:
  //
  //   - Not under `node_modules/`: TS flags any path containing
  //     `/node_modules/` as `isExternalLibraryImport`, causing
  //     api-extractor to misclassify internal modules as third-party.
  //   - Under the project root: emitted `.d.ts` files import real
  //     packages, and api-extractor resolves them by walking up looking
  //     for `node_modules`; `os.tmpdir()` would walk to `/` and find none.
  //
  // The dir therefore sits inside Rollup's output dir, falling back to cwd
  // when `rollup().generate()` is called with neither `output.dir` nor
  // `output.file`. The `.gitignore` and `CACHEDIR.TAG` below keep crash
  // leftovers out of Git and backup tools.
  //
  // Source references — `isExternalLibraryImport` check:
  //   - api-extractor reads `resolvedModule.isExternalLibraryImport`:
  //     https://github.com/microsoft/rushstack/blob/488875fdd2027136bba2e72d0930136b0cab0324/apps/api-extractor/src/analyzer/ExportAnalyzer.ts#L312
  //   - TS's `tryResolve` sets it from `pathContainsNodeModules(resolved.path)`:
  //     https://github.com/microsoft/TypeScript/blob/55423abe4d029017f19b6e4c32097591994836b4/src/compiler/moduleNameResolver.ts#L1917
  //   - `createResolvedModuleWithFailedLookupLocations` exposes that flag on the public field:
  //     https://github.com/microsoft/TypeScript/blob/55423abe4d029017f19b6e4c32097591994836b4/src/compiler/moduleNameResolver.ts#L290
  //
  // Source references — `node_modules` walk-up:
  //   - api-extractor invokes TS resolution via `getResolvedModule`, passing the importing source file:
  //     https://github.com/microsoft/rushstack/blob/488875fdd2027136bba2e72d0930136b0cab0324/apps/api-extractor/src/analyzer/ExportAnalyzer.ts#L283
  //   - TS walks ancestor directories of that file via `forEachAncestorDirectoryStoppingAtGlobalCache`:
  //     https://github.com/microsoft/TypeScript/blob/55423abe4d029017f19b6e4c32097591994836b4/src/compiler/moduleNameResolver.ts#L3029
  const outputDir =
    options.dir ?? (options.file ? dirname(options.file) : cwd)
  mkdirSync(outputDir, { recursive: true })

  const tempDir = mkdtempSync(join(outputDir, '.rollup-dts-bundler-'))
  try {
    writeFileSync(join(tempDir, '.gitignore'), '*')
    writeFileSync(join(tempDir, 'CACHEDIR.TAG'), CACHEDIR_TAG)

    const entries = collectEntries(ctx, bundle)
    if (entries.length === 0) return
    const groups = groupByTsconfig(ctx, entries, opts.tsconfig, cwd)

    let groupIndex = 0
    for (const [tsconfigPath, groupEntries] of groups) {
      // One subdir per group; source paths from different TS programs
      // would otherwise collide under a shared `declarationDir`.
      const groupDir = join(tempDir, `g${groupIndex++}`)
      mkdirSync(groupDir, { recursive: true })

      const emitted = emitDeclarations(ctx, tsconfigPath, groupEntries, groupDir)
      const tasks = buildTasks(ctx, {
        tsconfigPath,
        emitted,
        bundledPackages: opts.bundledPackages,
      })
      runExtractors(tasks)

      await emitBundledAssets(ctx, tasks, bundle, options)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

}

// Final step of `bundleDeclarations`: replace each stub JS chunk with a
// `.d.ts` asset at the same path. Rollup's docs warn against mutating
// bundle entries directly, so we use `emitFile`:
// https://rollupjs.org/plugin-development/#generatebundle
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
