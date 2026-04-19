/**
 * Entry discovery and grouping.
 *
 * `collectEntries` pairs each output chunk with its source module's absolute path,
 * so we can later resolve where each chunk's respective emitted `.d.ts` file lands.
 *
 * `groupByTsconfig` splits entries by tsconfig — using either the user's
 * override (a single group) or each entry's nearest `tsconfig.json`. Entries sharing
 * a tsconfig share a TS program, letting api-extractor reuse a single `CompilerState`.
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

// If there's an override, all entries go in one group. Otherwise, each entry
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
    // If an override was given, resolve it relative to cwd. Otherwise let
    // TypeScript's own resolver walk up from the entry's directory to the
    // nearest `tsconfig.json`.
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
