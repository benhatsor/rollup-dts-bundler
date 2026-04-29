/**
 * Rollup build-phase hooks. Paired with `bundle.ts`, which implements
 * `generateBundle`.
 *
 * During the build phase, the plugin emits one stub JS chunk per entry:
 *   - non-entry imports are marked external, so Rollup does not walk the
 *     import graph;
 *   - entries resolve to empty source, producing a stub chunk anchored to
 *     each entry's `facadeModuleId`.
 *
 * Declaration emit and api-extractor bundling run later in the `generateBundle`
 * hook, which delegates to `bundleDeclarations` in `bundle.ts`.
 */

import type { Plugin } from 'rollup'
import { bundleDeclarations } from './bundle'

export interface DtsOptions {
  /**
   * Path to a tsconfig.json (relative to cwd, or absolute). If omitted, each
   * entry uses its own nearest tsconfig, and entries under different configs
   * are processed separately.
   */
  tsconfig?: string

  /**
   * npm package names whose declarations should be inlined into the output
   * instead of left as external imports. Useful for re-exporting types from
   * internal workspace packages.
   */
  bundledPackages?: string[]
}

export function dts(opts: DtsOptions = {}): Plugin {
  return {
    name: 'rollup-dts-bundler',

    resolveId(source, importer) {
      // Entries fall through to Rollup's default resolver so each chunk
      // gets an absolute `facadeModuleId`, which is used downstream to
      // locate its emitted `.d.ts`.
      if (!importer) {
        if (!/\.tsx?$/.test(source)) {
          this.error(`Entry point must be a .ts or .tsx file, got: ${source}`)
        }
        return null
      }
      // Non-entry imports are marked external, so Rollup dosen't walk
      // the import graph.
      return { id: source, external: true }
    },

    // Only entries reach `load`. Returning an empty source produces a stub JS chunk
    // per entry, which `generateBundle` later replaces with a bundled `.d.ts` asset.
    load() {
      return { code: '', moduleSideEffects: 'no-treeshake' }
    },

    async generateBundle(options, bundle) {
      await bundleDeclarations(this, bundle, options, opts)
    },
  }
}
