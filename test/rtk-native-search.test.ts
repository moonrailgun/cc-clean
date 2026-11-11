import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanSearchLine, compactSearchPath, foldSearchPathPrefix, formatSearchMatchBlock,
  formatSearchMatchLine, parseSearchMatchLine, renderSearchOutput, renderSearchStream,
} from '../src/vendor/rtk-native-search.ts';

const options = { showFile: true, showLine: true, maxResults: 10, maxPerFile: 5, maxLineLength: 80, pattern: 'hit' };
const row = (file: string, n: number, content: string, match = true) => `${file}\0${n}${match ? ':' : '-'}${content}\n`;

test('RTK search parses NUL-delimited matches without confusing path or content colons', () => {
  for (const [file, n, content, isMatch] of [
    ['file.php', 10, 'use Foo\\Bar;', true],
    ['externalImportShell.class.php', 81, "        $this->queueProcessModel = ClassRegistry::init('Collections.QueueProcess');", true],
    ['C:\\src\\file.rs', 42, 'fn main() {}', true],
    ['badly_named:52:file.txt', 1, 'xxx', true],
    ['log.txt', 7, 'debug: counter is :42: now', true],
    ['file.rs', 7, '', true],
    ['file.txt', 4, 'after1', false],
  ] as const) {
    assert.deepEqual(parseSearchMatchLine(row(file, n, content, isMatch).slice(0, -1)), { file, lineNumber: n, content, isMatch });
  }
  for (const input of ['file.rs:1:content', 'not a match line', 'file.rs\0fn foo()', '', 'f\0' + '9007199254740992:x']) {
    assert.equal(parseSearchMatchLine(input), undefined);
  }
});

test('RTK search line formatting and full blocks keep match/context separators', () => {
  assert.equal(formatSearchMatchLine('f.txt\0' + '42:hit', false, false), 'hit\n');
  assert.equal(formatSearchMatchLine('f.txt\0' + '4-after', true, true), 'f.txt-4-after\n');
  assert.equal(formatSearchMatchLine('f.txt\0' + '4-after', false, true), '4-after\n');
  assert.equal(formatSearchMatchLine('f.txt\0' + '4-after', true, false), 'f.txt-after\n');
  assert.equal(formatSearchMatchLine('--', true, true), undefined);
  assert.equal(formatSearchMatchBlock('src/deep/file.rs', [
    { lineNumber: 3, isMatch: true, content: 'line 3 needle' },
    { lineNumber: 4, isMatch: false, content: 'line 4 context' },
  ]), 'src/deep/file.rs:3:line 3 needle\nsrc/deep/file.rs-4-line 4 context\n');
});

test('RTK search stream preserves warnings and reports its cap once', () => {
  const input = 'engine warning\n' + row('(standard input)', 1, 'first') + row('(standard input)', 2, 'second') + row('(standard input)', 3, 'third') + '--\nlate warning\n';
  assert.equal(renderSearchStream(input, { showFile: false, showLine: true, maxResults: 1 }),
    'engine warning\n1:first\n[rtk] output capped at 1 results\nlate warning\n');
  assert.equal(renderSearchStream('--\n' + row('f', 1, 'hit'), { showFile: true, showLine: false, maxResults: 2 }), '--\nf:hit\n');
  assert.equal(renderSearchStream(input, { ...options, maxResults: -1 }), input);
});

test('RTK search folds whole shared directories in original order', () => {
  assert.equal(foldSearchPathPrefix('/home/u/proj/src/a/foo.rs\n/home/u/proj/src/a/bar.rs\n/home/u/proj/src/b/baz.rs\n'), '/home/u/proj/src/ (3 files)\na/foo.rs\na/bar.rs\nb/baz.rs\n');
  assert.equal(foldSearchPathPrefix('src/z.rs\nsrc/a.rs\n'), 'src/ (2 files)\nz.rs\na.rs\n');
  assert.equal(foldSearchPathPrefix('/a/foobar/x\n/a/foobaz/y\n'), '/a/ (2 files)\nfoobar/x\nfoobaz/y\n');
  assert.equal(foldSearchPathPrefix('/a/b/c.rs\n/a/b/d/e.rs\n'), '/a/b/ (2 files)\nc.rs\nd/e.rs\n');
  for (const input of ['', '/a/b/c.rs\n', 'a.rs\nb.rs\n', '/x/a.rs\n/y/b.rs\n', 'src/a.rs\nlib/b.rs\n', '/a/b.rs\n\n/a/c.rs\n', '/a/b.rs\0/a/c.rs\0', '/a/x\r\n/a/y\n', '\x1b]8;;file:///a/x\x1b\\/a/x\n/a/y\n', 'C:\\src\\a\nC:\\src\\b\n']) {
    assert.equal(foldSearchPathPrefix(input), undefined);
  }
  const raw = '/p/q/a.rs\n/p/q/r/b.rs\n/p/q/c.rs\n';
  const [header, ...tails] = foldSearchPathPrefix(raw)!.trimEnd().split('\n');
  assert.equal(tails.map(tail => header.replace(' (3 files)', '') + tail + '\n').join(''), raw);
});

