# Releasing

`rollup-dts-bundler` is published to npm through two release paths: a manual path driven by a maintainer version bump, and an automated path driven by [Renovate](https://github.com/apps/renovate) dependency updates. Both run in a single GitHub Actions workflow that runs the test suite and publishes via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers). Release notes follow the [Conventional Commits](https://www.conventionalcommits.org/) Angular preset.

## Overview

| Path | Trigger | Version determined by | Release notes |
|---|---|---|---|
| Manual | `npm run release` (bumpp) | Maintainer, via interactive prompt | `conventional-changelog -p angular` |
| Automated | Renovate-authored push to `main` | `semantic-release` | `conventional-changelog-angular` (same preset) |

## Test suite and coverage

The test suite lives in [`test/`](test/) and runs under [Vitest](https://vitest.dev/). `npm test` runs the suite; `npm run test:coverage` runs it with [v8 coverage](https://vitest.dev/guide/coverage.html#v8-provider) and is the variant CI and the release workflow use.

Coverage thresholds are enforced in [`vitest.config.ts`](vitest.config.ts) at 100% across statements, branches, functions, and lines. Falling below any threshold exits non-zero and turns CI or the release red. New code is expected to keep the suite at 100%, either with real tests or — for branches provably unreachable through the plugin's public surface — an inline `/* v8 ignore */` with a one-line reason.

## Continuous integration

The CI workflow, [`ci.yml`](.github/workflows/ci.yml), runs on every push to `main`, every pull request, and on manual dispatch.

- **Node:** `lts/*` — see [Node engine policy](#node-engine-policy) below.
- **Steps:** `npm ci`, then `typecheck`, then `test:coverage`. There's no separate build step — [`test/dist.test.ts`](test/dist.test.ts) rebuilds `dist/` in its `beforeAll`, so a broken build surfaces as a failed test.
- **Concurrency:** keyed per pull request and per commit SHA, with `cancel-in-progress: true`, so a new push to a pull request kills the outdated run.

## Node engine policy

The package declares no `engines.node` constraint. The source only uses APIs available in every [supported Node release](https://nodejs.org/en/about/previous-releases), and consumers are additionally gated by the engine requirements of transitive dependencies.

## Automated releases

Automated releases are driven by Renovate. The pipeline is:

1. Renovate opens a dependency-update pull request on its weekly schedule.
2. CI runs against the pull request. If green, Renovate automerges it.
3. The resulting push to `main` triggers [`release.yml`](.github/workflows/release.yml), which gates on `github.actor == 'renovate[bot]'` to filter out non-Renovate pushes.
4. [`semantic-release`](https://github.com/semantic-release/semantic-release) runs end-to-end.

The [`.releaserc.json`](.releaserc.json) config enables four semantic-release plugins:

- `commit-analyzer` reads conventional commits since the last tag and decides the bump type.
- `release-notes-generator` produces release notes from those commits using the angular preset.
- `npm` bumps `package.json`, publishes via OIDC, and pushes the tag.
- `github` creates the GitHub release. PR and issue commenting and labeling are disabled.

The mapping from Renovate-authored commits to release effects, set in [`renovate.json`](renovate.json):

| Renovate change | Commit prefix | Release effect |
|---|---|---|
| Peer or runtime major | `feat(deps)!:` | Major |
| Runtime dependency minor or patch | `fix(deps):` | Patch |
| Development dependency, any update | `chore(deps):` | None |
| Peer minor or patch | — | No pull request opened |

Runtime minor and patch updates are lockfile-only — the existing caret range in `package.json` already covers them, so only `package-lock.json` changes — but they still ship as a `fix(deps):` commit and trigger a patch release.

Peer and devDep major updates for the same package are forced into a single commit by an explicit packageRule:

```json
{
  "matchDepTypes": ["peerDependencies", "devDependencies"],
  "matchUpdateTypes": ["major"],
  "matchPackageNames": ["rollup", "typescript"],
  "groupName": "{{depName}}",
  "commitMessagePrefix": "feat(deps)!:"
}
```

The rule is scoped to majors because that's the only case where a mismatch can happen — non-major peer updates produce no PR (the existing caret already covers them), and devDep non-majors join the weekly `group:allNonMajor` batch. Without the rule, branch-name collision usually colocates the two updates anyway, but timing edge cases (rate limits, partial runs, a PR auto-merging before the second depType is processed) could publish a peer range that doesn't match the version the suite actually ran against.

The package list mirrors the project's peers. Renovate has no matcher for "appears in `peerDependencies`," so the names are listed explicitly; adding a peer to `package.json` requires also adding it here. The `commitMessagePrefix` is set on the rule itself rather than inherited from the more general major rule above, because Renovate's prefix on a grouped commit is non-deterministic when only some of the grouped updates carry an explicit prefix — and the safe-fallback behavior on mixed-type groups is `chore(deps):`, which would silently skip the release.

The two peer-matching rules are intentionally redundant. Renovate [merges matching rules in order, with later rules overriding earlier ones](https://docs.renovatebot.com/configuration-options/#packagerules), which makes the generic rule a fallback: a peer dependency added to `package.json` but absent from the named list still receives the `feat(deps)!:` prefix on its own commit, producing an ungrouped breaking commit rather than a silent release skip.

If no commits since the last tag qualify for a release — for example, only `chore:` or non-conventional commits have landed — semantic-release logs "no release published" and exits.

## Manual releases

A manual release starts with:

```bash
npm run release
```

This invokes [bumpp](https://github.com/antfu-collective/bumpp), which prompts for the new version (patch, minor, major, or custom). Once chosen, bumpp updates `package.json`, commits the change as `chore: release vX.Y.Z`, and creates an annotated tag. The branch and tag are then pushed together with `--follow-tags`.

Pushing the tag triggers [`release.yml`](.github/workflows/release.yml). The bumpp commit itself lands on `main` but doesn't fire the automated path, since the workflow gates the automated branch on `github.actor == 'renovate[bot]'`. The manual path then runs:

```bash
npm publish --provenance --access public
npx conventional-changelog -p angular | gh release create "$TAG" -F -
```

Release notes are generated from conventional-style commits since the previous tag. Non-conventional commits are omitted, which keeps refactor noise and WIP messages out of the changelog. Anything that should appear in the changelog needs a conventional prefix like `feat:`, `fix:`, `refactor:`, or `docs:`.

The manual path exists alongside the automated one because features often span multiple commits — refactor, then infrastructure, then the feature itself. A manual tag push lets those commits be batched into a single release.

## Release workflow

Both release paths run in a single workflow defined in [`release.yml`](.github/workflows/release.yml), triggered by tag pushes (`v*`) and pushes to `main`. It runs as two jobs:

1. **`verify`** calls [`ci.yml`](.github/workflows/ci.yml) as a reusable workflow, applying the same typecheck and `test:coverage` gate that pull requests see.
2. **`publish`** depends on `verify`. It checks out with full history (required for tag detection by `semantic-release` and `conventional-changelog`), sets up Node on `lts/*` with the npm registry configured, and installs dependencies. It then builds the publish artifact and branches on the trigger: a tag push runs `npm publish` followed by `conventional-changelog | gh release create`; a Renovate-authored branch push runs `npx semantic-release`.

Both jobs share the gate `github.ref_type == 'tag' || github.actor == 'renovate[bot]'`, so an ordinary push to `main` skips the workflow. The jobs run on separate runners.

The workflow has to be a single top-level workflow rather than a reusable workflow called by thinner triggers, because npm's trusted publisher matches against the caller workflow filename, not the reusable workflow's filename (see [npm/documentation#1755](https://github.com/npm/documentation/issues/1755)). Splitting manual and automatic into separate caller workflows would require two trusted publisher entries, but npm allows only one per package.

Settings:

- **Permissions:** `contents: write` (tags, commits, releases) and `id-token: write` (npm OIDC).
- **Concurrency:** `group: release`, `cancel-in-progress: false`. `npm publish` is irreversible, so an in-flight release must finish; additional triggers queue behind it.
- **Timeout:** 15 minutes. Fails fast instead of GitHub Actions' six-hour default.

The automatic step's `github.ref_type == 'branch'` check is defensive. GitHub [already blocks](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow) the tag `semantic-release` pushes from re-triggering this workflow when using the default GitHub token, but the gate prevents a double-publish via the manual path if a different token is wired in later.

## Renovate configuration

Renovate's behavior is configured in [`renovate.json`](renovate.json). `automerge: true` plus a weekly schedule lets pull requests merge themselves when CI is green. The `group:allNonMajor` preset batches all minor and patch updates into one pull request per cycle, which means less noise and one patch release per batch.

`rangeStrategy: replace` tells Renovate to leave a range alone when the new version still satisfies it, and to rewrite it only when the new version falls outside. With caret ranges, that means majors only. For peers, this has two consequences: minor and patch updates open no pull request (the existing caret already covers them), while a major update rewrites the range (e.g. `^4.0.0` becomes `^5.0.0`) in the same pull request that bumps the matching devDep.

Major updates to peer or runtime deps are committed as `feat(deps)!:` and trigger a major release. The trailing `!` is the conventional-commits breaking-change marker, which the angular preset honors without needing a `BREAKING CHANGE:` body. Runtime dep minor and patch updates (lockfile-only changes) use `fix(deps):` and trigger a patch release. devDep updates use `chore(deps):` and trigger no release; a devDep major (e.g. Vitest 5) doesn't force a major on the library because it doesn't affect consumers.

devDeps don't appear in `renovate.json` because they need no override. Renovate picks them up through the default `npm` manager and applies its default `chore(deps):` prefix — which is the intended behavior. The `packageRules` entries exist only to override that default for runtime and peer deps, where `chore(deps):` would otherwise swallow a release that should fire.
