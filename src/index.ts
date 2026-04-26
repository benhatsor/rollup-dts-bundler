/**
 * Plugin entry — Rollup build-phase hooks. One of two files
 * (along with `bundle.ts`) that make up the plugin's surface to Rollup.
 *
 * The plugin shell is intentionally thin. Its only job during the build phase is
 * to give every entry a chunk we can later replace with a bundled `.d.ts`, by:
 *   - marking every non-entry import as external, so Rollup never walks the
 *     import graph; and
 *   - returning an empty source for each entry, so Rollup produces one stub JS
 *     chunk per entry anchored to its `facadeModuleId`.
 *
 * The real work — emitting `.d.ts` files from the entries and bundling the emitted
 * declarations with api-extractor — is deferred to the `generateBundle` hook,
 * which hands off to `bundleDeclarations` in `bundle.ts`.
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
      // Entries (no importer): defer to Rollup's default resolver, so the
      // resulting chunk gets an absolute `facadeModuleId` we can map back
      // to its emitted `.d.ts` later in the pipeline.
      if (!importer) {
        if (!/\.tsx?$/.test(source)) {
          this.error(`Entry point must be a .ts or .tsx file, got: ${source}`)
        }
        return null
      }
      // Everything reachable from an entry is marked external — Rollup
      // never walks the import graph, so each entry stays self-contained.
      return { id: source, external: true }
    },

    // Anything reaching `load` is an entry (non-entries were marked external
    // above). Returning empty code makes Rollup emit one stub JS chunk per
    // entry, which `generateBundle` will later swap for a bundled `.d.ts` asset.
    load() {
      return { code: '', moduleSideEffects: 'no-treeshake' }
    },

    async generateBundle(options, bundle) {
      await bundleDeclarations(this, bundle, options, opts)
    },
  }
}
