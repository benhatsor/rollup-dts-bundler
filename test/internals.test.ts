/**
 * Unit tests for individual pipeline functions, hit directly with a mocked
 * `PluginContext`. They cover the error and edge branches that can't be
 * provoked through a normal Rollup run — e.g. a chunk with no
 * `facadeModuleId`, an entry with no `tsconfig.json` or `package.json`
 * anywhere up the tree, an unreadable tsconfig.
 */

import { test, expect, describe } from 'vitest'
import { mkdtempDisposableSync, existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { tmpdir } from 'node:os'
import type { NormalizedOutputOptions, OutputBundle, OutputChunk, PluginContext } from 'rollup'
import { collectEntries, groupByTsconfig, type Entry } from '../src/entries'
import { emitDeclarations } from '../src/emit'
import { buildTasks } from '../src/extractor'
import { bundleDeclarations } from '../src/bundle'
import { dts } from '../src/index'

/**
 * Minimal `PluginContext` stand-in. The plugin only ever uses `error`
 * (which Rollup makes throw) and `warn` (which it logs); mirroring that
 * shape is enough for the unit tests below.
 */
function mockPluginContext(): PluginContext {
  return {
    error(msg: string): never { throw new Error(msg) },
    warn() {},
  } as unknown as PluginContext
}

function makeChunk(overrides: Partial<OutputChunk> = {}): OutputChunk {
  return {
    type: 'chunk',
    fileName: 'index.js',
    facadeModuleId: '/abs/index.ts',
    name: 'index',
    ...overrides,
  } as OutputChunk
}

function makeEntry(entryAbsPath: string, fileName = 'index.js'): Entry {
  return {
    fileName,
    chunk: makeChunk({ fileName, facadeModuleId: entryAbsPath }),
    entryAbsPath,
  }
}

/**
 * Fresh disposable directory under the OS tempdir, for tests that need a
 * path with no `tsconfig.json` or `package.json` in any ancestor — the OS
 * tempdir (`/var/folders/...` on macOS, `/tmp` on Linux) sits outside any
 * project root.
 */
function tempScratch(prefix: string) {
  return mkdtempDisposableSync(join(tmpdir(), `dts-bundler-${prefix}-`))
}

/**
 * True when no file named `name` exists in any ancestor of `from` up to the
 * filesystem root. The two "no config above" tests below need this to hold
 * for `tsconfig.json` / `package.json` from the OS tempdir; on a typical CI
 * runner it does, but we guard rather than assume so a future runner image
 * with stray root-level configs surfaces a `skip` instead of a flake.
 */
function noFileAboveRoot(from: string, name: string): boolean {
  let dir = from
  const { root } = parse(dir)
  while (true) {
    if (existsSync(join(dir, name))) return false
    if (dir === root) return true
    dir = dirname(dir)
  }
}

/**
 * Probe the OS tempdir's ancestor chain once at module load. Used as a
 * `test.skipIf` guard — true when no `name` exists in any ancestor of a
 * fresh tempdir entry, which is the precondition for the "no config above"
 * tests.
 */
function tempdirIsCleanOf(name: string): boolean {
  using probe = mkdtempDisposableSync(join(tmpdir(), 'dts-bundler-probe-'))
  return noFileAboveRoot(probe.path, name)
}

describe('collectEntries', () => {

  test('skips non-chunk bundle items', () => {
    const ctx = mockPluginContext()
    const bundle = {
      'styles.css': { type: 'asset', fileName: 'styles.css' },
      'index.js': makeChunk(),
    } as unknown as OutputBundle

    // The asset is filtered out; the chunk is collected and its
    // `fileName` is preserved on the resulting `Entry`.
    expect(collectEntries(ctx, bundle)).toEqual([
      expect.objectContaining({ fileName: 'index.js' }),
    ])
  })

  test('errors when a chunk has no facadeModuleId', () => {
    const ctx = mockPluginContext()
    const bundle = {
      'orphan.js': makeChunk({ facadeModuleId: null }),
    } as unknown as OutputBundle

    expect(() => collectEntries(ctx, bundle)).toThrow(
      /Could not determine entry module/,
    )
  })

})

describe('groupByTsconfig', () => {

  test('groups entries that share a tsconfig path', () => {
    const ctx = mockPluginContext()
    const tsconfigPath = '/proj/tsconfig.json'
    const entries = [
      makeEntry('/proj/src/a.ts', 'a.js'),
      makeEntry('/proj/src/b.ts', 'b.js'),
    ]
    // Force both entries through the override branch so we don't depend on
    // the filesystem. With an override they share `tsconfigPath` and end up
    // in a single group.
    const groups = groupByTsconfig(ctx, entries, tsconfigPath, '/proj')

    expect(groups.size).toBe(1)
    expect([...groups.values()][0]).toHaveLength(2)
  })

  test.skipIf(!tempdirIsCleanOf('tsconfig.json'))('errors when no tsconfig is found from the entry', () => {
    const ctx = mockPluginContext()
    using tmp = tempScratch('no-tsconfig')
    const entries = [makeEntry(join(tmp.path, 'src/index.ts'))]
    // No override + an entry under `/var/folders/...` means TS walks up
    // to filesystem root without finding a `tsconfig.json`.
    expect(() => groupByTsconfig(ctx, entries, undefined, tmp.path)).toThrow(
      /Could not find a tsconfig\.json/,
    )
  })

})

describe('emitDeclarations', () => {

  test('errors via onUnRecoverableConfigFileDiagnostic for an unreadable tsconfig', () => {
    const ctx = mockPluginContext()
    using tmp = tempScratch('bad-tsconfig')
    // Pointing at a path that isn't a readable tsconfig file makes
    // `getParsedCommandLineOfConfigFile` invoke our
    // `onUnRecoverableConfigFileDiagnostic` callback, which forwards
    // through `ctx.error` and aborts.
    const missing = join(tmp.path, 'does-not-exist.tsconfig.json')
    const entries = [makeEntry(join(tmp.path, 'index.ts'))]
    expect(() => emitDeclarations(ctx, missing, entries, tmp.path)).toThrow()
  })

})

describe('buildTasks', () => {

  test.skipIf(!tempdirIsCleanOf('package.json'))('errors when no named package.json is reachable from the entry', () => {
    const ctx = mockPluginContext()
    using tmp = tempScratch('no-pkg-json')
    const entry = makeEntry(join(tmp.path, 'src/index.ts'))
    const emitted = [{ entry, dtsPath: join(tmp.path, 'index.d.ts') }]
    expect(() =>
      buildTasks(ctx, {
        tsconfigPath: join(tmp.path, 'tsconfig.json'),
        emitted,
      }),
    ).toThrow(/Could not find a named package\.json/)
  })

})

describe('plugin hooks', () => {

  // Public API contract — locks in the plugin's exported shape so an
  // accidental rename or removed hook fails CI instead of slipping into
  // a `fix:` release.
  test('exposes the documented surface', () => {
    const plugin = dts()
    expect(plugin.name).toBe('rollup-dts-bundler')
    expect(typeof plugin.resolveId).toBe('function')
    expect(typeof plugin.load).toBe('function')
    expect(typeof plugin.generateBundle).toBe('function')
  })

  // The plugin's `load` returns an empty source for every entry, so Rollup
  // never walks the import graph and the `resolveId(source, importer)`
  // branch never fires through a normal build. Calling the hook directly
  // is the only way to exercise it.
  test('resolveId marks non-entry imports as external', () => {
    const { resolveId } = dts()
    if (typeof resolveId !== 'function') throw new Error('resolveId is not a function')
    const ctx = mockPluginContext()
    const result = resolveId.call(ctx, './foo', '/abs/parent.ts', {} as never)
    expect(result).toEqual({ id: './foo', external: true })
  })

  test('load returns an empty stub source', () => {
    const { load } = dts()
    if (typeof load !== 'function') throw new Error('load is not a function')
    const ctx = mockPluginContext()
    const result = load.call(ctx, '/abs/index.ts')
    expect(result).toEqual({ code: '', moduleSideEffects: 'no-treeshake' })
  })

})

describe('bundleDeclarations', () => {

  test('returns early when the bundle has no chunks', async () => {
    // Covers the `entries.length === 0` short-circuit: a Rollup output that
    // somehow contains only assets (e.g. another plugin emitted them, but
    // no JS entries survived) shouldn't trip the rest of the pipeline.
    const ctx = mockPluginContext()
    using tmp = tempScratch('empty-bundle')
    const bundle = {
      'extra.css': { type: 'asset', fileName: 'extra.css', source: '' },
    } as unknown as OutputBundle

    // `bundleDeclarations` only reads `dir`, `file`, and `banner`, so a
    // partial mock is enough.
    const options = {
      dir: tmp.path,
      file: undefined,
      banner: async () => '',
    } as unknown as NormalizedOutputOptions

    await expect(
      bundleDeclarations(ctx, bundle, options, {}),
    ).resolves.toBeUndefined()
  })

})
