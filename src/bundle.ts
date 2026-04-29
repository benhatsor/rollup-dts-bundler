/**
 * `generateBundle` handler — invoked once the chunk graph is assembled. One
 * of two files (along with `index.ts`) that make up the plugin's surface to
 * Rollup. Runs once per Rollup output, after `index.ts`'s build hooks have
 * populated the bundle with stub chunks.
 *
 * `bundleDeclarations` orchestrates the three pipeline stages, then calls
 * `emitBundledAssets` to swap each stub chunk for its bundled `.d.ts`.
 *
 * Flow:
 *   - Set up a scratch tempdir under Rollup's output dir
 *     (location matters — see note below).
 *   - Stage 1: collect entries and partition them by tsconfig
 *     (`collectEntries` + `groupByTsconfig`).
 *   - Stages 2 and 3 run inside a per-group loop, sharing a TS program:
 *       2. emit `.d.ts` with `tsc`        — `emitDeclarations`
 *       3. bundle them with api-extractor — `buildTasks` + `runExtractors`
 *   - Final step: swap stub chunks for bundled `.d.ts` assets
 *     (`emitBundledAssets`).
 */

import type { NormalizedOutputOptions, OutputBundle, PluginContext } from 'rollup'
import { join, dirname } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { collectEntries, groupByTsconfig } from './entries'
import { emitDeclarations } from './emit'
import { buildTasks, runExtractors, type ExtractTask } from './extractor'
import type { DtsOptions } from './index'

// Standard cache-directory tag (https://bford.info/cachedir/) — backup tools
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

  // The scratch dir's location is constrained from both directions by how
  // api-extractor (via TS) resolves modules from our emitted `.d.ts` files:
  //
  //   - It must not sit under `node_modules/`. TS flags any path containing
  //     `/node_modules/` as `isExternalLibraryImport`, which would make
  //     api-extractor misclassify our internal modules as third-party.
  //   - It must sit under the project root. Emitted `.d.ts` files import real
  //     packages, and api-extractor resolves them by walking up from each
  //     scratch file looking for `node_modules` — `os.tmpdir()` would walk
  //     all the way to `/` and find nothing.
  //
  // So we put it inside Rollup's output dir, falling back to cwd if the
  // caller used `rollup().generate()` with neither `output.dir` nor
  // `output.file`. The `.gitignore` and `CACHEDIR.TAG` written below keep
  // crash leftovers out of Git and backup tools.
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
      // One subdir per group: source paths from different TS programs would
      // otherwise collide if they shared a single `declarationDir`.
      const groupDir = join(tempDir, `g${groupIndex++}`)
      mkdirSync(groupDir, { recursive: true })

      const emitted = emitDeclarations(ctx, tsconfigPath, groupEntries, groupDir)
      const tasks = buildTasks(ctx, {
        tsconfigPath,
        emitted,
        bundledPackages: opts.bundledPackages,
      })
      runExtractors(ctx, tasks)

      await emitBundledAssets(ctx, tasks, bundle, options)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

}

// Final step of `bundleDeclarations` — replace each stub JS chunk with a
// `.d.ts` asset at the same path. We delete the chunk and re-emit as an
// asset (rather than just mutating `chunk.code`) so downstream plugins and
// sourcemap handling stop treating the output as JS.
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
