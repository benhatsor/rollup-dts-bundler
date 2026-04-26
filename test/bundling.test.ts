import { test, expect } from 'vitest'
import { bundleOne } from './helpers'

test('bundles declarations from multiple files into one', async () => {
  const output = await bundleOne('basic')

  // Internal types should be inlined
  expect(output).toContain('interface Options')
  expect(output).toContain('type Result')
  expect(output).toContain('function greet')

  // No relative imports — everything is bundled
  expect(output).not.toContain('./types')
})

test('bundles all re-export styles', async () => {
  const output = await bundleOne('reexports')

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

test('accepts .tsx entries', async () => {
  const output = await bundleOne('tsx-entry', { input: 'src/index.tsx' })

  expect(output).toContain('interface Props')
  expect(output).toContain('function Component')
})
