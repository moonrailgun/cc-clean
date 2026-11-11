// SPDX-License-Identifier: Apache-2.0
// Source-derived fixtures for RTK 653efb6ed02bd287d686c50e830dd1009356904f.
import assert from 'node:assert/strict';
import test from 'node:test';
import { systemTextFilters, filterJson, summarizeDependencies } from '../src/vendor/rtk-native-system-text.ts';
import { filterRtkOutput, matchRtkFilter } from '../src/vendor/rtk.ts';

test('ast-grep caps large per-file matches and retains counts and file order', () => {
  const rows = Array.from({length: 60000}, (_, i) => `x.ts:${i + 1}:x`);
  const input = [...rows, 'y.ts:1:y'].join('\n') + '\n';
  const filter = matchRtkFilter(['ast-grep', 'run', '-p', '$A', 'x.ts', 'y.ts']);
  assert.equal(filter, 'native:ast-grep');
  assert.ok(Buffer.byteLength(input) < 1_048_576);
  assert.equal(filterRtkOutput(filter!, input),
    [...rows.slice(0, 10), '  … 59990 more match line(s) in x.ts', 'y.ts:1:y'].join('\n') + '\n');
});

test('black retains the upstream colon-path and count behavior', () => {
  assert.equal(systemTextFilters.black('would reformat: /project/src/a.py\nOh no! 💥 💔 💥\n1 file would be reformatted, 2 files would be left unchanged.\n'), 'Format (black): 1 files need formatting\n1. src/a.py\n\n2 files already formatted\n\n[hint] Run `black .` to format these files');
  assert.equal(systemTextFilters.black('All done! ✨ 🍰 ✨\n3 files left unchanged.\n'), 'Format (black): All files formatted (3 files checked)');
});
test('ls long format parses dates, special bits, sizes, directories first', () => {
  const raw = 'total 10\n-rwsr-xr-x 1 user group 2048 Jan  1 12:00 binary\ndrwxr-xr-x 2 user group 64 Jan  1 2026 src\n-rw-r--r-- 1 user group 12 Jan  1 2026 a file.txt\n';
  assert.equal(systemTextFilters['ls-long'](raw), '755  src/\n4755  binary  2.0K\n644  a file.txt  12B\n');
  assert.equal(systemTextFilters['ls-long'](raw+'malformed\n'), raw+'malformed\n');
});
test('ls cap and noise note are exactly the no-tee upstream rendering', () => {
  assert.equal(systemTextFilters['ls-long']('total 2\ndrwxr-xr-x 2 user group 64 Jan 1 2026 node_modules\n-rw-r--r-- 1 user group 4 Jan 1 2026 a\n'), '644  a  4B\n... (1 filtered)\n');
  assert.equal(systemTextFilters['ls-long-all']('total 2\ndrwxr-xr-x 2 user group 64 Jan 1 2026 node_modules\n'), '755  node_modules/\n');
});
test('environment snapshot grouping retains values and category precedence', () => {
  const raw = 'PATH=/bin:/usr/bin\nNODE_ENV=test\nAWS_REGION=example\nEDITOR=vi\nHOME=/tmp/home\nNOISE=value\n';
  assert.equal(systemTextFilters.env(raw), 'PATH Variables:\n  PATH (2 entries):\n    /bin\n    /usr/bin\n\nLanguage/Runtime:\n  NODE_ENV=test\n\nCloud/Services:\n  AWS_REGION=example\n\nTools:\n  EDITOR=vi\n\nOther:\n  HOME=/tmp/home\n\nTotal: 6 vars (showing 5 relevant)\n');
  assert.equal(systemTextFilters.env('A=one\ncontinuation\n'), 'A=one\ncontinuation\n');
});
test('JSON compact and schema preserve pinned depth, array, key, UTF-8 behavior', () => {
  assert.equal(filterJson('{"z":[1,2,3,4,5,6],"a":{"b":true}}', 3), '{\n  a:\n  {\n    b: true\n  }\n  z:\n  [1, ... +5 more]\n}');
  assert.equal(filterJson('{"a b":"https://example.test","nested":{"x":1},"d":"2020-01-01"}', 1, true), '{"a b":url,d:date?,nested:{x:...}}');
  assert.equal(filterJson(JSON.stringify('界'.repeat(27)), 3), '"'+'界'.repeat(25)+'..."');
  assert.equal(filterJson('malformed', 3), 'malformed');
});
test('dependency summaries retain upstream ordering and caps', () => {
  assert.equal(summarizeDependencies('package', '{"name":"demo","version":"1","dependencies":{"z":"2","a":"1"},"devDependencies":{"test":"3"}}'), '  demo @ 1\n  Dependencies (2):\n    a (1)\n    z (2)\n  Dev Dependencies (1):\n    test\n');
  assert.equal(summarizeDependencies('cargo', '[package]\nname = "demo"\n[dependencies]\nserde = { version = "1", features = ["derive"] }\n[dev-dependencies]\npretty = "2"\n'), '  Dependencies (1):\n    serde (1)\n  Dev (1):\n    pretty (2)\n');
  assert.equal(summarizeDependencies('requirements', '# deps\nrequests>=2\nattrs==1\n'), '  Packages (2):\n    requests>=2\n    attrs==1\n');
  assert.equal(summarizeDependencies('pyproject', '[project]\ndependencies = [\n  "requests>=2",\n  "attrs",\n]\n'), '  Dependencies (2):\n    requests>=2\n    attrs\n');
  assert.equal(summarizeDependencies('gomod', 'module example.test/project\ngo 1.24\nrequire (\nexample.test/pkg v1.0.0 // indirect\n)\n'), '  example.test/project (go 1.24)\n  Dependencies (1):\n    example.test/pkg v1.0.0\n');
});
test('standalone helpers never summarize malformed dependency payloads', () => {
  for (const kind of ['cargo','package','requirements','pyproject','gomod'] as const) assert.equal(summarizeDependencies(kind, 'unknown output\n  keep spacing\n'), 'unknown output\n  keep spacing\n');
  for (const f of Object.values(systemTextFilters)) for (const raw of ['', 'unknown output\n', '{"unrelated":true}']) assert.equal(f(raw),raw);
});
