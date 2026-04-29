/**
 * Pipeline stage 1: entry discovery and grouping.
 *
 * `collectEntries` pairs each Rollup chunk with its source entry's
 * absolute path; stage 2 uses that path to locate the emitted `.d.ts`.
 *
 * `groupByTsconfig` partitions entries by tsconfig: either an override
 * or each entry's nearest `tsconfig.json`. Stages 2 and 3 then run once
 * per group, with entries in the same group sharing a TS program in
 * stage 2 and a `CompilerState` in stage 3.
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

// With an override, all entries collapse into a single group. Without one,
// each entry walks up to its nearest `tsconfig.json`; entries landing on
// the same config share a group — and, downstream, a TS program.
export function groupByTsconfig(
  ctx: PluginContext,
  entries: Entry[],
  override: string | undefined,
  cwd: string,
): Map<string, Entry[]> {

  const groups = new Map<string, Entry[]>()

  for (const entry of entries) {
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
