# rollup-dts-bundler

[![npm version][npm-version-src]][npm-version-href]
[![CI][ci-src]][ci-href]
[![Coverage Status][coverage-src]][coverage-href]

Rollup plugin for high-quality `.d.ts` bundling via [@microsoft/api-extractor].

## Why?
[@microsoft/api-extractor] is Microsoft's official `.d.ts` bundler. It produces higher-quality output than common alternatives ([rollup-plugin-dts], [rolldown-plugin-dts], [dts-bundle-generator]), but is designed as a monolithic CLI with verbose config files. This plugin wraps it in a simple Rollup interface.

## Usage

Install the package from `npm`:
```sh
npm install --save-dev rollup-dts-bundler
```

Add it to your `rollup.config.js`:
```js
import { dts } from 'rollup-dts-bundler'

export default [
  // …
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts()],
  }
]
```

Then point your `package.json` at the output:
```json
  "types": "dist/index.d.ts",
```

> External libraries (e.g. `@types/*`) are automatically excluded from bundling.

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
The entry point is stubbed out so Rollup only provides the input/output config. All real work happens in the `generateBundle` hook: declarations are emitted via tsc, fed to api-extractor, and the result is output as an asset.

## Releases
Releases publish to npm with OIDC provenance after the test suite passes at 100% coverage. Renovate dependency updates on `main` release automatically; `npm run release` cuts a manual release. See [RELEASING.md](/RELEASING.md) for details.

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
[coverage-src]: https://coveralls.io/repos/github/benhatsor/rollup-dts-bundler/badge.svg?branch=main
[coverage-href]: https://coveralls.io/github/benhatsor/rollup-dts-bundler?branch=main
