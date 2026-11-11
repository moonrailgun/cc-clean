// SPDX-License-Identifier: Apache-2.0
// Synthetic cases derived from RTK 0.49.0 command-filter tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { nativeFilters, matchNativeFilter } from '../src/vendor/rtk-native.ts';

const jsFixture = (name: string) => readFileSync(new URL(`fixtures/rtk-js/${name}.txt`, import.meta.url), 'utf8');

const cases: [string, string, string][] = [
  ['npm', '> project@1.0.0 build\n> next build\nnpm WARN deprecated package\nnpm notice update\n\nBuild complete\n', '> next build\nBuild complete'],
  ['pnpm-install', 'Progress: resolved 42, reused 40\nPackages: +2\n+ react 19.0.0\ndependencies:\nDone in 2s\n', '+ react 19.0.0\ndependencies:'],
  ['bun-package', 'bun install v1.2.0\nResolving dependencies\nResolved, downloaded and extracted [4]\n\n+ react@19.0.0\n2 packages installed [20.00ms]\n', '+ react@19.0.0\n2 packages installed [20.00ms]'],
  ['bun-list', '{"react":{"version":"19.0.0"},"zod":{"version":"4.0.0"}}', '2 deps\nreact@19.0.0\nzod@4.0.0'],
  ['deno', 'Download https://example.test/module.ts\n\nCheck file:///project/mod.ts\n', 'Check file:///project/mod.ts'],
  ['ng-build', '❯ Building...\n✔ Building...\nInitial chunk files   | Names   | Raw size\nmain.js   | main   | 1 kB\n', 'Initial chunk files | Names | Raw size\nmain.js | main | 1 kB\n'],
  ['prisma-generate', 'Prisma schema loaded from prisma/schema.prisma\n✔ Generated Prisma Client to ./node_modules/@prisma/client in 42ms\n', 'Prisma Client generated\n  • Output: node_modules/@prisma/client'],
  ['prisma-migrate-status', jsFixture('prisma-status'), 'Migrations: 9 applied, 0 pending'],
  ['prisma-migrate-deploy', jsFixture('prisma-deploy'), '1 migration(s) deployed'],
  ['prisma-db-push', 'Prisma schema loaded from schema.prisma\nYour database is now in sync with your Prisma schema.\n', 'Schema pushed to database'],
  ['pip-list', '[{"name":"zod","version":"1"},{"name":"attrs","version":"2"}]', 'pip list: 2 packages\n\n[A]\n  attrs (2)\n\n[Z]\n  zod (1)'],
  ['pip-outdated', '[{"name":"attrs","version":"1","latest_version":"2"}]', 'pip outdated: 1 packages\n1. attrs (1 → 2)\n\n[hint] Run `pip install --upgrade <package>` to update'],
  ['tree', '.\n├── src\n│   └── main.rs\n└── Cargo.toml\n\n2 directories, 3 files\n', '.\n├── src\n│   └── main.rs\n└── Cargo.toml\n'],
  ['php-lint', 'No syntax errors detected in app/Foo.php\nNo syntax errors detected in app/Bar.php\n', 'ok app/Foo.php\nok app/Bar.php'],
  ['go-vet', '# example/pkg\n./main.go:10:2: fmt.Printf format %d has arg name of wrong type string\n', 'Go vet: 1 issues\n1. ./main.go:10:2: fmt.Printf format %d has arg name of wrong type string'],
];

for (const [name, input, expected] of cases) {
  test(`${name}: source-derived output contract`, () => {
    assert.equal(typeof nativeFilters[name], 'function', `missing filter ${name}`);
    assert.equal(nativeFilters[name](input), expected);
  });
}

test('Next.js counts tree-prefixed routes, excludes legends and retains bundle details', () => {
  const output = nativeFilters['next-build'](jsFixture('next-build'));
  assert.match(output, /3 routes \(2 static, 1 dynamic\)/);
  assert.match(output, /\/about\s+156 kB/);
  assert.match(output, /\/api\/auth\s+89 kB/);
});

test('Next.js keeps route names out of diagnostic counts and build timing', () => {
  for (const router of ['app', 'pages']) {
    const input = jsFixture('next-build').replace('Route (app)', `Route (${router})`)
      .replace('┌ ○ / ', '┌ ○ /warnings ').replace('/about', '/_error').replace('/api/auth', '/login/123ms');
    const output = nativeFilters['next-build'](input);
    assert.match(output, /3 routes \(2 static, 1 dynamic\)/);
    assert.match(output, /\/_error\s+156 kB/);
    assert.match(output, /Time: 5\.0s \| Errors: 0 \| Warnings: 0$/);
    assert.match(nativeFilters['next-build'](input + 'Warning: deprecated setting\nError: optional export failed\n'),
      /Time: 5\.0s \| Errors: 1 \| Warnings: 1$/);
  }
});

