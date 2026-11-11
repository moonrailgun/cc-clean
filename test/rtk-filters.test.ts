import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRtkOutput, matchRtkFilter } from '../src/vendor/rtk-filters.ts';
import { historyCommand } from '../src/shell-command.ts';

test('routes recognized commands across pipe, native and built-in registries', () => {
  for (const [command, expected] of [
    ['cargo test', 'cargo-test'], ['go test ./...', 'go-test'], ['go build ./...', 'go-build'],
    ['git -C repo status --porcelain', 'git-status'], ['git diff --stat', undefined],
    ['git log --oneline', 'git-log'], ['git diff', 'git-diff'],
    ['gh pr diff 42', 'git-diff'], ['glab mr diff 42', 'git-diff'],
    ['gt status --porcelain', 'git-status'], ['gt diff', 'git-diff'],
    ['python3 -m pytest', 'pytest'], ['npx tsc --noEmit', 'tsc'], ['vitest run', 'vitest'],
    ['rg -n TODO src', 'grep'], ['rg --files', 'find'], ['fd -t f', 'find'],
    ['ruff check .', 'ruff-check'], ['ruff format --check .', 'ruff-format'],
    ['sqlfluff lint .', 'sqlfluff-lint'], ['vendor/bin/phpunit', 'phpunit'],
    ['pest', 'pest'], ['paratest', 'paratest'], ['phpstan analyse', 'phpstan'], ['pint --test', 'pint'],
    ['terraform plan', 'rule:terraform-plan'], ['brew install example', 'rule:brew-install'],
    ['env', 'native:env'], ['printenv', 'native:env'],
  ] as const) assert.equal(matchRtkFilter(historyCommand(command)), expected, command);
});

test('ambiguous output-changing options and command arguments do not choose a rule', () => {
  for (const command of [
    'rg --json foo', 'rg -A2 foo', 'rg --files-with-matches foo', 'rg -l foo',
    'find . -exec cat {} +', 'fd --exec cat', 'git --version', 'git log --format=%H',
    'printf "terraform plan"', 'unknown --name "brew install"',
  ]) assert.equal(matchRtkFilter(historyCommand(command)), undefined, command);
});

test('shared safety boundary keeps unknown, oversized and terminal-control output', () => {
  for (const original of ['raw unknown output', 'abc\x1b[2Jdef', 'x'.repeat(4097), 'x\n'.repeat(600_000)])
    assert.equal(filterRtkOutput('rule:terraform-plan', original), original);
  assert.equal(filterRtkOutput('__proto__', 'hello world'), 'hello world');
  assert.equal(filterRtkOutput('rule:__proto__', 'hello world'), 'hello world');
  assert.equal(matchRtkFilter(['terraform', 'plan', 'x'.repeat(4097)]), undefined);
});
