/**
 * rollup-dts-bundler
 * @license MIT
 */
import { resolve, dirname, join } from 'node:path';
import { mkdirSync, mkdtempDisposableSync, writeFileSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { ExtractorConfig, CompilerState, Extractor, ExtractorLogLevel } from '@microsoft/api-extractor';
import { PackageJsonLookup } from '@rushstack/node-core-library';

/**
 * Formats TS diagnostics with color + source context and routes them through
 * Rollup's `ctx.warn` / `ctx.error` so they appear in Rollup's normal output
 * instead of TS writing straight to stdout.
 */
function createReporter(ctx, cwd) {
    const formatHost = {
        getCurrentDirectory: () => cwd,
        getCanonicalFileName: (f) => f,
        getNewLine: () => '\n',
    };
    return (diags) => {
        const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
        const warnings = diags.filter((d) => d.category === ts.DiagnosticCategory.Warning);
        if (warnings.length)
            ctx.warn(ts.formatDiagnosticsWithColorAndContext(warnings, formatHost));
        if (errors.length)
            ctx.error(ts.formatDiagnosticsWithColorAndContext(errors, formatHost));
    };
}

/**
 * Entry discovery and grouping.
 *
 * `collectEntries` pairs each output chunk with its source module's absolute path,
 * so we can later resolve where each chunk's respective emitted `.d.ts` file lands.
 *
 * `groupByTsconfig` splits entries by tsconfig — using either the user's
 * override (a single group) or each entry's nearest `tsconfig.json`. Entries sharing
 * a tsconfig share a TS program, letting api-extractor reuse a single `CompilerState`.
 */
function collectEntries(ctx, bundle) {
    return Object.entries(bundle).flatMap(([fileName, chunk]) => {
        if (chunk.type !== 'chunk')
            return [];
        if (!chunk.facadeModuleId)
            ctx.error(`Could not determine entry module for chunk: ${fileName}`);
        return [{ fileName, chunk, entryAbsPath: chunk.facadeModuleId }];
    });
}
// If there's an override, all entries go in one group. Otherwise, each entry
// walks up from its own directory; entries that land on the same tsconfig
// end up in the same group and share a TS program downstream.
function groupByTsconfig(ctx, entries, override, cwd) {
    const groups = new Map();
    for (const entry of entries) {
        // If an override was given, resolve it relative to cwd. Otherwise let
        // TypeScript's own resolver walk up from the entry's directory to the
        // nearest `tsconfig.json`.
        const tsconfigPath = override
            ? resolve(cwd, override)
            : ts.findConfigFile(dirname(entry.entryAbsPath), ts.sys.fileExists);
        if (!tsconfigPath)
            ctx.error(`Could not find a tsconfig.json from ${entry.entryAbsPath}`);
        const list = groups.get(tsconfigPath) ?? [];
        list.push(entry);
        groups.set(tsconfigPath, list);
    }
    return groups;
}

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
function emitDeclarations(ctx, tsconfigPath, entries, declarationDir, report) {
    // Use `getParsedCommandLineOfConfigFile` so `extends` chains are resolved.
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => report([d]),
    });
    if (!parsed)
        ctx.error(`Failed to load tsconfig: ${tsconfigPath}`);
    report(parsed.errors);
    // Force emit-friendly options so api-extractor always has `.d.ts` to read.
    const emitOptions = {
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
    };
    const program = ts.createProgram(parsed.fileNames, emitOptions);
    const emitResult = program.emit();
    report([...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]);
    // Use TS's native resolver to find where each `.d.ts` landed, rather than
    // reconstructing the path ourselves — the resolver correctly applies
    // `rootDir` and common-source-directory rules.
    //
    // See `ts.getOutputFileNames`: https://github.com/microsoft/TypeScript/blob/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/emitter.ts#L710
    const emitConfig = { ...parsed, options: emitOptions };
    return entries.map((entry) => {
        const dtsPath = ts
            .getOutputFileNames(emitConfig, entry.entryAbsPath, false)
            .find((f) => /\.d\.ts$/.test(f));
        if (!dtsPath)
            ctx.error(`Could not locate emitted .d.ts for entry: ${entry.entryAbsPath}`);
        return { entry, dtsPath };
    });
}

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
function buildTasks(ctx, args) {
    // Anchor to the tsconfig's dir so monorepo groups resolve their own
    // package.json, not the one above Rollup's cwd.
    const projectFolder = dirname(args.tsconfigPath);
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
    const packageJsonFullPath = new PackageJsonLookup().tryGetPackageJsonFilePathFor(projectFolder);
    if (!packageJsonFullPath) {
        ctx.error(`Could not find a named package.json at or above ${projectFolder}`);
    }
    return args.emitted.map(({ entry, dtsPath }) => {
        const bundledDtsPath = join(args.groupDir, `bundled-${entry.fileName.replace(/[/\\]/g, '_')}`);
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
        });
        return { entry, extractorConfig, bundledDtsPath };
    });
}
function runExtractors(ctx, tasks) {
    // Use a single shared CompilerState across the group so TS only parses the sources once.
    const [first, ...rest] = tasks;
    const compilerState = CompilerState.create(first.extractorConfig, {
        additionalEntryPoints: rest.map((t) => t.extractorConfig.mainEntryPointFilePath),
    });
    for (const { extractorConfig } of tasks) {
        Extractor.invoke(extractorConfig, {
            // Relax CI-mode checks (e.g. don't fail on missing API reports).
            localBuild: true,
            compilerState,
            messageCallback: (msg) => {
                // Mark handled to suppress api-extractor's console logger; we route
                // the message through Rollup instead.
                msg.handled = true;
                if (msg.logLevel === ExtractorLogLevel.Error)
                    ctx.error(msg.text);
                if (msg.logLevel === ExtractorLogLevel.Warning)
                    ctx.warn(msg.text);
            },
        });
    }
}