test('Next.js recognizes SSG, legacy dynamic and partial routes with bracketed paths', () => {
  const input = jsFixture('next-build').replace('┌ ○ / ', '┌ ● / ').replace('├ ○ /about', '├ ◐ /blog/[slug]').replace('└ ƒ /api/auth', '└ λ /api/auth');
  const output = nativeFilters['next-build'](input);
  assert.match(output, /3 routes \(1 static, 1 dynamic, 1 partial\)/);
  assert.match(output, /\/blog\/\[slug\]\s+156 kB/);
});

test('Next.js converts byte sizes without inventing bundle growth warnings', () => {
  const input = jsFixture('next-build').replace('2.5 kB        156 kB', '2500 B        156000 B');
  const output = nativeFilters['next-build'](input);
  assert.match(output, /\/about\s+156 kB/);
  assert.doesNotMatch(output, /\[warn\]|Infinity/);
});

test('Next.js preserves unrecognized or incomplete route tables', () => {
  const input = jsFixture('next-build');
  for (const value of [
    input.replace(/^.*[┌├└].*\n/gm, ''),
    input.replace('└ ƒ /api/auth', '└ ? /api/auth'),
    input.replace('0.5 kB         89 kB', 'unknown-size'),
    input.replace('Route (app)                    Size     First Load JS', 'Route (app)                    Unknown columns'),
  ]) assert.equal(nativeFilters['next-build'](value), value);
});

test('Prisma deploy counts the final migration list, not progress lines or success prose', () => {
  const input = jsFixture('prisma-deploy').replace('1 migration found', '9 migrations found').replace(
    '    └─ migration.sql\n', '    └─ migration.sql\n  └─ 20260102000000_add/\n    └─ migration.sql\n  └─ 20260103000000_index/\n    └─ migration.sql\n',
  );
  assert.equal(nativeFilters['prisma-migrate-deploy'](input), '3 migration(s) deployed');
  assert.equal(nativeFilters['prisma-migrate-deploy']('Prisma schema loaded from prisma/schema.prisma\n9 migrations found in prisma/migrations\n\nNo pending migrations to apply.\n'), '0 migration(s) deployed');
});

test('Prisma preserves migration counts that cannot be established from a complete report', () => {
  const status = jsFixture('prisma-status'), deploy = jsFixture('prisma-deploy');
  for (const value of [status.replace('9 migrations found in prisma/migrations\n', ''), status.replace('Database schema is up to date!', 'Following migration have not yet been applied:\n20260101000000_init')])
    assert.equal(nativeFilters['prisma-migrate-status'](value), value);
  for (const value of [deploy.replace(/The following migration\(s\)[\s\S]*?All migrations/, 'All migrations'), deploy.replace('All migrations have been successfully applied.', ''), deploy.replace('    └─ migration.sql', '    └─ unknown-file')])
    assert.equal(nativeFilters['prisma-migrate-deploy'](value), value);
});

test('every native filter preserves unknown and empty input', () => {
  for (const [name, filter] of Object.entries(nativeFilters)) {
    for (const input of ['', 'unknown output\n  keep spacing\n', '{"unrelated":true}', '[{"unrelated":true}]']) {
      assert.equal(filter(input), input, `${name}: ${input}`);
    }
  }
});

test('native matching restricts output formats and subcommands', () => {
  assert.equal(matchNativeFilter(['gradle', 'build']), 'gradle-build');
  assert.equal(matchNativeFilter(['dotnet', 'restore']), 'dotnet-restore');
  assert.equal(matchNativeFilter(['aws', 'sts', 'get-caller-identity']), 'aws-sts-identity');
  assert.equal(matchNativeFilter(['black', '--check', '.']), 'black');
  assert.equal(matchNativeFilter(['env']), 'env');
  assert.equal(matchNativeFilter(['env', 'node', 'script.js']), undefined);
  assert.equal(matchNativeFilter(['ls', '-l']), 'ls-long');
  assert.equal(matchNativeFilter(['ls', '-la']), 'ls-long-all');
  assert.equal(matchNativeFilter(['ls']), undefined);
  assert.equal(matchNativeFilter(['ls', '-lR']), undefined);
  assert.equal(matchNativeFilter(['cargo', 'nextest', 'list']), undefined);
  assert.equal(matchNativeFilter(['npm', 'install']), 'npm');
  assert.equal(matchNativeFilter(['pnpm', 'install']), 'pnpm-install');
  assert.equal(matchNativeFilter(['pip', 'list', '--format=json']), 'pip-list');
  assert.equal(matchNativeFilter(['pip', 'list']), undefined);
  assert.equal(matchNativeFilter(['prisma', 'migrate', 'status']), 'prisma-migrate-status');
  assert.equal(matchNativeFilter(['ng', 'build', '--watch']), undefined);
  assert.equal(matchNativeFilter(['git', 'log']), undefined);
  assert.equal(matchNativeFilter(['unknown', 'install']), undefined);
});
