/**
 * Entry discovery and grouping.
 *
 * `collectEntries` pairs each output chunk with the absolute path of its
 * source module so later stages can ask TS where the `.d.ts` landed.
 *
 * `groupByTsconfig` splits entries by tsconfig — either the user's override
 * (one group) or each entry's nearest `tsconfig.json`. Entries sharing a
 * tsconfig share a TS program, letting api-extractor reuse one `CompilerState`.
 */

import type { OutputBundle, OutputChunk, PluginContext } from 'rollup'
import { resolve, dirname } from 'node:path'
import ts from 'typescript'

export interface Entry {
  fileName: string
  chunk: OutputChunk
  entryAbsPath: string
}

export function collectEntries(ctx: PluginContext, bundle: OutputBundle): Entry[] {
  return Object.entries(bundle).flatMap(([fileName, chunk]) => {
    if (chunk.type !== 'chunk') return []
    if (!chunk.facadeModuleId) ctx.error(`Could not determine entry module for chunk: ${fileName}`)
      
    return [{ fileName, chunk, entryAbsPath: chunk.facadeModuleId }]
  })
}

// With an override, all entries go in one group. Without one, each entry
// walks up from its own directory; entries that land on the same tsconfig
// end up in the same group and share a TS program downstream.
export function groupByTsconfig(
  ctx: PluginContext,
  entries: Entry[],
  override: string | undefined,
  cwd: string,
): Map<string, Entry[]> {

  const groups = new Map<string, Entry[]>()

  for (const entry of entries) {
    // If user defined an override, resolve path relative to cwd.
    // Otherwise, use TypeScript's native resolver.
    const tsconfigPath = override
      ? resolve(cwd, override)
      : ts.findConfigFile(dirname(entry.entryAbsPath), ts.sys.fileExists)

    if (!tsconfigPath) ctx.error(`Could not find a tsconfig.json from ${entry.entryAbsPath}`)

    const list = groups.get(tsconfigPath) ?? []
    list.push(entry)
    groups.set(tsconfigPath, list)
  }

  return groups

}
