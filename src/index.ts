/**
 * Plugin entry point. The plugin itself is intentionally thin: it marks entry
 * modules, stubs their JS so Rollup emits one chunk per entry, and defers the
 * real work (emitting and bundling .d.ts files) to the `generateBundle` hook,
 * calling `./pipeline.ts`'s `bundleDeclarations`.
 */

import type { Plugin } from 'rollup'
import { bundleDeclarations } from './pipeline'

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

export default function dts(opts: DtsOptions = {}): Plugin {
  return {
    name: 'rollup-dts-bundler',

    resolveId(source, importer) {
      // For entries, return null so Rollup's default resolver gives us an
      // absolute `facadeModuleId` later to map back to the emitted .d.ts.
      if (!importer) {
        if (!/\.tsx?$/.test(source)) {
          this.error(`Entry point must be a .ts or .tsx file, got: ${source}`)
        }
        return null
      }
      // Everything else is external so Rollup never walks the import graph.
      return { id: source, external: true }
    },

    // Non-entries are external, so anything reaching `load` is an entry.
    // Return empty code so Rollup emits one chunk per entry with no JS.
    load() {
      return { code: '', moduleSideEffects: 'no-treeshake' }
    },

    async generateBundle(options, bundle) {
      await bundleDeclarations(this, bundle, options, opts)
    },
  }
}
