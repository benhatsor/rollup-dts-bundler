import { test, expect } from 'vitest'
import { bundle } from './helpers.ts'

test('errors when entry point is not a .ts or .tsx file', async () => {
  await expect(bundle('basic', { input: 'src/index.js' })).rejects.toThrow(/\.ts or \.tsx/)
})

test('surfaces TypeScript compile errors as rollup errors', async () => {
  // `noEmitOnError: false` lets emit proceed so api-extractor has inputs,
  // but diagnostics must still abort the rollup build via ctx.error.
  await expect(bundle('ts-error')).rejects.toThrow(/is not assignable to type 'number'/)
})
