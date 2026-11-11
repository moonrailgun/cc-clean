import assert from 'node:assert/strict';
import test from 'node:test';
import { historyCommand, historyArgv } from '../src/shell-command.ts';

test('parses literal shell words and harmless directory/environment wrappers', () => {
  for (const [input, expected] of [
    ['rg -n "a b" src', ['rg', '-n', 'a b', 'src']],
    ["cd '/path with spaces' && rg -n 'a|b;$HOME' .", ['rg', '-n', 'a|b;$HOME', '.']],
    ['cd -- src && cd nested && CI=1 env NO_COLOR=1 cargo test', ['cargo', 'test']],
    ['env -u DEBUG -- /usr/bin/git -C repo status --porcelain', ['git', '-C', 'repo', 'status', '--porcelain']],
    ['/usr/bin/env', ['env']],
    ['npx --no-install tsc --noEmit', ['tsc', '--noEmit']],
    ['pnpm exec vitest run', ['vitest', 'run']],
    ['npm exec -- tsc --noEmit', ['tsc', '--noEmit']],
    ['uv run -- pytest -q', ['pytest', '-q']],
    [String.raw`rg -n foo\ bar src`, ['rg', '-n', 'foo bar', 'src']],
    [String.raw`rg 'it'\''s' src`, ['rg', "it's", 'src']],
    ['bash -lc "cargo test"', ['cargo', 'test']],
    ['python3 -m pytest -q', ['pytest', '-q']],
    ['node ./node_modules/typescript/bin/tsc --noEmit', ['tsc', '--noEmit']],
  ] as const) assert.deepEqual(historyCommand(input), expected, input);
});

test('refuses composed, dynamic, redirected or ambiguous commands', () => {
  for (const input of [
    'rg x | head', 'rg x; git status', 'cargo test && echo done', 'cd x || rg a',
    'rg "$PATTERN" .', 'rg `echo x`', 'rg $(echo x)', 'rg x >out', 'rg x 2>&1',
    'rg x\nfind .', 'rg "unterminated', "rg 'unterminated", 'rg x &',
    'env --chdir=/tmp rg x', 'npx --package=other tsc', 'npm run test',
    'sh -c "cargo test" extra', 'cd - && rg x', 'cd -- && rg x',
    'uv run --with unknown pytest', 'node custom.js',
    'rg x # rg y', 'rg x\\', 'rg a\0b', 'rg a\r',
  ]) assert.equal(historyCommand(input), undefined, input);
  assert.equal(historyCommand(null), undefined);
  assert.equal(historyCommand('x'.repeat(16_385)), undefined);
});

test('literal punctuation stays a word and never becomes shell syntax', () => {
  assert.deepEqual(historyCommand("rg -n 'x && cd y' 'src;tmp'"), ['rg', '-n', 'x && cd y', 'src;tmp']);
  assert.deepEqual(historyCommand('rg -n "a; b" src'), ['rg', '-n', 'a; b', 'src']);
  assert.equal(historyCommand('cd x && cd y'), undefined);
});

test('assignment syntax applies only to unquoted shell prefixes or env arguments', () => {
  assert.deepEqual(historyCommand('CI="yes please" cargo test'), ['cargo', 'test']);
  assert.deepEqual(historyCommand('"CI=1" cargo test'), ['CI=1', 'cargo', 'test']);
  assert.deepEqual(historyCommand('CI\\=1 cargo test'), ['CI=1', 'cargo', 'test']);
  assert.deepEqual(historyArgv(['CI=1', 'cargo', 'test']), ['CI=1', 'cargo', 'test']);
  assert.deepEqual(historyArgv(['env', 'CI=1', 'cargo', 'test']), ['cargo', 'test']);
});