test('RTK search cleans long content around its pattern without splitting Unicode', () => {
  assert.equal(cleanSearchLine('            const result = someFunction();', 50, 'result'), 'const result = someFunction();');
  assert.equal(cleanSearchLine('0123456789 NEEDLE abcdefghijklmnopqrstuvwxyz', 12, 'needle'), '...789 NEEDLE a...');
  assert.equal(cleanSearchLine('abcdefghijklmnop', 8, 'missing'), 'abcde...');
  assert.equal(cleanSearchLine('prefix NEEDLE', 10, 'needle', /NEEDLE/), 'NEEDLE');
  assert.equal(cleanSearchLine('🎉🎊🎈🎁🎂🎄 some text 🎃🎆🎇✨', 15, 'text'), '... some text 🎃🎆🎇✨');
  assert.ok(cleanSearchLine('  สวัสดีครับ นี่คือข้อความที่ยาวมากสำหรับทดสอบ  ', 20, 'ครับ'));
  assert.equal(cleanSearchLine('unchanged', 2, 'x'), 'unchanged');
  assert.equal(compactSearchPath('/a/very-long-directory-name/another-very-long-directory-name/src/f.ts'), '/.../src/f.ts');
  assert.equal(compactSearchPath('x'.repeat(60)), 'x'.repeat(60));
});

test('RTK search keeps the faithful baseline when uncapped or when a summary would grow it', () => {
  const input = row('z.rs', 2, '  hit  ') + '--\n' + row('a.rs', 4, '  after  ', false);
  assert.equal(renderSearchOutput(input, options), 'z.rs:2:  hit  \n--\na.rs-4-  after  \n');
  assert.equal(renderSearchOutput(input, { ...options, showFile: false, showLine: false }), '  hit  \n--\n  after  \n');
  assert.equal(renderSearchOutput(row('f', 1, 'a') + row('f', 2, 'b'), { ...options, maxPerFile: 1 }), 'f:1:a\nf:2:b\n');
  assert.equal(renderSearchOutput('', options), '');
});

test('RTK search groups capped results, context gaps, and skipped-file counts', () => {
  const text = 'hit ' + 'x'.repeat(120);
  const input = row('z.rs', 1, text) + row('a.rs', 1, text) + row('a.rs', 2, text, false) + row('a.rs', 5, text) + row('a.rs', 6, text) + row('a.rs', 7, text);
  assert.equal(renderSearchOutput(input, { ...options, maxResults: 3, maxPerFile: 3, maxLineLength: 20, context: true }),
    '5 matches in 2 files:\n\na.rs:1:hit xxxxxxxxxxxxxxxx...\na.rs-2-hit xxxxxxxxxxxxxxxx...\n--\na.rs:5:hit xxxxxxxxxxxxxxxx...\n  +2 more in a.rs\n+1 more files\n');
});

test('RTK search context-only extraction uses the supplied literal pattern', () => {
  const input = row('f', 1, 'prefix '.repeat(40) + 'n.e+d suffix') + row('f', 2, 'other '.repeat(40));
  const output = renderSearchOutput(input, { ...options, pattern: 'n.e+d', contextOnly: true, maxPerFile: 1, maxLineLength: 60 });
  assert.ok(output.includes('1:refix prefix prefix n.e+d suffix\n'));
  assert.ok(output.includes('  +1 more in f\n'));
});

test('RTK search preserves all input on ambiguous rows or invalid supplied limits', () => {
  for (const input of ['file.rs:1:content\n', row('f', 1, 'hit') + 'Binary file foo matches\n', row('f', 1, 'hit') + 'engine warning\n']) {
    assert.equal(renderSearchOutput(input, options), input);
  }
  const input = row('f', 1, 'hit');
  for (const invalid of [{ maxResults: NaN }, { maxPerFile: -1 }, { maxLineLength: 2 }]) {
    assert.equal(renderSearchOutput(input, { ...options, ...invalid }), input);
  }
});
