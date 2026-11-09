# Publishing to npm

Run these commands from the repository root with Node.js 24.0.0 or newer. The package is `cc-clean`, and releases use the public npm registry.

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
npm publish --registry=https://registry.npmjs.org/
```

Verify that `whoami` identifies the intended npm account. Complete npm's authentication and two-factor prompts yourself; do not place credentials or tokens in this repository. `publishConfig` selects public access and the official registry.

Publishing a `.tgz` directly does not run the project's `prepublishOnly` checks. Git commits, tags and pushes remain separate manual steps.

After publishing:

```sh
npm view cc-clean version dist-tags --registry=https://registry.npmjs.org/
npm exec --yes --registry=https://registry.npmjs.org/ --package=cc-clean@1.0.0 -- cc-clean --version
```

Use the version just published. Users can then run `npx cc-clean@latest` or install it with `npm install --global cc-clean`.

## Subsequent releases

Each published release needs a new version. Update both version files before publishing:

```sh
npm version patch --no-git-tag-version
npm publish --registry=https://registry.npmjs.org/
```

Use `minor` for compatible features or `major` for breaking changes. CLI version output reads `package.json` in both source and compiled installations.

References: [npm publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/), and [npm publish command](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
