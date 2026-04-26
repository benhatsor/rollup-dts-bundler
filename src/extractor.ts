/**
 * Pipeline stage 3 — api-extractor. Runs once per tsconfig group, after
 * stage 2 has produced a `.d.ts` for every entry in the group.
 *
 * `buildTasks` turns each emitted `.d.ts` into an `ExtractorConfig`, anchored
 * to the entry's nearest named `package.json` (api-extractor requires one;
 * see the inline note for why we anchor per-entry rather than per-group).
 *
 * `runExtractors` then invokes api-extractor on every task in the group with
 * a single shared `CompilerState`, so TypeScript parses the sources just once.
 * Messages from api-extractor are forwarded to Rollup's `warn` / `error`
 * instead of going through its default console logger.
 *
 * Each task records the path where its bundled `.d.ts` will be written;
 * `bundle.ts` later reads that file and emits it as a Rollup asset in place
 * of the original stub chunk.
 */

import { dirname } from 'node:path'
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
    emitted: EmittedEntry[]
    bundledPackages?: string[]
  },
): ExtractTask[] {

  // Why we resolve a `package.json` per entry, with `PackageJsonLookup`:
  //
  //   1. `ExtractorConfig.prepare` requires a `packageJsonFullPath` even
  //      when called programmatically — `Collector` throws if
  //      `packageFolder` / `packageJson` are unset (there's an open upstream
  //      TODO to drop the requirement). Without an api-extractor config file to
  //      provide a default, we resolve it ourselves.
  //
  //   2. The result matters: the resolved `packageJson.name` becomes
  //      `workingPackage.name`, which `DeclarationReferenceGenerator` stamps
  //      onto every internal symbol. We anchor per entry rather than per
  //      group so each entry gets the correct package name — the wrong one
  //      would mislabel symbols. With our reports disabled this is only
  //      observable via TSDoc `{@link pkg!Symbol}` resolution, but it's
  //      still wrong.
  //
  //   3. `PackageJsonLookup` skips nameless `package.json` files; a manual
  //      ancestor walk would stop at the first one. Monorepo roots are
  //      often intentionally nameless, and stopping there would make
  //      `prepare` throw `MISSING_NAME_FIELD`.
  //
  //   4. One instance per call: its cache amortizes across entries, and a
  //      fresh instance per invocation avoids stale reads in watch mode.
  //
  // References:
  //   - Collector throws without `packageFolder` + `packageJson` (with TODO to lift it):
  //     https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/collector/Collector.ts#L123-L127
  //   - `ExtractorConfig.prepare` derives both from `packageJsonFullPath`:
  //     https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/api/ExtractorConfig.ts#L851-L867
  //   - `DeclarationReferenceGenerator` tags internal source files with `workingPackage.name`:
  //     https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/apps/api-extractor/src/generators/DeclarationReferenceGenerator.ts#L364
  //   - `PackageJsonLookup` walks past nameless `package.json`:
  //     https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/libraries/node-core-library/src/PackageJsonLookup.ts#L385
  //   - `loadNodePackageJson` throws `MISSING_NAME_FIELD` on a nameless `package.json`:
  //     https://github.com/microsoft/rushstack/blob/68497c5580db64436d7b854ac4135a47bb86deb7/libraries/node-core-library/src/PackageJsonLookup.ts#L290-L292
  const packageJsonLookup = new PackageJsonLookup()

  return args.emitted.map(({ entry, dtsPath }) => {

    const entryDir = dirname(entry.entryAbsPath)
    const packageJsonFullPath = packageJsonLookup.tryGetPackageJsonFilePathFor(entryDir)
    if (!packageJsonFullPath) {
      ctx.error(`Could not find a named package.json at or above ${entryDir}`)
    }

    // Place the bundled output next to its source `.d.ts` in the scratch
    // dir; reusing TS's already-unique `dtsPath` avoids inventing a naming
    // scheme of our own.
    const bundledDtsPath = dtsPath.replace(/\.d\.ts$/, '.bundled.d.ts')

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

  // Build one `CompilerState` from the first task and feed the remaining
  // entry points in as `additionalEntryPoints`. Sharing it across every
  // `Extractor.invoke` call means TS parses the group's sources just once.
  // `tasks` is non-empty by construction: `groupByTsconfig` never produces
  // empty groups, and `buildTasks` returns one task per group entry.
  const [first, ...rest] = tasks
  const compilerState = CompilerState.create(first!.extractorConfig, {
    additionalEntryPoints: rest.map((t) => t.extractorConfig.mainEntryPointFilePath),
  })

  for (const { extractorConfig } of tasks) {
    Extractor.invoke(extractorConfig, {
      // `localBuild: true` relaxes CI-mode checks (e.g. don't fail the
      // build on a missing API report).
      localBuild: true,
      compilerState,
      messageCallback: (msg) => {
        // Mark every message handled to silence api-extractor's default
        // console logger; diagnostics flow through Rollup instead, so the
        // user sees one consistent stream.
        msg.handled = true
        /* v8 ignore start -- only fires when api-extractor's `messages` config elevates a level to Error/Warning, which the plugin doesn't expose */
        if (msg.logLevel === ExtractorLogLevel.Error) ctx.error(msg.text)
        if (msg.logLevel === ExtractorLogLevel.Warning) ctx.warn(msg.text)
        /* v8 ignore stop */
      },
    })
  }
  
}
