/**
 * Declaration emit for a tsconfig group.
 *
 * Loads the tsconfig (resolving `extends`), forces emit-friendly options, and
 * runs `program.emit()` to drop `.d.ts` files into the group's scratch dir
 * for api-extractor to consume.
 *
 * Returns each entry paired with its emitted `.d.ts` path, resolved via
 * `ts.getOutputFileNames` (which handles `rootDir` / common-source-directory
 * rules properly instead of just splicing the path).
 */

import ts from 'typescript'
import { dirname } from 'node:path'
import type { PluginContext } from 'rollup'
import type { Entry } from './entries'
import type { Report } from './diagnostics'

export interface EmittedEntry {
  entry: Entry
  dtsPath: string
}

export function emitDeclarations(
  ctx: PluginContext,
  tsconfigPath: string,
  entries: Entry[],
  declarationDir: string,
  report: Report,
): EmittedEntry[] {

  // Use `getParsedCommandLineOfConfigFile` so `extends` chains are resolved.
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => report([d]),
  })
  if (!parsed) ctx.error(`Failed to load tsconfig: ${tsconfigPath}`)
  report(parsed.errors)

  // Force emit-friendly options so api-extractor always has `.d.ts` to read.
  const emitOptions: ts.CompilerOptions = {
    ...parsed.options,
    // Common in type-check-only configs (build handled elsewhere); if left on,
    // `program.emit()` would be a no-op and api-extractor would get nothing.
    noEmit: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    // Skip type-checking .js we'd never emit declarations for anyway.
    checkJs: false,
    // Skip type-checking `.d.ts` files. Without this, TS validates every
    // declaration it loads — including third-party ones — so common real-world
    // issues (e.g. two deps pulling in conflicting `@types/*` versions) would
    // surface as errors and abort the build. That validation buys us nothing
    // here: we only need `.d.ts` output for api-extractor to consume.
    skipLibCheck: true,
    declarationDir,
    // `rootDir` is TS's commonSourceDirectory: the prefix stripped from each
    // source path to derive its emit path (and thus the path every source
    // file must live under — TS6059). Our `declarationDir` override trips
    // TS 6's TS5011 unless `rootDir` is set explicitly, and a careless choice
    // would silently shift emit layout. So we default it to
    // `dirname(tsconfigPath)` — the value `getCommonSourceDirectory` resolves
    // to internally when `rootDir` is unset — preserving the layout TS would
    // have produced without our `declarationDir` override.
    //
    // - TS5011 enforcement: https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/program.ts#L4262-L4289
    // - TS6059 (`rootDir` constraint): https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/program.ts#L3978-L3997
    // - `getCommonSourceDirectory` uses `rootDir` when set, else `dirname(configFilePath)`: https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/emitter.ts#L644-L652
    rootDir: parsed.options.rootDir ?? dirname(tsconfigPath),
  }
  const program = ts.createProgram(parsed.fileNames, emitOptions)
  const emitResult = program.emit()
  report([...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics])

  // Use TS's native resolver to find where each `.d.ts` landed, rather than
  // reconstructing the path ourselves — the resolver correctly applies
  // `rootDir` and common-source-directory rules.
  //
  // See `ts.getOutputFileNames`: https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/emitter.ts#L710
  const emitConfig: ts.ParsedCommandLine = { ...parsed, options: emitOptions }
  return entries.map((entry) => {
    const dtsPath = ts
      .getOutputFileNames(emitConfig, entry.entryAbsPath, false)
      .find((f) => /\.d\.ts$/.test(f))
    if (!dtsPath) ctx.error(`Could not locate emitted .d.ts for entry: ${entry.entryAbsPath}`)
    return { entry, dtsPath }
  })
  
}
