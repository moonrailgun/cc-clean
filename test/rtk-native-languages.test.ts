// SPDX-License-Identifier: Apache-2.0
// Synthetic fixtures derived from pinned RTK command-filter contracts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFilters } from '../src/vendor/rtk-native.ts';
const cases: [string,string,string][] = [
 ['cargo-build', '   Compiling a v1.0\n   Compiling b v1.0\n   Compiling c v1.0\n    Finished dev target(s) in 2s\n', 'cargo build (3 crates compiled)\nFinished dev target(s) in 2s\n'],
 ['cargo-clippy', '    Checking x v1.0\nwarning: needless borrow [clippy::needless_borrow]\n --> src/main.rs:1:1\n    Finished dev target(s) in 1s\n', 'cargo clippy: 0 errors, 1 warnings\n  clippy::needless_borrow (1x)\n    src/main.rs:1:1'],
 ['cargo-install', '    Updating crates.io index\n  Installing ripgrep v14.0\n   Compiling regex v1.0\n   Installed package ripgrep v14.0\n', 'cargo install (ripgrep v14.0, 1 deps compiled)'],
 ['cargo-nextest', 'Starting 3 tests across 1 binary\nPASS [0.1s] a one\nPASS [0.1s] a two\nSummary [ 0.300s] 3 tests run: 2 passed, 1 skipped\n', 'cargo nextest: 2 passed, 1 skipped (1 binary, 0.300s)'],
 ['rake-test', 'Run options: --seed 12345\n# Running:\n........\nFinished in 0.1s\n8 runs, 9 assertions, 0 failures, 0 errors, 0 skips\n', 'ok rake test: 8 runs, 0 failures'],
 ['rspec', 'User\n  works\nFinished in 0.2 seconds\n1 example, 0 failures\n', 'RSpec: 1 example, 0 failures'],
 ['rspec', JSON.stringify({examples:[],summary:{duration:0.125,example_count:8,failure_count:0,pending_count:2}}), '✓ RSpec: 6 passed, 2 pending (0.13s)'],
 ['rubocop', 'Inspecting 2 files\n..\n2 files inspected, no offenses detected\n', 'ok ✓ rubocop (2 files)'],
];
for(const [name,input,output] of cases) test(`${name} source contract`,()=>assert.equal(nativeFilters[name]?.(input),output));
test('cargo nextest discards failures superseded by a passing retry',()=> {
 const input='Starting 1 test across 1 binary\nTRY 1 FAIL [0.1s] (1/2) a one\nold error\nTRY 2 PASS [0.1s] (2/2) a one\nSummary [0.2s] 1 test run: 1 passed\n';
 assert.equal(nativeFilters['cargo-nextest']?.(input),'cargo nextest: 1 passed (1 binary, 0.2s)');
});
