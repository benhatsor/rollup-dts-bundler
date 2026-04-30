/**
 * Pipeline stage 2: declaration emit. Runs once per tsconfig group.
 *
 * Loads the group's tsconfig (resolving `extends` chains), overrides the
 * options required for declaration emit, and runs tsc's `program.emit()` to
 * write one `.d.ts` per entry into the group's scratch dir, for stage 3
 * (api-extractor) to bundle.
 *
 * Returns each entry paired with the path of its emitted `.d.ts`, located
 * via `ts.getOutputFileNames` so `rootDir` and common-source-directory
 * rules are honored.
 */

import ts from 'typescript'
import { dirname } from 'node:path'
import type { PluginContext } from 'rollup'
import type { Entry } from './entries'

export interface EmittedEntry {
  entry: Entry
  dtsPath: string
}

// Format TS diagnostics with color and source context, then forward
// them through Rollup's `ctx.warn` / `ctx.error` so they appear inline
// with the rest of Rollup's output.
const formatHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: () => process.cwd(),
  getCanonicalFileName: (f) => f,
  getNewLine: () => '\n',
}
function reportDiagnostics(ctx: PluginContext, diags: readonly ts.Diagnostic[]): void {
  const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error)
  const warnings = diags.filter((d) => d.category === ts.DiagnosticCategory.Warning)
  /* v8 ignore next -- TS6 rarely emits Warning-category diagnostics in practice @@@ */
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

  // We use `getParsedCommandLineOfConfigFile` rather than the
  // simpler `readConfigFile`, so `extends` chains are resolved.
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => report([d]),
  })
  /* v8 ignore next -- `onUnRecoverableConfigFileDiagnostic` already aborts via ctx.error before this runs */
  if (!parsed) ctx.error(`Failed to load tsconfig: ${tsconfigPath}`)
  report(parsed.errors)

  // Take the user's tsconfig as a base and force emit-friendly options,
  // so api-extractor always has `.d.ts` files to read.
  const emitOptions: ts.CompilerOptions = {
    ...parsed.options,
    // User configs often set `noEmit: true` for typecheck-only setups;
    // force it off so `program.emit()` actually writes.
    noEmit: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    // `.js` files won't produce declarations anyway, so skip type-checking them.
    checkJs: false,
    // Skip type-checking `.d.ts` files. Without this, TS validates every
    // declaration it loads — including third-party ones — so common issues
    // (e.g. two deps pulling in conflicting `@types/*` versions) abort the build.
    // The check isn't needed: api-extractor is the only consumer of the output.
    skipLibCheck: true,
    declarationDir,
    // Why we set `rootDir` explicitly:
    //   - It's TS's `commonSourceDirectory` — the prefix stripped from each
    //     source path to derive its emit path, and the path every source
    //     file must live under (TS6059).
    //   - Setting `declarationDir` without `rootDir` triggers TS5011 in
    //     TS 6+, so a value is required.
    //   - The wrong value would silently shift the emit layout.
    //     `dirname(tsconfigPath)` matches `getCommonSourceDirectory`'s
    //     fallback when `rootDir` is unset, preserving the layout TS would
    //     have produced absent the `declarationDir` override.
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

  // Locate each emitted `.d.ts` via `ts.getOutputFileNames` rather than
  // manually reconstructing the path, so `rootDir` and common-source-directory
  // rules are honored.
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
