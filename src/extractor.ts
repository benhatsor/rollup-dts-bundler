/**
 * api-extractor task construction and invocation. Invoked once per group of
 * Rollup entries sharing a tsconfig, after `emitDeclarations` has produced a
 * `.d.ts` for each.
 *
 * `buildTasks` takes a group of entries and builds an `ExtractTask` for each.
 * `runExtractors` runs those grouped tasks together, sharing one `CompilerState`
 * so TS parses the sources once. It also routes api-extractor's messages
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

  // `ExtractorConfig.prepare` requires a `packageJsonFullPath` purely as an API artifact:
  // `Collector` throws if `packageFolder`/`packageJson` are unset, with a standing TODO to
  // lift the requirement. Since we invoke `prepare` programmatically (no api-extractor
  // config file to anchor a lookup off of), the resolution falls to us — and the choice
  // matters: the `packageJson.name` we resolve becomes `workingPackage.name`, which
  // `DeclarationReferenceGenerator` stamps onto every internal symbol. So we anchor per
  // entry, not per group; the wrong package would mislabel them — observable only via
  // TSDoc `{@link pkg!Symbol}` resolution given our disabled reports, but still wrong.
  //
  // `PackageJsonLookup` (rather than a generic find-up) skips nameless `package.json` files;
  // monorepo roots are often intentionally nameless, and stopping at one would make
  // `prepare` throw `MISSING_NAME_FIELD`. One instance per call: the cache amortizes across
  // entries, and a fresh instance avoids stale reads in watch mode.
  //
  // - Collector throws without `packageFolder` + `packageJson` (with a TODO to lift it): https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/collector/Collector.ts#L123-L127
  // - `ExtractorConfig.prepare` derives both from `packageJsonFullPath`: https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/api/ExtractorConfig.ts#L851-L867
  // - `DeclarationReferenceGenerator` tags internal source files with `workingPackage.name`: https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/generators/DeclarationReferenceGenerator.ts#L364
  // - `PackageJsonLookup` walks past nameless `package.json`: https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/libraries/node-core-library/src/PackageJsonLookup.ts#L385
  // - `loadNodePackageJson` throws `MISSING_NAME_FIELD` on a nameless `package.json`: https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/libraries/node-core-library/src/PackageJsonLookup.ts#L290-L292
  const packageJsonLookup = new PackageJsonLookup()

  return args.emitted.map(({ entry, dtsPath }) => {

    const entryDir = dirname(entry.entryAbsPath)
    const packageJsonFullPath = packageJsonLookup.tryGetPackageJsonFilePathFor(entryDir)
    if (!packageJsonFullPath) {
      ctx.error(`Could not find a named package.json at or above ${entryDir}`)
    }

    const bundledDtsPath = join(args.groupDir, `bundled-${entry.fileName.replace(/[/\\]/g, '_')}`)

    const extractorConfig = ExtractorConfig.prepare({
      configObject: {
        projectFolder: dirname(packageJsonFullPath),
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
