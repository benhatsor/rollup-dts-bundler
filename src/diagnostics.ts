/**
 * Formats TS diagnostics with color + source context and routes them through
 * Rollup's `ctx.warn` / `ctx.error` so they appear in Rollup's normal output
 * instead of TS writing straight to stdout.
 */

import ts from 'typescript'
import type { PluginContext } from 'rollup'

export type Report = (diags: readonly ts.Diagnostic[]) => void

export function createReporter(ctx: PluginContext, cwd: string): Report {
  const formatHost: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => cwd,
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  }
  return (diags) => {
    const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error)
    const warnings = diags.filter((d) => d.category === ts.DiagnosticCategory.Warning)
    if (warnings.length) ctx.warn(ts.formatDiagnosticsWithColorAndContext(warnings, formatHost))
    if (errors.length) ctx.error(ts.formatDiagnosticsWithColorAndContext(errors, formatHost))
  }
}
