import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileRtkRule, filterRtkRule, matchRtkRule } from '../src/vendor/rtk-rules.ts';

test('built-in command selection preserves Unicode word boundaries and scoped flags', () => {
  for (const command of ['java -jar MySpringApp.jar', 'java -jar C:\\dev\\my-SPRING-app.jar', 'gradle bootRun']) {
    assert.equal(matchRtkRule(command), 'spring-boot', command);
  }
  for (const command of ['JAVA -jar spring.jar', 'java -jar spring.JAR', 'java -jar /spring-cache/other.jar',
    'java -jar C:\\spring-cache\\other.jar', 'java -jar C:\\Program Files\\spring.jar',
    'ssh-keygen', 'timeout 5 liquibase update', '/usr/bin/liquibase', 'make日本', 'make\u0301', 'unknown']) {
    assert.equal(matchRtkRule(command), undefined, command);
  }
  assert.equal(matchRtkRule('make all'), 'make');
  assert.equal(matchRtkRule('brew\u0085install'), 'brew-install');
  assert.equal(matchRtkRule('brew\ufeffinstall'), undefined);
  assert.equal(filterRtkRule('unknown', 'unmodified\r\n'), 'unmodified\r\n');
});

test('Rust Unicode classes preserve non-ASCII digits, words and whitespace', () => {
  assert.equal(filterRtkRule('make', 'make[١]: entering\nkeep\n'), 'keep');
  assert.equal(filterRtkRule('mise', 'mise 工具@١.٢ installed\nkeep'), 'keep');
  assert.equal(filterRtkRule('make', '\u0085\nkeep\n\ufeff'), 'keep\n\ufeff');
});

test('Rust lines remove CR only with LF, retain internal empty lines, and drop the final delimiter', () => {
  assert.equal(filterRtkRule('mix-format', 'a\r\n\nb\r'), 'a\n\nb\r');
  assert.equal(filterRtkRule('mix-format', 'a\r\n'), 'a');
  assert.equal(filterRtkRule('mix-format', '\u0085'), 'mix format: ok');
  assert.equal(filterRtkRule('mix-format', '\ufeff'), '\ufeff');
});

test('truncation counts Unicode code points and max-lines counts omission markers', () => {
  assert.equal(filterRtkRule('df', '😀'.repeat(81)), `${'😀'.repeat(77)}...`);
  const filter = compileRtkRule({ match_command: '^test', truncate_lines_at: 5, head_lines: 2, tail_lines: 1, max_lines: 3 });
  assert.equal(filter.filter('日本語xyz\na\nb\nc\nd'), '日本...\na\n... (2 lines omitted)\n... (1 lines truncated)');
  assert.equal(compileRtkRule({ match_command: '^test', truncate_lines_at: 1 }).filter('日本'), '...');
  assert.equal(compileRtkRule({ match_command: '^test', head_lines: 1 }).filter('a\nb\nc'), 'a\n... (2 lines omitted)');
  assert.equal(compileRtkRule({ match_command: '^test', tail_lines: 1 }).filter('a\nb\nc'), '... (2 lines omitted)\nc');
  assert.equal(compileRtkRule({ match_command: '^test', tail_lines: 0 }).filter('a\nb'), '... (2 lines omitted)');
});

test('replace chains use Rust capture interpolation before full-output matching and line filtering', () => {
  const filter = compileRtkRule({ match_command: '^test', strip_ansi: true,
    replace: [{ pattern: '(?P<left>\\w+):(\\w+)', replacement: '$2:${left}:$0:$$:$&:$1x' },
      { pattern: '^drop', replacement: 'NOISE' }], strip_lines_matching: ['^NOISE'],
    match_output: [{ pattern: 'ok:日本', message: 'matched', unless: 'ERROR' }], on_empty: 'empty' });
  assert.equal(filter.filter('\x1b[31m日本:ok\x1b[0m'), 'matched');
  assert.equal(filter.filter('日本:ok\nERROR'), 'ok:日本:日本:ok:$:$&:\nERROR');
  assert.equal(filter.filter('drop'), 'empty');
  assert.equal(compileRtkRule({ match_command: '^test', replace: [{ pattern: '(a)?b', replacement: '<$1>${missing}' }] }).filter('b ab'), '<> <a>');
});

test('regex anchors and dots follow Rust newline semantics, including inline flags', () => {
  const match = (pattern: string, input: string) => compileRtkRule({ match_command: '^test',
    match_output: [{ pattern, message: 'matched' }] }).filter(input);
  assert.equal(match('^a$', 'a\n\n'), 'a\n');
  assert.equal(match('a.b', 'a\u2028b'), 'matched');
  assert.equal(match('a.b', 'a\rb'), 'matched');
  assert.equal(match('(?m)^b$', 'a\nb\nc'), 'matched');
  assert.equal(match('(?m)^b$', 'a\rb\rc'), 'a\rb\rc');
  assert.equal(match('(?s)^a.b$', 'a\nb'), 'matched');
  assert.equal(match('(?i)^hello$', 'HELLO'), 'matched');
});

test('invalid or unsupported regexes cannot silently omit a rule', () => {
  assert.throws(() => compileRtkRule({ match_command: '^test', strip_lines_matching: ['['] }));
  assert.throws(() => compileRtkRule({ match_command: '^test', strip_lines_matching: ['x'], keep_lines_matching: ['y'] }), /mutually exclusive/);
  assert.throws(() => compileRtkRule({ match_command: '^test', strip_lines_matching: ['(?x) a b'] }), /Unsupported/);
});

test('all retained upstream inline fixtures produce the pinned expected output', async t => {
  const fixtures = JSON.parse(readFileSync(new URL('../third_party/rtk/filters/fixtures.json', import.meta.url), 'utf8')) as
    { filter: string; name: string; input: string; expected: string }[];
  assert.equal(fixtures.length, 151);
  assert.equal(new Set(fixtures.map(fixture => fixture.filter)).size, 62);
  for (const fixture of fixtures) await t.test(`${fixture.filter}: ${fixture.name}`, () => {
    // Upstream collect_test_outcomes ignores trailing LF from TOML multiline strings.
    assert.equal(filterRtkRule(fixture.filter, fixture.input).replace(/\n+$/, ''), fixture.expected.replace(/\n+$/, ''));
  });
});
