# Releasing

How `rollup-dts-bundler` ships to npm, and the quality gates behind it.

## Overview

There are two release paths. Both converge on one reusable workflow, re-run the full test suite before publishing, and authenticate to npm via OIDC trusted publishing.

| Path | Trigger | Version decided by | Release notes |
|---|---|---|---|
| **Manual** | `npm run release` (bumpp) | Maintainer (interactive prompt) | `conventional-changelog -p angular` |
| **Auto** | Renovate-authored push to `main` | `semantic-release` | `conventional-changelog-angular` (same preset) |

## Test suite and coverage

Tests live in [`test/`](test/) and run via Vitest.

- `npm test` — run the suite
- `npm run test:coverage` — run with v8 coverage (used by CI and release)

Coverage thresholds are enforced in [`vitest.config.ts`](vitest.config.ts):

| Metric | Threshold |
|---|---|
| Statements | 100% |
| Branches | 100% |
| Functions | 100% |
| Lines | 100% |

Falling below any threshold exits non-zero and turns CI/release red. New code should keep the suite at 100%, either with real tests or — for branches that are provably unreachable through the plugin's public surface — an inline `/* v8 ignore */` with a one-line rationale.

## CI — [`ci.yml`](.github/workflows/ci.yml)

Runs on every push to `main`, every PR, and manual dispatch.

- **Matrix:** Node `24.10` (our declared floor) and `lts/*` (drifts forward with Node's LTS line).
- **Steps:** `npm ci` > `typecheck` > `test:coverage`. (`test/dist.test.ts` rebuilds `dist/` via its own `beforeAll`, so a broken build surfaces as a failed test — no separate build step is needed in CI.)
- **Concurrency:** keyed per-PR / per-SHA, `cancel-in-progress: true`. A new push to the same PR kills the outdated run.

## Node engine policy

[`package.json`](package.json) declares:

```json
"engines": { "node": ">=24.10.0" }
```

The earliest API the plugin itself needs is `fs.mkdtempDisposableSync` (Node 24.4), but the floor sits at 24.10 because `semantic-release` (used in the auto-release path) requires it.

[`.npmrc`](.npmrc) sets `engine-strict=true`, so `npm ci` fails with `EBADENGINE` if any installed dependency raises its `engines.node` above our floor. Combined with CI pinned to Node `24.10`, this means: a dep bumps its Node floor above ours > CI red > Renovate automerge blocked > the maintainer is notified.

When that happens, either:
- Bump our `engines` with a `feat!:` commit (triggers a major release), or
- Hold the dep via a Renovate ignore rule.

## Automated releases (Renovate-driven)

1. Renovate opens a dep-update PR (weekly schedule).
2. CI runs on the PR. If green, Renovate automerges.
3. The merge-to-`main` push triggers [`release-auto.yml`](.github/workflows/release-auto.yml).
4. That workflow checks `github.actor == 'renovate[bot]'` — manual pushes to `main` are filtered out.
5. It calls the reusable [`release.yml`](.github/workflows/release.yml) with `is-auto: true`.
6. [`semantic-release`](https://github.com/semantic-release/semantic-release) runs end-to-end.

[`.releaserc.json`](.releaserc.json) configures four plugins:

- `commit-analyzer` — reads conventional commits since last tag, decides bump type
- `release-notes-generator` — produces `conventional-changelog` notes from those commits (angular preset)
- `npm` — bumps `package.json`, publishes via OIDC, pushes tag
- `github` — creates the GitHub release (PR/issue commenting/labeling disabled)

Commit-type to release mapping, set by [`renovate.json`](renovate.json):

| Renovate change | Commit prefix | Release effect |
|---|---|---|
| Peer or runtime major | `feat!:` + `BREAKING CHANGE:` body | Major |
| Runtime dep minor/patch | `fix:` | Patch |
| devDep minor/patch | `chore:` | None |
| Peer minor/patch | — | Disabled (range already covers) |

> Note: If no commits since the last tag qualify (all `chore:` or non-conventional), semantic-release logs "no release published" and exits.

## Manual releases

```bash
npm run release   # runs bumpp
```

[bumpp](https://github.com/antfu-collective/bumpp) prompts for the new version (patch / minor / major / custom), updates `package.json`, commits as `chore: release vX.Y.Z`, creates an annotated tag, and pushes both with `--follow-tags`.

Pushing the tag triggers [`release-manual.yml`](.github/workflows/release-manual.yml), which calls [`release.yml`](.github/workflows/release.yml) with `is-auto: false`. The bumpp commit itself lands on `main` but doesn't fire the auto path, as [`release-auto.yml`](.github/workflows/release-auto.yml) filters on `github.actor == 'renovate[bot]'`. The manual path then runs:

```bash
npm publish --provenance --access public
npx conventional-changelog -p angular | gh release create "$TAG" -F -
```

Release notes are generated from conventional-style commits since the previous tag. Non-conventional commits are omitted, so refactor noise and WIP messages stay out of the changelog.

**Commit discipline matters.** Work that should appear in the changelog needs a conventional prefix (`feat:`, `fix:`, `refactor:`, `docs:`, etc.). Anything else — or no prefix — is omitted.

**Why have a manual path?** Features often ship across multiple commits (refactor > infrastructure > feature). The manual tag push lets us batch commits into a single release and keep noise to a minimum.

## Reusable workflow — [`release.yml`](.github/workflows/release.yml)

Both paths call this single `workflow_call` workflow. It:

1. Checks out with full history (needed for tag detection).
2. Sets up Node `24.10` with the npm registry configured.
3. Installs deps; runs typecheck, tests (with coverage), and build as a final safety net. The explicit `build` step produces the `dist/` artifact for publish — `test/dist.test.ts` would also build it via `beforeAll`, but keeping `build` explicit makes the publish precondition visible.
4. Branches on `inputs.is-auto`:
   - Manual: `npm publish` + `conventional-changelog | gh release create`
   - Auto: `npx semantic-release`

Settings:

- **Permissions:** `contents: write` (tags, commits, releases) + `id-token: write` (npm OIDC). Caller workflows must grant both — a callee's permissions are a ceiling, not a grant.
- **Concurrency:** `group: release`, `cancel-in-progress: false`. `npm publish` is irreversible, so an in-flight release must finish; additional triggers queue behind it.
- **Timeout:** 15 minutes. Fails fast instead of the 6-hour default.

## Renovate — [`renovate.json`](renovate.json)

- `automerge: true` + weekly schedule — PRs merge themselves when CI is green.
- `group:allNonMajor` — all minor/patch updates batch into one PR per cycle (less noise, one patch release per batch).
- Peer deps minor/patch updates disabled — `^4.0.0` already covers every 4.x.
- Major updates (peer or runtime) > `feat!:` with `BREAKING CHANGE:` body > major release.
- devDep minor/patch > `chore:` > no release.
