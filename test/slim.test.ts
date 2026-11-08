import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRtkOutput } from '../src/vendor/rtk.ts';

const matches = Array.from({length: 40}, (_, i) => `src/very-long-directory-name/example.ts:${i + 1}:matching source line ${i}`).join('\n');

test('RTK ports cap groups and preserve failures, warnings, controls and unknown output', () => {
  const paths = Array.from({length: 40}, (_, i) => `src/very-long-directory-name/file-${i}.ts`).join('\n');
  assert.match(filterRtkOutput('find', paths), /40 files.*\n[\s\S]*\+30/);
  assert.equal(filterRtkOutput('find', paths + '\nfind: Permission denied'), paths + '\nfind: Permission denied');
  const cargo = Array.from({length: 20}, (_, i) => `test test_${i} ... ok`).join('\n') + '\ntest result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s\n';
  assert.match(filterRtkOutput('cargo-test', cargo), /^cargo test: 20 passed/);
  const pytest = '================ test session starts ================\nplatform darwin -- Python 3.12\ncollected 20 items\ntests/test_example.py .................... [100%]\n================ 20 passed in 0.02s ================\n';
  assert.equal(filterRtkOutput('pytest', pytest), 'Pytest: 20 passed in 0.02s');
  for (const [filter, original] of [['cargo-test', cargo], ['pytest', pytest], ['grep', matches]] as const) {
    for (const text of [original + '\nwarning: details', original + '\nerror: details', '\x1b[32m' + original, original + '\r']) assert.equal(filterRtkOutput(filter, text), text);
  }
  assert.equal(filterRtkOutput('cargo-test', cargo.replace('0 failed', '1 failed')), cargo.replace('0 failed', '1 failed'));
  assert.equal(filterRtkOutput('grep', 'a.ts:1:short'), 'a.ts:1:short');
});
