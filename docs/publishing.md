# Publishing to npm

Run these commands from the repository root with Node.js 24.15.0 or newer in the Node.js 24 line (required by release-it). The package is `cc-clean`, and releases use the public npm registry. Installed CLI users still need Node.js 24.0.0 or newer.

## Prepare and inspect

Review `git status --short` and the changes intended for this release. npm packages the current working files, including uncommitted changes in the package's file list. Project code uses [MIT](../LICENSE); keep the RTK license and attribution in `third_party/rtk/` in every package.

```sh
npm ci
npm publish --dry-run
```

The dry run does not upload a package. `prepublishOnly` runs type checking and `test:read-only`; `prepack` builds the CLI. A failing check stops publication. The full `npm test` suite is deliberately excluded because it includes cleanup and native deletion tests.

Inspect the printed file list and size. The package should contain compiled `dist/` files, `package.json`, the README, license, project instructions, the selected reference guides, and RTK attribution. It should not contain source histories, credentials, tests, `node_modules/`, or development plans. No cleanup command or cleanup preview is needed for release verification.

Create a tarball and test its command entry point before publishing:

```sh
npm pack
npm exec --package=/absolute/path/cc-clean-1.0.0.tgz -- cc-clean --version
npm exec --package=/absolute/path/cc-clean-1.0.0.tgz -- cc-clean --help --json
```

Use the actual tarball path and version printed by `npm pack`.

## Authenticate and publish

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm run release
```

Verify that `whoami` identifies the intended npm account. Complete npm's authentication and two-factor prompts yourself; do not place credentials or tokens in this repository. `publishConfig` selects public access and the official registry.

`npm run release` uses release-it to select the next version interactively, update `package.json` and `package-lock.json`, then confirm npm publication. It invokes `npm publish` with `--registry=https://registry.npmjs.org/`; the existing `prepublishOnly` checks and `prepack` build run before upload. Git commits, tags and pushes are disabled and remain separate manual steps.

To publish the current version without incrementing it (for example, the initial `1.0.0` release), use `npm publish --registry=https://registry.npmjs.org/` directly. Publishing a `.tgz` directly does not run the project's `prepublishOnly` checks.

If publishing fails or is declined after the version bump, inspect both version files before retrying. To retry the already-bumped version, use the direct `npm publish` command above rather than incrementing it again.

After publishing:

```sh
npm view cc-clean version dist-tags --registry=https://registry.npmjs.org/
npm exec --yes --registry=https://registry.npmjs.org/ --package=cc-clean@1.0.0 -- cc-clean --version
```

Use the version just published. Users can then run `npx cc-clean@latest` or install it with `npm install --global cc-clean`.

## Subsequent releases

Each published release needs a new version. Choose interactively with `npm run release`, or specify the increment:

```sh
npm run release:patch
npm run release -- minor
npm run release -- major
```

Use `minor` for compatible features or `major` for breaking changes. CLI version output reads `package.json` in both source and compiled installations.

Preview the release commands without changing versions or publishing:

```sh
npm run release:patch -- --dry-run --ci
```

release-it's dry run skips the version update and invokes `npm publish --dry-run`, which runs the existing checks and build for the current version without uploading. It still checks npm authentication; before login, append `--npm.skipChecks` to this dry-run command only. Normal releases retain the account and permission checks.

References: [npm publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/), [npm publish command](https://docs.npmjs.com/cli/v11/commands/npm-publish/), and [release-it npm configuration](https://github.com/release-it/release-it/blob/main/docs/npm.md).
