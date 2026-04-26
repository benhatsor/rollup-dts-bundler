# rollup-dts-bundler

[![npm version][npm-version-src]][npm-version-href]
[![CI][ci-src]][ci-href]
[![Coverage][coverage-src]][coverage-href]

Rollup plugin for bundling `.d.ts` declarations via [@microsoft/api-extractor].

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
Versions are cut automatically when Renovate dependency updates land on `main`; `npm run release` is used for manual releases when grouping changes together. Both paths require the full test suite to pass (CI enforces 100% coverage) before publishing to npm with OIDC provenance. See [RELEASING.md](/RELEASING.md) for the full pipeline.

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
[coverage-src]: https://img.shields.io/badge/coverage-100%25-brightgreen
[coverage-href]: https://github.com/benhatsor/rollup-dts-bundler/blob/main/vitest.config.ts
