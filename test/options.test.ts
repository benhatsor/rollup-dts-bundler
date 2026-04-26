import { test, expect } from 'vitest'
import { mkdtempDisposableSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bundle, bundleOne } from './helpers'

// The plugin calls `mkdirSync(outputDir, { recursive: true })` before placing
// its scratch tempdir, so a test that passes `output.dir: 'dist'` (relative
// to cwd) leaves an empty `dist/` inside the fixture even though `generate()`
// itself never writes there. The `output.dir` / `output.file` tests below
// route through an OS tempdir so the fixture tree stays clean across runs.

test('prepends the rollup output banner', async () => {
  const output = await bundleOne('basic', { output: { banner: '/* my banner */' } })

  expect(output.startsWith('/* my banner */\n')).toBe(true)
  expect(output).toContain('interface Options')
})

test('loads tsconfig from a custom path with extends', async () => {
  const output = await bundleOne('basic', { plugin: { tsconfig: 'tsconfig.extended.json' } })

  // If extends didn't resolve, compilerOptions would be empty and emit would fail.
  expect(output).toContain('interface Options')
})

test('honors output.dir for the scratch directory', async () => {
  // `output.dir` controls where the plugin places its scratch tempdir. The
  // assertion target is the bundled `.d.ts` content; the side effect we care
  // about is that the dir-based code path runs without errors.
  using dir = mkdtempDisposableSync(join(tmpdir(), 'dts-bundler-output-'))
  const result = await bundle('basic', {
    output: { dir: dir.path, entryFileNames: '[name].d.ts' },
  })
  expect(result['index.d.ts']).toContain('interface Options')
})

test('honors output.file for the scratch directory', async () => {
  // `output.file` mode exercises the `dirname(options.file)` branch of the
  // scratch-dir resolution. Rollup invents the chunk's `fileName` from the
  // basename of `output.file`, so the asset key is `index.d.ts`.
  using dir = mkdtempDisposableSync(join(tmpdir(), 'dts-bundler-output-'))
  const output = await bundleOne('basic', {
    output: { file: join(dir.path, 'index.d.ts') },
  })
  expect(output).toContain('interface Options')
})

test('respects custom entryFileNames', async () => {
  const result = await bundle('basic', {
    output: { entryFileNames: 'types/[name].d.ts' },
  })

  expect(Object.keys(result)).toEqual(['types/index.d.ts'])
  expect(result['types/index.d.ts']).toContain('interface Options')
})