/**
 * Pipeline for each Rollup output:
 *   1. Make a scratch tempdir inside Rollup's output dir (so TS can resolve
 *      imported external modules by walking up to the user's `node_modules`).
 *   2. Collect entries from the bundle and group them by tsconfig.
 *   3. For each group: emit `.d.ts` with `tsc`, bundle with api-extractor,
 *      then swap Rollup's stub JS chunks for the bundled `.d.ts` assets.
 */
// Standard cache-directory tag (https://bford.info/cachedir/)
// so backup tools auto-skip crash leftovers.
const CACHEDIR_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n' +
    '# This file is a cache directory tag created by rollup-dts-bundler.\n' +
    '# For information about cache directory tags, see https://bford.info/cachedir/\n';
async function bundleDeclarations(ctx, bundle, options, opts) {
    const cwd = process.cwd();
    // Scratch dir constraints:
    //   - Not under `node_modules/`: TS flags any path containing `/node_modules/`
    //     as `isExternalLibraryImport`, which would make api-extractor misclassify
    //     our internal modules as third-party.
    //   - Under the project root: emitted `.d.ts` files import real packages, and
    //     TS resolution walks up from each scratch file to find `node_modules`.
    //     `os.tmpdir()` would walk to `/` and miss it.
    // Output dir over cwd: typically already gitignored, guaranteed writable, and
    // doesn't litter the project root. Fall back to cwd if the caller used
    // `rollup().generate()` with neither `output.dir` nor `output.file`.
    // `.gitignore` hides crash leftovers from `git status` (and from `npm publish`
    // via its .gitignore fallback). `CACHEDIR.TAG` makes backup tools skip them.
    const outputDir = options.dir ?? (options.file ? dirname(options.file) : cwd);
    mkdirSync(outputDir, { recursive: true });
    using tempDir = mkdtempDisposableSync(join(outputDir, '.rollup-dts-bundler-'));
    writeFileSync(join(tempDir.path, '.gitignore'), '*\n');
    writeFileSync(join(tempDir.path, 'CACHEDIR.TAG'), CACHEDIR_TAG);
    const report = createReporter(ctx, cwd);
    const entries = collectEntries(ctx, bundle);
    if (entries.length === 0)
        return;
    const groups = groupByTsconfig(ctx, entries, opts.tsconfig, cwd);
    let groupIndex = 0;
    for (const [tsconfigPath, groupEntries] of groups) {
        // Each group gets its own subdir so source paths from different programs
        // can't collide in a shared `declarationDir`.
        const groupDir = join(tempDir.path, `g${groupIndex++}`);
        mkdirSync(groupDir, { recursive: true });
        const emitted = emitDeclarations(ctx, tsconfigPath, groupEntries, groupDir, report);
        const tasks = buildTasks(ctx, {
            tsconfigPath,
            groupDir,
            emitted,
            bundledPackages: opts.bundledPackages,
        });
        runExtractors(ctx, tasks);
        await emitBundledAssets(ctx, tasks, bundle, options);
    }
}
// Replace each stub JS chunk with a .d.ts asset at the same path. We delete
// and re-emit (rather than mutating `chunk.code`) so downstream plugins and
// sourcemap handling don't treat the output as JS.
async function emitBundledAssets(ctx, tasks, bundle, options) {
    for (const { entry, bundledDtsPath } of tasks) {
        const dtsContent = readFileSync(bundledDtsPath, 'utf-8');
        const banner = await options.banner(entry.chunk);
        delete bundle[entry.fileName];
        ctx.emitFile({
            type: 'asset',
            fileName: entry.fileName,
            source: banner ? `${banner}\n${dtsContent}` : dtsContent,
        });
    }
}

/**
 * Plugin entry point. The plugin itself is intentionally thin: it marks entry
 * modules, stubs their JS so Rollup emits one chunk per entry, and defers the
 * real work (emitting and bundling .d.ts files) to `generateBundle` in `./bundle.ts`.
 */
function dts(opts = {}) {
    return {
        name: 'rollup-dts-bundler',
        resolveId(source, importer) {
            // Defer entries to Rollup's default resolver (by returning null) so we
            // get an absolute `facadeModuleId` later to map back to the emitted .d.ts.
            if (!importer) {
                if (!/\.tsx?$/.test(source)) {
                    this.error(`Entry point must be a .ts or .tsx file, got: ${source}`);
                }
                return null;
            }
            // Everything else is external so Rollup never walks the import graph.
            return { id: source, external: true };
        },
        // Non-entries are external, so anything reaching `load` is an entry.
        // Return empty code so Rollup emits one chunk per entry with no JS.
        load() {
            return { code: '', moduleSideEffects: 'no-treeshake' };
        },
        async generateBundle(options, bundle) {
            await bundleDeclarations(this, bundle, options, opts);
        },
    };
}

export { dts as default };
