/**
 * rollup-dts-bundler
 * @license MIT
 */
import { resolve, dirname, join } from 'node:path';
import { mkdirSync, mkdtempDisposableSync, readFileSync } from 'node:fs';
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
 * `collectEntries` pairs each output chunk with the absolute path of its
 * source module so later stages can ask TS where the `.d.ts` landed.
 *
 * `groupByTsconfig` splits entries by tsconfig — either the user's override
 * (one group) or each entry's nearest `tsconfig.json`. Entries sharing a
 * tsconfig share a TS program, letting api-extractor reuse one `CompilerState`.
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
// With an override, all entries go in one group. Without one, each entry
// walks up from its own directory; entries that land on the same tsconfig
// end up in the same group and share a TS program downstream.
function groupByTsconfig(ctx, entries, override, cwd) {
    const groups = new Map();
    for (const entry of entries) {
        // If user defined an override, resolve path relative to cwd.
        // Otherwise, use TypeScript's native resolver.
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
 * Declaration emit for one tsconfig group.
 *
 * Loads the tsconfig (resolving `extends`), forces emit-friendly options, and
 * calls `program.emit()` to drop `.d.ts` files into the group's scratch dir.
 * api-extractor reads these next, so we emit even on non-fatal diagnostics.
 *
 * Returns each entry paired with its emitted `.d.ts` path, resolved via
 * `ts.getOutputFileNames` (which handles `rootDir`/common-source-directory
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
    // Force emit-friendly options so api-extractor always has `.d.ts` files to
    // read, even on non-fatal diagnostics. TS 6 (TS5011) requires an explicit
    // `rootDir` whenever `declarationDir` changes; if the user hasn't set one,
    // we use TS's own default (`dirname(configFilePath)`, see
    // `getCommonSourceDirectory`) so emit paths match `tsc`.
    const emitOptions = {
        ...parsed.options,
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        noEmitOnError: false,
        skipLibCheck: true,
        declarationDir,
        rootDir: parsed.options.rootDir ?? dirname(tsconfigPath),
    };
    const program = ts.createProgram(parsed.fileNames, emitOptions);
    const emitResult = program.emit();
    report([...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]);
    // Find where each .d.ts landed using TypeScript's native resolver.
    // This is better than just reconstructing the path as the native resolver
    // also handles rootDir/common-source-directory rules properly.
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
 * `runExtractors` runs every task in a group sharing one `CompilerState`, so
 * TS parses the sources only once. api-extractor's messages are routed
 * through Rollup's diagnostic channels.
 */
function buildTasks(ctx, args) {
    // Anchor to the tsconfig's dir so monorepo groups resolve their own
    // package.json, not the one above Rollup's cwd. api-extractor requires one
    // (see `Collector`), and we use its own `PackageJsonLookup` so resolution
    // can't diverge — notably, it skips nameless package.json files (e.g. a
    // monorepo root with only workspace config) that a plain existence check
    // would stop at.
    const projectFolder = dirname(args.tsconfigPath);
    // Fresh lookup per call (not module-level) so watch-mode rebuilds don't
    // read a stale cache if the user's package.json layout changes.
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
    // One shared CompilerState across the group so TS parses the sources once.
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
 * Pipeline for one Rollup output:
 *   1. Make a scratch tempdir inside Rollup's output dir (so TS module
 *      resolution can see the user's `node_modules`).
 *   2. Collect entries from the bundle and group them by tsconfig.
 *   3. For each group: emit `.d.ts` with `tsc`, bundle with api-extractor,
 *      then swap Rollup's stub JS chunks for the bundled `.d.ts` assets.
 */
async function bundleDeclarations(ctx, bundle, options, opts) {
    const cwd = process.cwd();
    // Put the scratch dir inside Rollup's output dir so TS module resolution
    // can find the user's `node_modules`. Fall back to cwd if the caller used
    // `rollup().generate()` with neither `output.dir` nor `output.file`.
    const outputDir = options.dir ?? (options.file ? dirname(options.file) : cwd);
    mkdirSync(outputDir, { recursive: true });
    using tempDir = mkdtempDisposableSync(join(outputDir, '.rollup-dts-bundler-'));
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
 * Plugin entry point. The plugin is thin: it marks entry modules, stubs their
 * JS so Rollup emits one chunk per entry, and defers the real work (emit +
 * bundle .d.ts) to `generateBundle` in `./bundle.ts`.
 */
function dts(opts = {}) {
    return {
        name: 'rollup-dts-bundler',
        resolveId(source, importer) {
            // For entries, return null so Rollup's default resolver gives us an
            // absolute `facadeModuleId` later to map back to the emitted .d.ts.
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
//# sourceMappingURL=index.js.map
