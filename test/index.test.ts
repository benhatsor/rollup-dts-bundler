import { test, expect } from 'vitest'
import { rollup } from 'rollup'
import { join } from 'node:path'
import dts from '../src/index.ts'

const fixturesDir = join(import.meta.dirname, 'fixtures')

async function bundle(fixture: string) {
  const cwd = process.cwd()
  const fixtureDir = join(fixturesDir, fixture)

  try {
    process.chdir(fixtureDir)
    const build = await rollup({
      input: 'src/index.ts',
      plugins: [dts()],
    })
    const { output } = await build.generate({ format: 'es' })
    const asset = output.find(o => o.type === 'asset')
    if (!asset) throw new Error('Expected an asset')
    return asset.source as string
  } finally {
    process.chdir(cwd)
  }
}

test('bundles declarations from multiple files into one', async () => {
  const output = await bundle('basic')

  // Internal types should be inlined
  expect(output).toContain('interface Options')
  expect(output).toContain('type Result')
  expect(output).toContain('function greet')

  // No relative imports — everything is bundled
  expect(output).not.toContain('./types')
})

test('bundles all re-export styles', async () => {
  const output = await bundle('reexports')

  // Named: export { Named } from './named'
  expect(output).toContain('interface Named')

  // Star: export * from './star'
  expect(output).toContain('interface StarA')
  expect(output).toContain('interface StarB')

  // Renamed: export { Original as Alias } from './renamed'
  expect(output).toContain('interface Alias')
  expect(output).not.toContain('interface Original')

  // Type-only: export type { TypeOnly } from './type-only'
  expect(output).toContain('interface TypeOnly')

  // Default: export { default as DefaultExport } from './default'
  expect(output).toContain('DefaultExport')

  // Namespace: export * as NS from './namespace'
  expect(output).toContain('NS')
  expect(output).toContain('interface NsItem')
  expect(output).toContain('nsHelper')

  // No relative imports remain
  expect(output).not.toMatch(/from ['"]\.\//)
})

test('preserves external library imports', async () => {
  const output = await bundle('external')

  // External type stays as an import, not inlined
  expect(output).toContain("from 'ext-lib'")
  expect(output).toContain('function process')

  // The external interface should NOT be inlined
  expect(output).not.toMatch(/interface ExternalType/)
})
