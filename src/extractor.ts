/**
 * api-extractor task construction and invocation.
 *
 * `buildTasks` builds one `ExtractorConfig` per entry, anchored to the
 * tsconfig's directory.
 *
 * `runExtractors` runs every task in a group sharing one `CompilerState`, so
 * TS parses the sources only once. api-extractor's messages are routed
 * through Rollup's diagnostic channels.
 */

import { dirname, join } from 'node:path'
import type { PluginContext } from 'rollup'
import { CompilerState, Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor'
import { PackageJsonLookup } from '@rushstack/node-core-library'
import type { EmittedEntry } from './emit'
import type { Entry } from './entries'

export interface ExtractTask {
  entry: Entry
  extractorConfig: ExtractorConfig
  bundledDtsPath: string
}

export function buildTasks(
  ctx: PluginContext,
  args: {
    tsconfigPath: string
    groupDir: string
    emitted: EmittedEntry[]
    bundledPackages?: string[]
  },
): ExtractTask[] {

  // Anchor to the tsconfig's dir so monorepo groups resolve their own
  // package.json, not the one above Rollup's cwd. api-extractor requires one
  // (see `Collector`), and we use its own `PackageJsonLookup` so resolution
  // can't diverge — notably, it skips nameless package.json files (e.g. a
  // monorepo root with only workspace config) that a plain existence check
  // would stop at.
  const projectFolder = dirname(args.tsconfigPath)

  // Fresh lookup per call (not module-level) so watch-mode rebuilds don't
  // read a stale cache if the user's package.json layout changes.
  const packageJsonFullPath = new PackageJsonLookup().tryGetPackageJsonFilePathFor(projectFolder)
  if (!packageJsonFullPath) {
    ctx.error(`Could not find a named package.json at or above ${projectFolder}`)
  }

  return args.emitted.map(({ entry, dtsPath }) => {

    const bundledDtsPath = join(args.groupDir, `bundled-${entry.fileName.replace(/[/\\]/g, '_')}`)

    const extractorConfig = ExtractorConfig.prepare({
      configObject: {
        projectFolder,
        mainEntryPointFilePath: dtsPath,
        bundledPackages: args.bundledPackages,
        compiler: { tsconfigFilePath: args.tsconfigPath },
        dtsRollup: { enabled: true, untrimmedFilePath: bundledDtsPath },
        apiReport: { enabled: false },
        docModel: { enabled: false },
        tsdocMetadata: { enabled: false },
        newlineKind: 'lf',
      },
      configObjectFullPath: undefined,
      packageJsonFullPath,
    })

    return { entry, extractorConfig, bundledDtsPath }

  })

}

export function runExtractors(ctx: PluginContext, tasks: ExtractTask[]): void {

  // One shared CompilerState across the group so TS parses the sources once.
  const [first, ...rest] = tasks
  const compilerState = CompilerState.create(first.extractorConfig, {
    additionalEntryPoints: rest.map((t) => t.extractorConfig.mainEntryPointFilePath),
  })

  for (const { extractorConfig } of tasks) {
    Extractor.invoke(extractorConfig, {
      // Relax CI-mode checks (e.g. don't fail on missing API reports).
      localBuild: true,
      compilerState,
      messageCallback: (msg) => {
        // Mark handled to suppress api-extractor's console logger; we route
        // the message through Rollup instead.
        msg.handled = true
        if (msg.logLevel === ExtractorLogLevel.Error) ctx.error(msg.text)
        if (msg.logLevel === ExtractorLogLevel.Warning) ctx.warn(msg.text)
      },
    })
  }
  
}
