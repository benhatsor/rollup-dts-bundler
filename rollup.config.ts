import { defineConfig } from 'rollup'
import typescript from '@rollup/plugin-typescript'
import nodeResolve from '@rollup/plugin-node-resolve'
import dts from './dist/index.js'

const banner = `
/**
 * rollup-dts-bundler
 * @license MIT
 */
`.trim()

export default defineConfig([
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.js', format: 'es', banner, sourcemap: true },
    external: /node_modules/,
    plugins: [
      nodeResolve(),
      typescript({
        declaration: false,
        declarationMap: false
      })
    ],
  },
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es', banner },
    plugins: [dts()],
  },
])
