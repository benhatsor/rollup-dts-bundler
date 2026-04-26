/**
 * Pipeline stage 1 — entry discovery and grouping. Runs once per Rollup
 * output, before the per-group work in stages 2 and 3 begins.
 *
 * `collectEntries` walks Rollup's output bundle and pairs each chunk with the
 * absolute path of its source entry module. `emitDeclarations` uses that path
 * in stage 2 to locate each entry's emitted `.d.ts`.
 *
 * `groupByTsconfig` then partitions those entries by tsconfig — either the
 * user's override (one group covering everything) or each entry's nearest
 * `tsconfig.json`. Entries that share a tsconfig share a TS program in
 * stage 2, which lets api-extractor reuse a single `CompilerState` across
 * the group in stage 3.
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

// With an override, every entry collapses into a single group. Without one,
// each entry walks up from its own directory to the nearest `tsconfig.json`;
// entries that land on the same config share a group — and, downstream, a
// TS program.
export function groupByTsconfig(
  ctx: PluginContext,
  entries: Entry[],
  override: string | undefined,
  cwd: string,
): Map<string, Entry[]> {

  const groups = new Map<string, Entry[]>()

  for (const entry of entries) {
    // If an override was given, resolve it relative to cwd. Otherwise,
    // let TS's own resolver walk up from the entry's directory to the
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
