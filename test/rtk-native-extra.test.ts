// SPDX-License-Identifier: Apache-2.0
// Synthetic fixtures for the pinned RTK native text contracts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFilters } from '../src/vendor/rtk-native.ts';
const cases: [string,string,string][] = [
 ['sbt-compile','[info] welcome to sbt 1.9\n[info] Compiling 3 Scala sources\n[success] Total time: 2 s\n','sbt compile: 3 sources (2s)'],
 ['sbt-test','[info] Tests: succeeded 8, failed 0, canceled 0, ignored 1, pending 0\n[info] Suites: completed 2, aborted 0\n[info] Run completed in 3 seconds\n','sbt test: 8 passed, 1 ignored (2 suites, 3s)'],
 ['sbt-run','[info] welcome to sbt 1.9\n[info] running Main\n[info] hello\n[success] Total time: 2 s\n','hello'],
 ['golangci-v2',JSON.stringify({Issues:[{FromLinter:'errcheck',Text:'unchecked',Pos:{Filename:'/work/pkg/main.go',Line:1,Column:2},SourceLines:['  f()  ']}]}),'golangci-lint: 1 issues in 1 files\nTop linters:\n  errcheck (1x)\n\nTop files:\n  pkg/main.go (1 issues)\n    errcheck (1)\n      → f()'],
 ['phpt','PHP_VERSION : 8.3\nPASS Works [a.phpt]\nSKIP missing [b.phpt]\nNumber of tests : 2\nTime taken : 0.2 seconds\n','phpt: 1 passed, 1 skipped  (2 total, 0.2s)\nPHP 8.3'],
 ['artisan','Environment .....\n│ Laravel Version │ 13.0.0 │\n\n\n','Environment ..\n Laravel Version 13.0.0'],
 ['psql',' id | name\n----+------\n 1 | one\n(1 row)\n','id\tname\n1\tone'],
 ['psql','-[ RECORD 1 ]----\nid | 1\nname | one\n(1 row)\n','[1] id=1 name=one'],
];
for(const [name,input,output] of cases) test(`${name} native contract`,()=>assert.equal(nativeFilters[name]?.(input),output));
test('structured diagnostics reject malformed nested positions',()=>{
 const bad=JSON.stringify({Issues:[{FromLinter:'x',Text:'x',Pos:{Filename:'x'}}]});
 assert.equal(nativeFilters['golangci-v2']?.(bad),bad);
});
