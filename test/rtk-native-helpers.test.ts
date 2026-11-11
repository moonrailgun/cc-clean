// SPDX-License-Identifier: Apache-2.0
// Source-derived cases from RTK 0.49.0 at 653efb6ed02bd287d686c50e830dd1009356904f.
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSource, smartTruncate, analyzeCode, summarizeOutput, filterUvRun, summarizeWgetStdout, wgetError, applyLineWindow, formatWithLineNumbers, filterGenericLint, filterPhpOutput, filterCurlOutput, curlError } from '../src/vendor/rtk-native-helpers.ts';

test('minimal source filtering retains docs, inline text and Python triple strings',()=>{
  assert.equal(filterSource('// comment\n/// docs\nfn foo() { // inline\n}\n','Rust','minimal'),'/// docs\nfn foo() { // inline\n}');
  const py='# comment\nQUERY = """\n# data\n\'\'\'literal\n"""\nvalue = f"{obj["key"]}" # """\n# drop\n';
  assert.equal(filterSource(py,'Python','minimal'),'QUERY = """\n# data\n\'\'\'literal\n"""\nvalue = f"{obj["key"]}" # """');
  assert.equal(filterSource('/* comment */\n/** docs */\nconst x = "src/*.rs";\n','JavaScript','minimal'),'/** docs */\nconst x = "src/*.rs";');
  assert.equal(filterSource('# only comment\n','Python','minimal'),'# only comment\n');
});

test('aggressive filtering and smart truncation keep source algorithm boundaries',()=>{
  assert.equal(filterSource('use foo::Bar;\nfn foo() {\n  work();\n}\nconst N: i32 = 1;','Rust','aggressive'),'use foo::Bar;\nfn foo() {\n    // ... implementation\nconst N: i32 = 1;');
  assert.equal(filterSource('{"keep": true}\n','Data','aggressive'),'{"keep": true}');
  assert.equal(filterSource('a\n','Unknown','none'),'a\n');
  assert.equal(smartTruncate('a\nb\nc\nd\ne\nf',4),'a\nb\n[4 more lines]');
  assert.equal(smartTruncate('a\nb',0),'');
});

test('code analysis follows language-specific component and import detection',()=>{
  const code='use std::fs;\nuse anyhow::Result;\npub struct Config {}\npub async fn load() -> Result<()> { await x; }\n';
  assert.equal(analyzeCode(code,'Rust'),'Rust module (1 fn, 1 struct) - 4 lines\nuses: anyhow | patterns: async, error handling');
  assert.equal(analyzeCode('def test_example(): pass\ndef main(): pass\ndef load(): pass\n','Python'),'Python functions (1 fn) - 3 lines\ndefines: load');
  assert.equal(analyzeCode('interface A {}\ninterface B {}','TypeScript'),'TypeScript data structures (2 struct, 2 trait) - 2 lines\nGeneral purpose code file');
});

test('explicit summaries preserve pinned type precedence, counts, and status',()=>{
  assert.equal(summarizeOutput('2 passed; 0 failed; 1 ignored\n','test',true),'[ok] Command: test\n   1 lines of output\n\nTest Results:\n   [ok] 2 passed\n   skip 1 skipped');
  assert.equal(summarizeOutput('Compiling app\nwarning: unused\n','build',false),'[FAIL] Command: build\n   2 lines of output\n\nBuild Summary:\n   1 crates/files compiled\n   [warn] 1 warnings');
  assert.equal(summarizeOutput('{"z":1,"a":2}','show',true),'[ok] Command: show\n   1 lines of output\n\nJSON Output:\n   Object with 2 keys:\n   • a\n   • z');
  assert.match(summarizeOutput('a\nb\n','show',true),/List \(2 items\):\n   • a\n   • b$/);
});

test('uv accepts explicit stream/status context and preserves failure traceback tail',()=>{
  assert.equal(filterUvRun('unused','result\n','INFO: done\n',0),'result\nINFO: done');
  assert.equal(filterUvRun('','','',0),'ok');
  const trace='noise\nTraceback (most recent call last):\n  File "a.py", line 2, in <module>\n    call()\n  File "b.py", line 3, in call\n    raise ValueError("bad")\nValueError: bad\n';
  assert.equal(filterUvRun(trace,'','',1),'Traceback (most recent call last):\nFile "a.py", line 2, in <module>\nFile "b.py", line 3, in call\nraise ValueError("bad")\nValueError: bad');
  const stdout=Array.from({length:52},(_,i)=>`row ${i}`).join('\n');
  const result=filterUvRun(stdout,stdout,'',0);
  assert.match(result,/row 24\n\.\.\. \(2 lines omitted\)\nrow 27/);
  assert.ok(result.endsWith('row 51'));
});

test('wget explicit stdout summary applies source 20-line threshold and byte guard',()=>{
  assert.equal(summarizeWgetStdout('hi\n','https://example.test'),'hi\n');
  const input=Array.from({length:21},(_,i)=>`row ${i} ${'x'.repeat(100)}`).join('\n');
  const out=summarizeWgetStdout(input,'https://example.test/file');
  assert.match(out,/^example\.test\/file ok \| 21 lines \| /);
  assert.ok(out.endsWith('... +11 more lines'));
  assert.equal(wgetError('ERROR 404: not found',''),'404 Not Found');
  assert.equal(wgetError('-- connecting\ncustom error\n',''),'custom error');
});
test('explicit read windows preserve CRLF and final line termination',()=>{
  assert.equal(applyLineWindow('a\r\nb\nc\r\n',0,2,1),'a\r\nb\n');
  assert.equal(applyLineWindow('a\r\nb\nc\r\n',undefined,undefined,2),'b\nc\r\n');
  assert.equal(applyLineWindow('a\nb\nc',undefined,undefined,1),'c');
  assert.equal(applyLineWindow('\n\n\n',undefined,undefined,2),'\n\n');
  assert.equal(applyLineWindow('a\nb',undefined,0),'');
  assert.equal(formatWithLineNumbers('a\r\nb\n'),'1\ta\n2\tb\n');
  assert.equal(formatWithLineNumbers(''),'');
});
test('explicit generic lint, PHP and curl helpers retain pinned no-tee behavior',()=>{
  assert.equal(filterGenericLint('error and warning\n0 errors\n'),'Lint: 1 errors, 1 warnings\nerror and warning\nerror and warning');
  assert.equal(filterGenericLint('ok\n'),'Lint: No issues found');
  assert.equal(filterPhpOutput('\u001b[32m  hello\u001b[0m\n'),'hello');
  assert.equal(filterPhpOutput(' \n'),'ok');
  assert.equal(filterCurlOutput('  {"ok":true}\n'),'{"ok":true}');
  assert.equal(curlError('  connection failed\n','body'),'FAILED: curl connection failed');
});
