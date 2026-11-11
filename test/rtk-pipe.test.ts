// Synthetic tests for the RTK Apache-2.0 filter port; see third_party/rtk/PIPE.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pipeFilters } from '../src/vendor/rtk-pipe.ts';

const expectedNames = ['cargo-test', 'cargo', 'pytest', 'go-test', 'go-build', 'ctest', 'tsc', 'vitest', 'grep', 'rg', 'find', 'fd', 'git-log', 'git-diff', 'git-status', 'log', 'mypy', 'ruff-check', 'ruff-format', 'sqlfluff-lint', 'prettier', 'phpunit', 'pest', 'paratest', 'php-test', 'ecs', 'phpstan', 'pint'];
const run = (name: string, input: string) => pipeFilters[name]!(input);
const ndjson = (...records: unknown[]) => records.map(value => JSON.stringify(value)).join('\n');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/rtk-pipe/${name}`, import.meta.url), 'utf8');

test('upstream Ruff fixture renders its complete grouped report', () => {
  assert.equal(run('ruff-check', fixture('ruff_check_repeated_raw.json')), 'Ruff: 3 issues in 1 files (1 fixable)\nTop rules:\n  E701 (2x): Multiple statements on one line (colon)\n  F401 (1x): `os` imported but unused\n\nTop files:\n  src/four.py (3 issues)\n    E701 (2)\n    F401 (1)\n\nViolations:\n  src/four.py:1:8 F401\n  src/four.py:3:8 E701\n  src/four.py:4:9 E701\n\n[hint] Run `ruff check --fix` to auto-fix 1 issues');
});

test('upstream pytest traceback keeps innermost location and error head and tail', () => {
  assert.equal(run('pytest', fixture('pytest_deep_assertion_raw.txt')), "Pytest: 0 passed, 1 failed in 0.01s\n\n[FAIL] test_deep\n  test_deep.py:2: in check\n  E   AssertionError: bad status\n  E   assert {'code': 500, 'body': 'err'} == {'code': 200, 'body': 'ok'}\n  ... +3 more error lines\n  E     {'body': 'err'} != {'body': 'ok'}\n  E     Use -v to get more diff");
});

test('upstream inconsistent PHPStan totals are preserved exactly', () => {
  const input = fixture('phpstan_raw.json');
  assert.equal(run('phpstan', input), input);
});

test('upstream SQLFluff v4 fixture renders locations, rules and fixability', () => {
  assert.equal(run('sqlfluff-lint', fixture('sqlfluff_lint_v4_raw.json')), 'SQLFluff: 3 violations in 2 files (2 fixable)\n═══════════════════════════════════════\nTop rules:\n  AM04 (1x, first at models/staging/stg_items.sql:1): Query produces an unknown number of result columns.\n  CP01 (1x, first at models/orders.sql:2): Keywords must be consistently upper case.\n  LT09 (1x, first at models/orders.sql:1): Select targets should be on a new line unless there is only one select target.\n\nTop files:\n  models/orders.sql (2 violations)\n    CP01 (1, line 2)\n    LT09 (1, line 1)\n  models/staging/stg_items.sql (1 violations)\n    AM04 (1, line 1)\n\nViolations:\n  models/orders.sql:1:1 LT09\n  models/orders.sql:2:1 CP01\n  models/staging/stg_items.sql:1:1 AM04\n\n💡 Run `sqlfluff fix` to auto-fix 2 violations');
});

test('grep and find caps report every omitted item', () => {
  assert.ok(run('grep', Array.from({length:12}, (_,i) => `a.ts:${i+1}: match`).join('\n')).endsWith('  +2\n\n'));
  assert.ok(run('find', Array.from({length:12}, (_,i) => `src/file${i}.ts`).join('\n')).endsWith('  +2\n'));
});

test('Vitest validates ordinary snapshot metadata and preserves snapshot failures', () => {
  const value = {numTotalTests:1,numPassedTests:1,numFailedTests:0,testResults:[{name:'a.test.ts',assertionResults:[{fullName:'works',status:'passed',failureMessages:[]}]}],snapshot:{added:0,didUpdate:false,failure:false,filesAdded:0,filesRemoved:0,filesRemovedList:[],filesUnmatched:0,filesUpdated:0,matched:1,total:1,unchecked:0,uncheckedKeysByFile:[],unmatched:0,updated:0}};
  assert.equal(run('vitest', JSON.stringify(value)), 'PASS (1) FAIL (0)');
  value.snapshot.failure = true;
  const failed = JSON.stringify(value);
  assert.equal(run('vitest', failed), failed);
});

test('complete pipe registry and aliases', () => {
  assert.deepEqual(Object.keys(pipeFilters).sort(), expectedNames.sort());
  for (const [alias, name] of [['cargo', 'cargo-test'], ['rg', 'grep'], ['fd', 'find'], ['paratest', 'pest'], ['php-test', 'pest']]) assert.equal(pipeFilters[alias!], pipeFilters[name!]);
});

test('cargo contradictory result status and failure counts are preserved', () => {
  for (const input of ['test result: ok. 20 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n', 'test result: FAILED. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n', 'test result: mystery. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n']) assert.equal(run('cargo',input),input);
});

test('unknown formats and malformed JSON stay byte-for-byte intact', () => {
  for (const name of expectedNames) {
    for (const input of ['unknown diagnostic: cache transaction failed\r\n', '{"unexpected":true}\n', '']) assert.equal(run(name, input), input, name);
  }
  for (const name of ['ruff-check', 'sqlfluff-lint', 'phpstan', 'pint', 'vitest', 'go-test']) {
    for (const input of ['[{}]', '{}', '{broken', 'null', '42']) assert.equal(run(name, input), input, name);
  }
});

test('cargo aggregates suites and durations', () => {
  const input = '   Compiling demo v0.1.0\n    Finished `test` profile\n     Running unittests src/lib.rs\nrunning 2 tests\ntest a ... ok\ntest b ... ok\ntest result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.10s\n\nrunning 1 test\ntest c ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.20s\n';
  assert.equal(run('cargo', input), 'cargo test: 3 passed, 1 ignored, 2 filtered out (2 suites, 0.30s)');
});

test('cargo failure and compiler diagnostics survive', () => {
  const input = "running 1 test\ntest tests::bad ... FAILED\n\nfailures:\n\n---- tests::bad stdout ----\nthread 'tests::bad' panicked at src/lib.rs:4:5:\nassertion failed: expected == actual\n\nfailures:\n    tests::bad\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n";
  assert.match(run('cargo-test', input), /assertion failed: expected == actual/);
  assert.match(run('cargo-test', input), /FAILED/);
  const diagnostic = 'warning: custom driver failed\n' + input;
  assert.ok(run('cargo', diagnostic).includes('warning: custom driver failed'));
});

test('pytest summarizes success, expected failures and real failures', () => {
  assert.equal(run('pytest', '================ test session starts ================\nplatform linux -- Python 3.12.0, pytest-8.0.0\nrootdir: /project\ncollected 2 items\ntest_a.py .. [100%]\n================ 2 passed in 0.12s ================\n'), 'Pytest: 2 passed in 0.12s');
  const input = '=== FAILURES ===\n___ test_bad ___\n> assert value == 2\nE assert 1 == 2\ntests/test_a.py:12: AssertionError\n=== short test summary info ===\nFAILED tests/test_a.py::test_bad - assert 1 == 2\nXFAIL tests/test_a.py::test_old - planned\n=== 1 failed, 1 xfailed in 0.15s ===';
  const output = run('pytest', input);
  assert.match(output, /1 failed/);
  assert.match(output, /1 xfailed/);
  assert.match(output, /tests\/test_a.py:12/);
  assert.match(output, /assert 1 == 2/);
});

test('go-test parses complete NDJSON and retains unrecognized records verbatim', () => {
  const input = ndjson({Action:'start',Package:'example.com/project/pkg'}, {Action:'run',Package:'example.com/project/pkg',Test:'TestA'}, {Action:'pass',Package:'example.com/project/pkg',Test:'TestA'}, {Action:'pass',Package:'example.com/project/pkg'});
  assert.equal(run('go-test', input), 'Go test: 1 passed in 1 packages');
  const raw = '{ "Action": "future-event", "Package": "pkg", "diagnostic": "keep me" }\r\n';
  assert.ok(run('go-test', input + '\n' + raw).endsWith(raw));
  assert.equal(run('go-test', '{"Action":"pass"}'), '{"Action":"pass"}');
});

test('go-test preserves test and build failures and fuzz summaries', () => {
  const failed = ndjson({Action:'output',Package:'example/pkg',Test:'TestBad',Output:'    thing_test.go:8: expected 2, got 1\n'}, {Action:'fail',Package:'example/pkg',Test:'TestBad'}, {Action:'fail',Package:'example/pkg'});
  assert.match(run('go-test', failed), /0 passed, 1 failed/);
  assert.match(run('go-test', failed), /thing_test.go:8: expected 2, got 1/);
  const build = ndjson({Action:'build-output',ImportPath:'example/pkg',Output:'pkg/a.go:7: undefined: value\n'}, {Action:'build-fail',ImportPath:'example/pkg'}, {Action:'fail',Package:'example/pkg',FailedBuild:'example/pkg'});
  assert.match(run('go-test', build), /build failed/);
  assert.match(run('go-test', build), /undefined: value/);
  const orphan = ndjson({Action:'build-output',ImportPath:'example/pkg',Output:'pkg/a.go:7: undefined: value\n'});
  assert.equal(run('go-test', orphan), orphan);
  const fuzz = ndjson({Action:'output',Package:'example/pkg',Output:'fuzz: elapsed: 1s, execs: 100\n'},{Action:'pass',Package:'example/pkg',Test:'FuzzA'},{Action:'pass',Package:'example/pkg'});
  assert.match(run('go-test', fuzz), /fuzz: elapsed/);
});

test('go-build summarizes compiler errors without swallowing extra diagnostics', () => {
  assert.equal(run('go-build', '# example/pkg\n./main.go:3:2: undefined: missing\n'), 'Go build: 1 errors\n1. ./main.go:3:2: undefined: missing');
  const input = 'go: downloading example/pkg v1.0.0\ncustom proxy diagnostic\n';
  assert.equal(run('go-build', input), input);
});

test('ctest summarizes timings, disabled tests and failure context', () => {
  const input = 'Test project /tmp/build\n    Start 1: unit\n1/2 Test #1: unit ........ Passed 0.10 sec\n    Start 2: disabled\n2/2 Test #2: disabled .... ***Not Run (Disabled) 0.00 sec\n100% tests passed, 0 tests failed out of 2\nTotal Test time (real) = 0.10 sec\n';
  assert.match(run('ctest', input), /^ctest: 2\/2 passed, 1 disabled \(0.10 sec\)/);
  assert.match(run('ctest', input), /slowest:\n  unit 0.10 sec/);
  const failure = 'Test project /tmp/build\n    Start 1: unit\n1/1 Test #1: unit ........ ***Failed 0.01 sec\nassertion mismatch at tests/main.cpp:42\n0% tests passed, 1 tests failed out of 1\nTotal Test time (real) = 0.01 sec\nThe following tests FAILED:\n\t1 - unit (Failed)\nErrors while running CTest\n';
  assert.match(run('ctest', failure), /assertion mismatch at tests\/main.cpp:42/);
  assert.match(run('ctest', failure), /Errors while running CTest/);
  assert.equal(run('ctest', 'No tests were found!!!\nCMake Error: missing config\n'), 'ctest: no tests found\nCMake Error: missing config');
});

test('tsc groups errors and keeps global and related diagnostic lines', () => {
  const input = 'src/a.ts(2,3): error TS2322: Type string is not assignable.\n  Related declaration here.\nsrc/a.ts(4,5): error TS2345: Argument mismatch.\nerror TS18003: No inputs were found.\nFound 3 errors.\n';
  const output = run('tsc', input);
  assert.match(output, /^TypeScript: 3 errors in 1 files/);
  assert.match(output, /L2: TS2322: Type string/);
  assert.match(output, /Related declaration here/);
  assert.match(output, /TS18003: No inputs/);
  assert.equal(run('tsc', 'Found 0 errors. Watching for file changes.\n'), 'TypeScript: No errors found');
});

test('vitest validates JSON and renders failures or ordinary text totals', () => {
  const input = JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:1,numPendingTests:0,testResults:[{name:'test/a.test.ts',assertionResults:[{fullName:'works',status:'passed',failureMessages:[]},{fullName:'fails',status:'failed',failureMessages:['Expected 2, got 1\n at a.test.ts:4']}]}]});
  assert.match(run('vitest', input), /^PASS \(1\) FAIL \(1\)/);
  assert.match(run('vitest', input), /Expected 2, got 1/);
  assert.equal(run('vitest', ' RUN v2.1.0 /project\n ✓ test/a.test.ts (2 tests) 3ms\n Test Files 1 passed (1)\n Tests 2 passed (2)\n Duration 0.20s\n'), 'PASS (2) FAIL (0)\nTime: 200ms');
});

test('grep groups matches, find groups paths and both preserve diagnostic lines', () => {
  assert.match(run('rg', 'b.ts:4: second\na.ts:2: first\na.ts:3: third\n'), /^3 matches in 2F:/);
  assert.match(run('grep', 'a.ts:2: x:y\n'), /x:y/);
  assert.match(run('fd', 'src/a.ts\nsrc/b.ts\ntest/a.ts\n'), /^3 files in 2 dirs/);
  for (const name of ['grep', 'find']) {
    const input = name === 'grep' ? 'a.ts:2: first\nrg: secret: Permission denied\n' : 'src/a.ts\nfind: secret: Permission denied\n';
    assert.equal(run(name, input), input);
  }
});

test('git-log only parses the RTK marker format', () => {
  const input = 'abc1234 fix build (2026-01-01) <A>\n\nfirst detail\nsecond detail\nthird detail\nfourth detail\nSigned-off-by: A\n---END---\ndef5678 add test (2026-01-02) <B>\n---END---\n';
  assert.equal(run('git-log', input), 'abc1234 fix build (2026-01-01) <A>\n  first detail\n  second detail\n  third detail\n  [+1 lines omitted]\ndef5678 add test (2026-01-02) <B>');
  const ordinary = 'commit abc123456789\nAuthor: A <a@example.com>\nDate: today\n\n    subject\n';
  assert.equal(run('git-log', ordinary), ordinary);
});

test('git-diff preserves changed lines, hunk context, binary and rename metadata', () => {
  const input = 'diff --git a/src/a.ts b/src/a.ts\nindex 1234567..2345678 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@ function a\n unchanged\n-old\n+new\n';
  const output = run('git-diff', input);
  assert.match(output, /src\/a.ts/);
  assert.match(output, /@@ -1,2 \+1,2 @@ function a/);
  assert.match(output, /-old\n\+new/);
  assert.match(output, /\+1 -1/);
  const binary = 'diff --git a/a.png b/a.png\nindex 1234567..2345678 100644\nBinary files a/a.png and b/a.png differ\n';
  assert.ok(run('git-diff', binary).includes('Binary files a/a.png and b/a.png differ'));
  const rename = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
  assert.ok(run('git-diff', rename).includes('rename from old.ts'));
});

test('git-status parses porcelain and leaves ordinary status intact', () => {
  assert.equal(run('git-status', '## main...origin/main\n M src/a.ts\n?? new.ts\n'), '* main...origin/main\n M src/a.ts\n?? new.ts');
  assert.equal(run('git-status', '## main\n'), '* main\nclean — nothing to commit');
  const ordinary = 'On branch main\nYou are currently rebasing.\n';
  assert.equal(run('git-status', ordinary), ordinary);
});

test('log counts repeated normalized messages without discarding unrecognized lines', () => {
  const input = '2026-01-01 12:00:00 ERROR worker 12345 failed\n2026-01-01 12:00:01 ERROR worker 67890 failed\nINFO started\nWARN retrying\n';
  const output = run('log', input);
  assert.match(output, /2 errors \(1 unique\)/);
  assert.match(output, /\[×2\]/);
  assert.match(output, /1 info messages/);
  const extra = input + '    at bootstrap (a.ts:7)\n';
  assert.ok(run('log', extra).includes('at bootstrap (a.ts:7)'));
});

test('mypy preserves notes, locations, error codes and fileless failures', () => {
  const input = 'src/a.py:8: error: Incompatible types [assignment]\nsrc/a.py:8: note: expected int\nsrc/b.py:3: error: Missing import [import-not-found]\nFound 2 errors in 2 files (checked 4 source files)\n';
  const output = run('mypy', input);
  assert.match(output, /^mypy: 2 errors in 2 files/);
  assert.match(output, /L8: \[assignment\] Incompatible types/);
  assert.match(output, /expected int/);
  assert.equal(run('mypy', 'Success: no issues found in 5 source files\n'), 'mypy: No issues found');
});

test('ruff JSON groups rules and preserves differing messages and fix counts', () => {
  const input = JSON.stringify([{code:'F401',message:'unused import os',filename:'/project/src/a.py',location:{row:1,column:1},fix:{applicability:'safe'}},{code:'F401',message:'unused import sys',filename:'/project/src/a.py',location:{row:2,column:1},fix:null}]);
  const output = run('ruff-check', input);
  assert.match(output, /^Ruff: 2 issues in 1 files \(1 fixable\)/);
  assert.match(output, /src\/a.py:1:1 F401 unused import os/);
  assert.match(output, /src\/a.py:2:1 F401 unused import sys/);
  assert.equal(run('ruff-check', '[]'), 'Ruff: No issues found');
});

test('ruff-format handles check mode and unknown diagnostics', () => {
  assert.match(run('ruff-format', 'Would reformat: src/a.py\n1 file would be reformatted, 3 files left unchanged\n'), /^Ruff format: 1 files need formatting\n1. a.py/);
  assert.equal(run('ruff-format', '3 files left unchanged\n'), 'Ruff format: All files formatted correctly');
  const input = '3 files left unchanged\nerror: cannot read bad.py\n';
  assert.equal(run('ruff-format', input), input);
});

test('SQLFluff supports old/new locations and known/unknown fixes', () => {
  const input = JSON.stringify([{filepath:'/project/models/a.sql',violations:[{code:'LT01',description:'Spacing',start_line_no:3,start_line_pos:5,fixes:[{type:'replace'}]},{code:'RF01',description:'Unknown x',line_no:8,line_pos:2,fixes:[]}]},{filepath:'models/clean.sql',violations:[]}]);
  const output = run('sqlfluff-lint', input);
  assert.match(output, /^SQLFluff: 2 violations in 1 files \(1 fixable\)/);
  assert.match(output, /models\/a.sql:3:5 LT01/);
  assert.match(output, /models\/a.sql:8:2 RF01/);
  assert.equal(run('sqlfluff-lint', '[]'), '✓ SQLFluff: No violations found');
});

test('SQLFluff malformed or unknown nested fixes preserve original JSON', () => {
  for (const fix of [null,7,'replace',{}, {type:7},{type:'unknown'},{type:'replace',edit:7},{type:'delete',start_line_no:-1},{type:'replace',fatal:'unknown diagnostic'}]) {
    const input = JSON.stringify([{filepath:'models/a.sql',violations:[{code:'LT01',description:'Spacing',fixes:[fix]}]}],null,2) + '\n';
    assert.equal(run('sqlfluff-lint',input),input);
  }
});

test('Prettier check output and diagnostics', () => {
  assert.equal(run('prettier', 'Checking formatting...\nsrc/a.ts\nsrc/b.ts\n[warn] Code style issues found in 2 files. Run Prettier with --write to fix.\n'), 'Prettier: 2 files need formatting\n1. src/a.ts\n2. src/b.ts');
  assert.equal(run('prettier', 'Checking formatting...\nAll matched files use Prettier code style!\n'), 'Prettier: All files formatted correctly');
  const input = 'Checking formatting...\n[error] src/a.ts: SyntaxError: Missing semicolon.\n';
  assert.equal(run('prettier', input), input);
});

test('PHPUnit summarizes success and keeps failure locations', () => {
  assert.equal(run('phpunit', 'PHPUnit 11.0.0\nRuntime: PHP 8.3\n.. 2 / 2 (100%)\nTime: 00:00.012, Memory: 8.00 MB\nOK (2 tests, 3 assertions)\n'), 'PHPUnit: OK (2 tests, 3 assertions)');
  const input = 'PHPUnit 11.0.0\nThere was 1 failure:\n1) DemoTest::bad\nFailed asserting that 1 matches expected 2.\n/tests/DemoTest.php:12\nFAILURES!\nTests: 1, Assertions: 1, Failures: 1.\n';
  const output = run('phpunit', input);
  assert.match(output, /1 tests, 1 assertions, 1 failures/);
  assert.match(output, /DemoTest.php:12/);
});

test('Pest/ParaTest remove only recognized runner framing', () => {
  const input = 'Pest 3.0.0\nRuntime: PHP 8.3\nConfiguration: phpunit.xml\n.... 4 / 4 (100%)\n  PASS Tests\\Unit\\ExampleTest\n  Tests: 4 passed (4 assertions)\n';
  assert.equal(run('pest', input), 'PASS Tests\\Unit\\ExampleTest\nTests: 4 passed (4 assertions)');
  const input2 = input + 'custom extension failed\n';
  assert.ok(run('pest', input2).includes('custom extension failed'));
});

test('ECS preserves issue details and recognizes clean output', () => {
  assert.equal(run('ecs', '  [OK] No errors found\n'), '✓ ecs: no issues');
  const input = 'src/Foo.php\n  ERROR invalid spacing\n  custom fixer explanation\n2 files checked\n';
  assert.ok(run('ecs', input).includes('custom fixer explanation'));
});

test('PHPStan JSON groups messages and plain text keeps error detail', () => {
  const input = JSON.stringify({totals:{errors:1,file_errors:2},files:{'/project/src/a.php':{errors:2,messages:[{message:'Undefined variable $x',line:7,ignorable:true},{message:'Bad return type',line:9,ignorable:false}]}},errors:['Invalid bootstrap configuration']});
  const output = run('phpstan', input);
  assert.match(output, /Undefined variable \$x/);
  assert.match(output, /Invalid bootstrap configuration/);
  assert.match(output, /a.php:|L7:/);
  assert.equal(run('phpstan', JSON.stringify({totals:{errors:0,file_errors:0},files:{},errors:[]})), 'phpstan: ok');
  const text = ' ------ -----------------------\n Line a.php\n ------ -----------------------\n 7 Undefined variable $x.\n ------ -----------------------\n [ERROR] Found 1 error\n';
  assert.ok(run('phpstan', text).includes('Undefined variable $x'));
});

test('Pint JSON supports aliases and preserves reported rules', () => {
  const input = JSON.stringify({files:[{name:'app/Foo.php',appliedFixers:['single_quote','binary_operator_spaces']},{path:'app/Bar.php',fixers:['no_unused_imports']}]});
  const output = run('pint', input);
  assert.match(output, /^pint: 3 changes in 2 files/);
  assert.match(output, /single_quote/);
  assert.match(output, /no_unused_imports/);
  assert.equal(run('pint', '{"files":[]}'), 'pint: ok');
});

test('structured filters reject unknown fields, wrong types and inconsistent counts', () => {
  const cases: [string, unknown][] = [
    ['ruff-check', [{code:'X',message:'msg',filename:'a.py',location:{row:'1',column:1}}]],
    ['ruff-check', [{code:'X',message:'msg',filename:'a.py',location:{row:1,column:1},diagnostics:['important']}]],
    ['sqlfluff-lint', [{filepath:'a.sql',violations:[],fatal:'failed'}]],
    ['phpstan', {totals:{errors:0,file_errors:0},files:{'a.php':{errors:1,messages:[{message:'bad',line:1}]}},errors:[]}],
    ['pint', {files:[],error:'crashed'}],
    ['vitest', {numTotalTests:0,numPassedTests:0,numFailedTests:0,testResults:[],unhandledErrors:['crashed']}],
  ];
  for (const [name, value] of cases) {
    const input = JSON.stringify(value);
    assert.equal(run(name, input), input, name);
  }
});
