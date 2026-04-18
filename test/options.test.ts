import { test, expect } from 'vitest'
import { bundleOne } from './helpers.ts'

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
