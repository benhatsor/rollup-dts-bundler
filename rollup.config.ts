/**
 * Build config.
 *
 * Note: `npm run build` invokes Rollup with `--configPlugin typescript={tsconfig:'rollup.tsconfig.json'}`,
 * because `@rollup/plugin-typescript`'s tsconfig defaults conflict with ours,
 * namely by not letting us import TS files without an extension.
 * See: https://github.com/rollup/plugins/issues/1713#issuecomment-2096028981
 */

import { defineConfig } from 'rollup'
import typescript from '@rollup/plugin-typescript'
import nodeResolve from '@rollup/plugin-node-resolve'
import { dts } from './src/index'

const banner = `
/**
 * rollup-dts-bundler
 * @license MIT
 */
`.trim()

export default defineConfig([
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.js', format: 'es', banner },
    external: /node_modules/,
    plugins: [
      nodeResolve(),
      typescript({ tsconfig: './rollup.tsconfig.json' }),
    ],
  },
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es', banner },
    plugins: [dts()], // dogfooding
  },
])
