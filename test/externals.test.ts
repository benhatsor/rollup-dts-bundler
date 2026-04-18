import { test, expect } from 'vitest'
import { bundleOne } from './helpers.ts'

test('preserves external library imports', async () => {
  const output = await bundleOne('external')

  // External type stays as an import, not inlined
  expect(output).toContain("from 'ext-lib'")
  expect(output).toContain('function process')

  // The external interface should NOT be inlined
  expect(output).not.toMatch(/interface ExternalType/)
})

test('inlines packages listed in bundledPackages', async () => {
  const output = await bundleOne('external', { plugin: { bundledPackages: ['ext-lib'] } })

  // With bundledPackages set, the external interface is inlined instead of
  // left as an import.
  expect(output).toContain('interface ExternalType')
  expect(output).not.toContain("from 'ext-lib'")
})
