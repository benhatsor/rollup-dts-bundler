/**
 * Pipeline stage 2 — declaration emit. Runs once per tsconfig group.
 *
 * Loads the group's tsconfig (resolving any `extends` chains), overrides the
 * options required for declaration emit, and runs `program.emit()` to write
 * a `.d.ts` per entry into the group's scratch dir for stage 3 (api-extractor)
 * to bundle.
 *
 * Returns each entry paired with the path of its emitted `.d.ts`, located via
 * `ts.getOutputFileNames` so `rootDir` and common-source-directory rules are honored.
 */

import ts from 'typescript'
import { dirname } from 'node:path'
import type { PluginContext } from 'rollup'
import type { Entry } from './entries'

export interface EmittedEntry {
  entry: Entry
  dtsPath: string
}

// Format TS diagnostics with color and source context, then forward them
// through Rollup's `ctx.warn` / `ctx.error` so compiler messages appear
// inline with Rollup's normal output instead of going to stdout.
const formatHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: () => process.cwd(),
  getCanonicalFileName: (f) => f,
  getNewLine: () => '\n',
}
function reportDiagnostics(ctx: PluginContext, diags: readonly ts.Diagnostic[]): void {
  const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error)
  const warnings = diags.filter((d) => d.category === ts.DiagnosticCategory.Warning)
  /* v8 ignore next -- TS6 rarely emits Warning-category diagnostics in practice */
  if (warnings.length) ctx.warn(ts.formatDiagnosticsWithColorAndContext(warnings, formatHost))
  if (errors.length) ctx.error(ts.formatDiagnosticsWithColorAndContext(errors, formatHost))
}

export function emitDeclarations(
  ctx: PluginContext,
  tsconfigPath: string,
  entries: Entry[],
  declarationDir: string,
): EmittedEntry[] {

  const report = (diags: readonly ts.Diagnostic[]) => reportDiagnostics(ctx, diags)

  // Use `getParsedCommandLineOfConfigFile` (rather than the simpler
  // `readConfigFile`) so `extends` chains are resolved.
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => report([d]),
  })
  /* v8 ignore next -- `onUnRecoverableConfigFileDiagnostic` already aborts via ctx.error before this runs */
  if (!parsed) ctx.error(`Failed to load tsconfig: ${tsconfigPath}`)
  report(parsed.errors)

  // Use the user's tsconfig as a base while forcing emit-friendly
  // options so api-extractor always has `.d.ts` to read.
  const emitOptions: ts.CompilerOptions = {
    ...parsed.options,
    // `noEmit` is common in type-check-only configs (build handled
    // elsewhere); leaving it on would make `program.emit()` a no-op and
    // leave api-extractor with nothing to read.
    noEmit: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    // `.js` won't produce declarations anyway, so skip type-checking it.
    checkJs: false,
    // Skip type-checking `.d.ts` files. Without this, TS validates every
    // declaration it loads — including third-party ones — so common real-world
    // issues (e.g. two deps pulling in conflicting `@types/*` versions) would
    // surface as errors and abort the build. That validation isn't needed
    // here: we only need `.d.ts` output for api-extractor to consume.
    skipLibCheck: true,
    declarationDir,
    // Why we set `rootDir` explicitly:
    //   - `rootDir` is TS's commonSourceDirectory — the prefix stripped
    //     from each source path to derive its emit path, and the path every
    //     source file is required to live under (TS6059).
    //   - Setting `declarationDir` without `rootDir` triggers TS5011 in
    //     TS 6+, so a value is required.
    //   - The wrong choice would silently shift the emit layout. We default
    //     to `dirname(tsconfigPath)` because that's what `getCommonSourceDirectory`
    //     falls back to when `rootDir` is unset — i.e. the layout TS would
    //     have produced if not for our `declarationDir` override.
    //
    // References:
    //   - TS5011 enforcement:
    //     https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/program.ts#L4262-L4289
    //   - TS6059 (`rootDir` constraint):
    //     https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/program.ts#L3978-L3997
    //   - `getCommonSourceDirectory` uses `rootDir` when set, else `dirname(configFilePath)`:
    //     https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/emitter.ts#L644-L652
    rootDir: parsed.options.rootDir ?? dirname(tsconfigPath),
  }
  const program = ts.createProgram(parsed.fileNames, emitOptions)
  const emitResult = program.emit()
  report([...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics])

  // Use TS's native resolver (`ts.getOutputFileNames`) to find each emitted
  // `.d.ts` rather than reconstructing the path ourselves, so `rootDir` and
  // common-source-directory rules are honored.
  //
  //   - `ts.getOutputFileNames`:
  //     https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/emitter.ts#L710
  const emitConfig: ts.ParsedCommandLine = { ...parsed, options: emitOptions }
  return entries.map((entry) => {
    const dtsPath = ts
      .getOutputFileNames(emitConfig, entry.entryAbsPath, false)
      .find((f) => /\.d\.ts$/.test(f))
    /* v8 ignore next -- `getOutputFileNames` always yields a .d.ts when declaration emit is on */
    if (!dtsPath) ctx.error(`Could not locate emitted .d.ts for entry: ${entry.entryAbsPath}`)
    return { entry, dtsPath }
  })
  
}
