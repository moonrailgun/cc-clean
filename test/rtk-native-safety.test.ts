// SPDX-License-Identifier: Apache-2.0
// Conservative historical-output regressions against RTK 653efb6ed02bd287d686c50e830dd1009356904f.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFilters, filterJson } from '../src/vendor/rtk-native.ts';

test('ESLint rejects contradictory aggregate counts and invalid severity', () => {
  const entry={filePath:'/src/bad.ts',errorCount:0,warningCount:0,messages:[{ruleId:'no-undef',severity:2,message:'missing is not defined',line:1,column:1}]};
  for(const value of [entry,{...entry,errorCount:1,messages:[{...entry.messages[0],severity:3}]}]) {
    const raw=JSON.stringify([value]); assert.equal(nativeFilters.eslint(raw),raw);
  }
});
test('Playwright retains flaky reports and malformed suite aggregates', () => {
  for(const value of [
    {stats:{expected:0,unexpected:0,skipped:0,flaky:1,duration:100},suites:[]},
    {stats:{expected:4,unexpected:0,skipped:0,duration:100}},
  ]) {const raw=JSON.stringify(value);assert.equal(nativeFilters.playwright(raw),raw);}
  const text='Running 2 tests using 1 worker\n  1 flaky\n  1 passed (2s)\n';
  assert.equal(nativeFilters.playwright(text),text);
});
test('Cargo refuses unrecognized tails, partial installs and unknown JSON events', () => {
  for(const name of ['cargo-build','cargo-check','cargo-clippy']) {
    for(const raw of ['    Checking demo v1.0\n    Finished dev target(s) in 1s\nUNEXPECTED IMPORTANT OUTPUT\n', '{"reason":"unknown-event"}\n{"reason":"build-finished","success":true}\n', '{"reason":"build-finished","success":true}\nUNEXPECTED IMPORTANT OUTPUT\n']) assert.equal(nativeFilters[name](raw),raw,name);
  }
  const partial='  Installing tool v1.0\n   Compiling dependency v1.0\n';
  assert.equal(nativeFilters['cargo-install'](partial),partial);
});
test('JSON helpers preserve integers that cannot be represented exactly', () => {
  for(const raw of ['{"id":9007199254740993}','{"value":1e400}','[9007199254740993]']) assert.equal(filterJson(raw),raw);
});
test('wc preserves complete filenames containing whitespace in each column mode', () => {
  const prefix='/long/shared/directory/';
  assert.equal(nativeFilters['wc-single'](`  1 ${prefix}a report.ts\n  2 ${prefix}b report.ts\n  3 total\n`),'1 a report.ts\n2 b report.ts\nΣ 3');
  assert.equal(nativeFilters['wc-full'](`  1 2 3 ${prefix}a report.ts\n  2 3 4 ${prefix}b report.ts\n  3 5 7 total\n`),'1L 2W 3B a report.ts\n2L 3W 4B b report.ts\nΣ 3L 5W 7B');
  const mixed=`  1 3 ${prefix}a report.ts\n  2 4 ${prefix}b report.ts\n  3 7 total\n`;
  assert.equal(nativeFilters['wc-mixed'](mixed),mixed);
  const tabs=`  1 ${prefix}a\treport.ts\n  2 ${prefix}b\treport.ts\n  3 total\n`;
  assert.equal(nativeFilters['wc-single'](tabs),'1 a\treport.ts\n2 b\treport.ts\nΣ 3');
});
