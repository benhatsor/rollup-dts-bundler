/**
 * Declaration emit for one tsconfig group.
 *
 * Loads the tsconfig (resolving `extends`), forces emit-friendly options, and
 * calls `program.emit()` to drop `.d.ts` files into the group's scratch dir.
 * api-extractor reads these next, so we emit even on non-fatal diagnostics.
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

  // Force emit-friendly options so api-extractor always has `.d.ts` files to
  // read, even on non-fatal diagnostics. TS 6 (TS5011) requires an explicit
  // `rootDir` whenever `declarationDir` changes; if the user hasn't set one,
  // we use TS's own default (`dirname(configFilePath)`, see
  // `getCommonSourceDirectory`) so emit paths match `tsc`.
  const emitOptions: ts.CompilerOptions = {
    ...parsed.options,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmitOnError: false,
    skipLibCheck: true,
    declarationDir,
    rootDir: parsed.options.rootDir ?? dirname(tsconfigPath),
  }
  const program = ts.createProgram(parsed.fileNames, emitOptions)
  const emitResult = program.emit()
  report([...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics])

  // Find where each `.d.ts` landed using TypeScript's native resolver.
  // This is better than just reconstructing the path as the native resolver
  // also handles rootDir / common-source-directory rules properly.
  const emitConfig: ts.ParsedCommandLine = { ...parsed, options: emitOptions }
  return entries.map((entry) => {
    const dtsPath = ts
      .getOutputFileNames(emitConfig, entry.entryAbsPath, false)
      .find((f) => /\.d\.ts$/.test(f))
    if (!dtsPath) ctx.error(`Could not locate emitted .d.ts for entry: ${entry.entryAbsPath}`)
    return { entry, dtsPath }
  })
  
}
