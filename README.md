# rollup-dts-bundler

[![npm version][npm-version-src]][npm-version-href]
[![CI][ci-src]][ci-href]

Rollup plugin for bundling `.d.ts` declarations via [@microsoft/api-extractor].

## Why?
[@microsoft/api-extractor] (Microsoft's official `.d.ts` bundler) produces significantly higher-quality output than most other third-party `.d.ts` bundlers (eg. [rollup-plugin-dts], [rolldown-plugin-dts], [dts-bundle-generator]), but is designed as a monolithic CLI tool with verbose config files. This plugin wraps it into a simple Rollup interface.

## Usage

Install the package from `npm`:
```sh
npm install --save-dev rollup-dts-bundler
```

Add it to your `rollup.config.js`:
```js
import dts from 'rollup-dts-bundler'

export default [
  // …
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
  }
]
```

And then instruct TypeScript where to find your definitions inside your `package.json`:
```json
  "types": "dist/index.d.ts",
```

> Note that the plugin will automatically exclude external libraries (eg. `@types`) from bundling.

## Options
```ts
dts({
  // Path to tsconfig.json (relative to cwd or absolute).
  // When omitted, walks up from the entry's directory to find the nearest tsconfig.
  tsconfig: 'tsconfig.build.json',

  // npm package names whose declarations should be inlined into the output
  // instead of left as external imports. Useful for re-exporting types from
  // an internal workspace package.
  bundledPackages: ['@my-scope/internal-types'],
})
```

## How it works
The entry point is stubbed out so Rollup only provides the input/output config. All real work happens in `generateBundle`: declarations are emitted via tsc, fed to api-extractor, and the result is output as an asset.

## License
[MIT](/LICENSE)


<!-- References -->
[@microsoft/api-extractor]: https://github.com/microsoft/rushstack/tree/main/apps/api-extractor
[rollup-plugin-dts]: https://github.com/Swatinem/rollup-plugin-dts
[rolldown-plugin-dts]: https://github.com/sxzz/rolldown-plugin-dts
[dts-bundle-generator]: https://github.com/timocov/dts-bundle-generator

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/rollup-dts-bundler.svg
[npm-version-href]: https://npmjs.com/package/rollup-dts-bundler
[ci-src]: https://github.com/benhatsor/rollup-dts-bundler/actions/workflows/ci.yml/badge.svg
[ci-href]: https://github.com/benhatsor/rollup-dts-bundler/actions/workflows/ci.yml
