# Releasing

How `rollup-dts-bundler` ships to npm: the workflows, quality gates, and tooling behind a release.

## Overview

There are two release paths, and both converge on a single reusable workflow. Each one re-runs the full test suite before publishing and authenticates to npm via OIDC trusted publishing.

| Path | Trigger | Version determined by | Release notes |
|---|---|---|---|
| Manual | `npm run release` (bumpp) | Maintainer, via interactive prompt | `conventional-changelog -p angular` |
| Automated | Renovate-authored push to `main` | `semantic-release` | `conventional-changelog-angular` (same preset) |

## Test suite and coverage

The test suite lives in [`test/`](test/) and runs under Vitest. `npm test` runs the suite; `npm run test:coverage` runs it with v8 coverage and is the variant CI and the release workflow use.

Coverage thresholds are enforced in [`vitest.config.ts`](vitest.config.ts) at 100% across statements, branches, functions, and lines. Falling below any threshold exits non-zero and turns CI or the release red. New code is expected to keep the suite at 100%, either with real tests or — for branches provably unreachable through the plugin's public surface — an inline `/* v8 ignore */` with a one-line reason.

## Continuous integration

The CI workflow, [`ci.yml`](.github/workflows/ci.yml), runs on every push to `main`, every pull request, and on manual dispatch.

- **Node:** `lts/*`, which drifts forward with Node's current LTS line.
- **Steps:** `npm ci`, then `typecheck`, then `test:coverage`. There's no separate build step — [`test/dist.test.ts`](test/dist.test.ts) rebuilds `dist/` in its `beforeAll`, so a broken build surfaces as a failed test.
- **Concurrency:** keyed per pull request and per commit SHA, with `cancel-in-progress: true`, so a new push to a pull request kills the outdated run.

## Node engine policy

The package declares no `engines.node` constraint. CI and the release workflow both run on Node's current LTS via `actions/setup-node`'s `node-version: 'lts/*'`, and the library source is written against APIs available in every [supported Node release](https://nodejs.org/en/about/previous-releases), so an explicit floor is not required. Test files are not held to the same restriction — they use newer APIs (namely `mkdtempDisposableSync`) freely, since tests only run on the LTS pinned by CI. Consumers are implicitly gated by the runtime requirements of the project's transitive dependencies, which `npm install` reports through its standard engine warnings.

## Automated releases

Automated releases are driven by Renovate. The pipeline is:

1. Renovate opens a dependency-update pull request on its weekly schedule.
2. CI runs against the pull request. If green, Renovate automerges it.
3. The resulting push to `main` triggers [`release-auto.yml`](.github/workflows/release-auto.yml).
4. That workflow gates on `github.actor == 'renovate[bot]'`, filtering out manual pushes, and calls the [`release.yml`](.github/workflows/release.yml) with the `is-auto: true` argument.
5. [`semantic-release`](https://github.com/semantic-release/semantic-release) runs end-to-end.

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

Pushing the tag triggers [`release-manual.yml`](.github/workflows/release-manual.yml), which calls [`release.yml`](.github/workflows/release.yml) with the `is-auto: false` argument. The bumpp commit itself lands on `main` but doesn't fire the automated path, since [`release-auto.yml`](.github/workflows/release-auto.yml) gates on `github.actor == 'renovate[bot]'`. The manual path then runs:

```bash
npm publish --provenance --access public
npx conventional-changelog -p angular | gh release create "$TAG" -F -
```

Release notes are generated from conventional-style commits since the previous tag. Non-conventional commits are omitted, which keeps refactor noise and WIP messages out of the changelog. Anything that should appear in the changelog needs a conventional prefix like `feat:`, `fix:`, `refactor:`, or `docs:`.

The manual path exists alongside the automated one because features often span multiple commits — refactor, then infrastructure, then the feature itself. A manual tag push lets those commits be batched into a single release.

## Reusable release workflow

Both release paths call a single `workflow_call` workflow defined in [`release.yml`](.github/workflows/release.yml). It checks out with full history (needed for tag detection) and sets up Node's current LTS with the npm registry configured. After installing deps, it runs typecheck, tests with coverage, and an explicit build step. The build step produces the `dist/` artifact for publish; `test/dist.test.ts` would also build it via `beforeAll`, but keeping `build` explicit makes the publish precondition visible.

It then branches on the `inputs.is-auto` argument: the manual path runs `npm publish` followed by `conventional-changelog | gh release create`; the automated path runs `npx semantic-release`.

Settings:

- **Permissions:** `contents: write` (tags, commits, releases) and `id-token: write` (npm OIDC). Caller workflows have to grant both — a callee's permissions are a ceiling, not a grant.
- **Concurrency:** `group: release`, `cancel-in-progress: false`. `npm publish` is irreversible, so an in-flight release must finish; additional triggers queue behind it.
- **Timeout:** 15 minutes. Fails fast instead of GitHub Actions' six-hour default.

## Renovate configuration

Renovate's behavior is configured in [`renovate.json`](renovate.json). `automerge: true` plus a weekly schedule lets pull requests merge themselves when CI is green. The `group:allNonMajor` preset batches all minor and patch updates into one pull request per cycle, which means less noise and one patch release per batch.

`rangeStrategy: replace` tells Renovate to leave a range alone when the new version still satisfies it, and to rewrite it only when the new version falls outside. With caret ranges, that means majors only. For peers, this has two consequences: minor and patch updates open no pull request (the existing caret already covers them), while a major update rewrites the range (e.g. `^4.0.0` becomes `^5.0.0`) in the same pull request that bumps the matching devDep.

Major updates to peer or runtime deps are committed as `feat(deps)!:` and trigger a major release. The trailing `!` is the conventional-commits breaking-change marker, which the angular preset honors without needing a `BREAKING CHANGE:` body. Runtime dep minor and patch updates (lockfile-only changes) use `fix(deps):` and trigger a patch release. devDep updates use `chore(deps):` and trigger no release: a devDep major (e.g. Vitest 5) doesn't force a major on the library since it doesn't affect consumers.

devDeps don't appear in `renovate.json` because they need no override. Renovate picks them up through the default `npm` manager and applies its default `chore(deps):` prefix — which is the intended behavior. The `packageRules` entries exist only to override that default for runtime and peer deps, where `chore(deps):` would otherwise swallow a release that should fire.
