import { test, expect } from 'vitest'
import { bundle } from './helpers'

test('handles entries resolving to different tsconfigs', async () => {
  // pkg-a and pkg-b each have their own tsconfig; with no override, each
  // entry must walk up to its own package's tsconfig. If grouping collapsed
  // both entries under a single tsconfig, the "wrong" tsconfig's `include`
  // wouldn't cover the other entry's sources and emit would fail.
  const result = await bundle('multi-tsconfig', {
    input: {
      'pkg-a': 'packages/pkg-a/src/index.ts',
      'pkg-b': 'packages/pkg-b/src/index.ts',
    },
    output: { entryFileNames: '[name].d.ts' },
  })

  expect(result['pkg-a.d.ts']).toContain('interface AType')
  expect(result['pkg-a.d.ts']).toContain('function a')
  expect(result['pkg-a.d.ts']).not.toContain('BType')

  expect(result['pkg-b.d.ts']).toContain('interface BType')
  expect(result['pkg-b.d.ts']).toContain('function b')
  expect(result['pkg-b.d.ts']).not.toContain('AType')
})

test('bundles multiple entry points', async () => {
  const result = await bundle('multi-entry', {
    input: { main: 'src/main.ts', cli: 'src/cli.ts' },
    output: { entryFileNames: '[name].d.ts', banner: '/* multi-entry banner */' },
  })

  // Each entry gets its own bundled declaration file.
  expect(result['main.d.ts']).toContain('interface Main')
  expect(result['cli.d.ts']).toContain('interface Cli')

  // Banner lands on each entry, not just the first. `toMatch` accepts
  // `string | undefined` and fails clearly when undefined, so we don't
  // need a non-null assertion to satisfy `noUncheckedIndexedAccess`.
  expect(result['main.d.ts']).toMatch(/^\/\* multi-entry banner \*\/\n/)
  expect(result['cli.d.ts']).toMatch(/^\/\* multi-entry banner \*\/\n/)

  // Shared types are inlined in each bundle (no cross-bundle relative imports).
  expect(result['main.d.ts']).toContain('interface Shared')
  expect(result['cli.d.ts']).toContain('interface Shared')
  expect(result['main.d.ts']).not.toMatch(/from ['"]\.\//)
  expect(result['cli.d.ts']).not.toMatch(/from ['"]\.\//)

  // Main shouldn't contain Cli types and vice versa.
  expect(result['main.d.ts']).not.toContain('interface Cli')
  expect(result['cli.d.ts']).not.toContain('interface Main')
})
