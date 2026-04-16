/**
 * rollup-dts-bundler
 * @license MIT
 */

import type { Plugin } from 'rollup'
import { resolve, join, dirname } from 'node:path'
import { readFileSync, mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor'

const projectFolder = dirname(fileURLToPath(import.meta.url))

const formatHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: () => projectFolder,
  getCanonicalFileName: (f) => f,
  getNewLine: () => '\n',
}

export default function dts(): Plugin {
  let entryId: string

  return {
    name: 'rollup-dts-bundler',

    resolveId(source, importer) {
      if (!importer) return null
      return { id: source, external: true }
    },

    buildStart({ input }) {
      const parsedInput = Array.isArray(input) ? input : Object.values(input)
      if (parsedInput.length !== 1) {
        this.error('Must have a single input entry point')
      }
      entryId = parsedInput[0]
      if (!/\.tsx?$/.test(entryId)) {
        this.error(`Entry point must be a .ts or .tsx file, got: ${entryId}`)
      }
    },

    load(id) {
      if (id !== resolve(projectFolder, entryId)) return null
      return { code: '', moduleSideEffects: 'no-treeshake' }
    },

    async generateBundle(options, bundle) {
      using tempDir = mkdtempDisposableSync(join(tmpdir(), 'dts-rollup-'))

      // Parse tsconfig
      const tsconfigPath = join(projectFolder, 'tsconfig.json')
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
      if (configFile.error) {
        this.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], formatHost))
      }
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectFolder)
      if (parsed.errors.length > 0) {
        this.error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost))
      }

      // Emit .d.ts files to a temp directory on disk
      const program = ts.createProgram(parsed.fileNames, {
        ...parsed.options,
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        declarationDir: tempDir.path,
        outDir: tempDir.path,
      })
      const emittedPaths: string[] = []
      const emitResult = program.emit(undefined, (fileName, text, writeByteOrderMark) => {
        ts.sys.writeFile(fileName, text, writeByteOrderMark)
        emittedPaths.push(fileName)
      })
      const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]
      if (diagnostics.length > 0) {
        this.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost))
      }

      // Find the .d.ts corresponding to the entry point. tsc strips the inferred rootDir when
      // writing into declarationDir, so match by path suffix.
      const entryAbsPath = resolve(projectFolder, entryId)
      const entryDtsPath = emittedPaths.find(p => {
        const rel = p.slice(tempDir.path.length).replace(/\.d\.ts$/, '.ts')
        return entryAbsPath.endsWith(rel)
      })
      if (!entryDtsPath) return this.error(`No declaration emitted for entry: ${entryId}`)

      // Bundle declarations with api-extractor's public API.
      // Note: Extractor.invoke creates its own TS program via CompilerState, using
      // api-extractor's bundled TypeScript.
      const bundledOutput = join(tempDir.path, 'bundled.d.ts')
      const extractorConfig = ExtractorConfig.prepare({
        configObject: {
          projectFolder,
          mainEntryPointFilePath: entryDtsPath,
          compiler: { overrideTsconfig: configFile.config },
          dtsRollup: { enabled: true, untrimmedFilePath: bundledOutput },
          apiReport: { enabled: false },
          docModel: { enabled: false },
          tsdocMetadata: { enabled: false },
          newlineKind: 'lf',
        },
        configObjectFullPath: undefined,
        packageJsonFullPath: join(projectFolder, 'package.json'),
      })
      Extractor.invoke(extractorConfig, {
        localBuild: true,
        messageCallback: (msg) => {
          msg.handled = true
          if (msg.logLevel === ExtractorLogLevel.Error) this.error(msg.text)
          if (msg.logLevel === ExtractorLogLevel.Warning) this.warn(msg.text)
        },
      })

      const dtsContent = readFileSync(bundledOutput, 'utf-8')

      // Replace the placeholder chunk with a clean asset
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk') {
          const banner = await options.banner(chunk)
          delete bundle[fileName]
          this.emitFile({
            type: 'asset',
            fileName,
            source: banner ? `${banner}\n${dtsContent}` : dtsContent,
          })
        }
      }
    },
  }
}
