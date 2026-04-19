/**
 * api-extractor task construction and invocation.
 *
 * `buildTasks` builds one `ExtractorConfig` per entry, anchored to the
 * tsconfig's directory.
 *
 * `runExtractors` runs the input tasks in a group, sharing one `CompilerState`,
 * so TS parses the sources only once. api-extractor's messages are routed
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
  // package.json, not the one above Rollup's cwd.
  const projectFolder = dirname(args.tsconfigPath)

  // api-extractor's `Collector` requires the working package's package.json path
  // and throws otherwise. `loadFileAndPrepare` would auto-resolve it via
  // `PackageJsonLookup.tryGetPackageJsonFilePathFor` (anchored to an api-extractor
  // config file), but the programmatic `prepare` we use has no config file to anchor
  // to — so resolution falls to us. We use the very same `PackageJsonLookup`,
  // anchoring it to the tsconfig's dir (so monorepo groups resolve their own package.json).
  // This matches both the aformentioned path lookup, as well as the lookup `Collector` itself
  // uses internally to classify external source files (when deriving package names for declaration
  // references). Note that its ancestor walk skips nameless package.json files; a naive walk
  // (e.g. `find-up`) could stop at a nameless monorepo root and hand `Collector` a path it
  // would disagree with. Fresh instance per call so watch-mode rebuilds don't read a stale cache.
  //
  // Collector requires `packageJsonFullPath`:
  //   - `ExtractorConfig.prepare` sets `packageFolder` to `dirname(packageJsonFullPath)`: https://github.com/microsoft/rushstack/blob/main/apps/api-extractor/src/api/ExtractorConfig.ts#L867
  //   - Collector requires `packageFolder`: https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/collector/Collector.ts#L123-L127
  // - `ExtractorConfig.loadFileAndPrepare`'s internal `PackageJsonLookup`: https://github.com/microsoft/rushstack/blob/3793e2c87abbf2e4d4545566126d4e133cd7e061/apps/api-extractor/src/api/ExtractorConfig.ts#L604-L606
  // - Collector's internal `PackageJsonLookup` (used for external sources):
  //   - Initialized: https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/collector/Collector.ts#L108
  //   - Shim invoked: https://github.com/microsoft/rushstack/blob/main/apps/api-extractor/src/generators/DeclarationReferenceGenerator.ts#L356-L357
  //   - Actual invocation: https://github.com/microsoft/rushstack/blob/main/libraries/node-core-library/src/PackageJsonLookup.ts#L234
  // - `PackageJsonLookup` skips nameless package.json (walks past MISSING_NAME_FIELD): https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/libraries/node-core-library/src/PackageJsonLookup.ts#L385
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

  // Use a single shared CompilerState across the group so TS only parses the sources once.
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
