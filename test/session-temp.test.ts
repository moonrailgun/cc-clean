import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTempCollector, temporaryOutput, tempPathAliases, discoverSessionTemps, verifySessionTempEvidence, validSessionTempEvidence } from '../src/session-temp.ts';
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSystemTemp, verifySystemTempParents } from '../src/system-temp.ts';

const time = '2026-11-01T10:00:00.000Z';
let nextCall = 0;
function command(command: string, output: string, exit = 0) {
  return {timestamp: time, type: 'event_msg', payload: {type: 'item_completed', item: {
    type: 'CommandExecution', id: `exec-${++nextCall}`, command: ['/bin/zsh', '-lc', command], status: 'completed', exit_code: exit, aggregated_output: output,
  }}};
}
test('creation evidence requires a successful tool execution, not a path mention', () => {
  const c = sessionTempCollector('codex');
  c.record({type: 'response_item', payload: {type: 'message', content: '/tmp/test-abc123/report.md'}});
  c.record(command('cat /tmp/test-abc123/report.md', '/tmp/test-abc123'));
  c.record(command('mktemp -d /tmp/test-XXXXXX', '/tmp/test-abc123', 1));
  assert.deepEqual(c.creations, []);
  c.record(command('mktemp -d /tmp/test-XXXXXX', '/tmp/test-abc123\n'));
  assert.equal(c.creations.length, 1);
  assert.equal(c.creations[0].path, '/tmp/test-abc123');
  assert.equal(c.creations[0].kind, 'directory');
});
test('temporary directory output resolves historical variables and Python mkdtemp', () => {
  for (const variable of ['$TMPDIR', '${TMPDIR}', '$TMP', '${TEMP}', '$CLAUDE_CODE_TMPDIR']) {
    const c = sessionTempCollector('codex');
    c.record(command(`mktemp -d "${variable}/test-XXXXXX"`, '/private/var/folders/ab/user/T/test-abc123\n'));
    assert.equal(c.creations[0]?.path, '/private/var/folders/ab/user/T/test-abc123');
  }
  const c = sessionTempCollector('codex');
  c.record(command("python3 - <<'PY'\nimport tempfile, pathlib\np = pathlib.Path(tempfile.mkdtemp(prefix='cc-clean-image-writeback-'))\nprint(p)\nPY", '/var/folders/0l/user/T/cc-clean-image-writeback-v52fjua0\n'));
  assert.equal(c.creations[0]?.path, '/var/folders/0l/user/T/cc-clean-image-writeback-v52fjua0');
  for (const cmd of ["cat <<'PY'\np = tempfile.mkdtemp(prefix='test-')\nprint(p)\nPY", "echo 'mktemp -d /tmp/test-XXXXXX'", 'mktemp -d /tmp/other-XXXXXX']) {
    const no = sessionTempCollector('codex'); no.record(command(cmd, '/tmp/test-abc123\n')); assert.equal(no.creations.length, 0);
  }
});
test('Claude Bash calls need their own successful correlated result', () => {
  const c = sessionTempCollector('claude');
  c.record({timestamp: time, type: 'assistant', message: {content: [{type: 'tool_use', id: 'a', name: 'Bash', input: {command: 'mktemp -d /tmp/test-XXXXXX'}}]}});
  c.record({timestamp: time, type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'b', content: '/tmp/test-abcdef'}]}});
  assert.equal(c.creations.length, 0);
  c.record({timestamp: time, type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'a', content: '/tmp/test-abcdef', is_error: false}]}});
  assert.equal(c.creations.length, 1);
});
test('mkdir evidence resolves literal paths and command-local variables without executing the command', () => {
  for (const [cmd, paths] of [
    ['mkdir -p /tmp/jmprobe && cd /tmp/jmprobe && cat > probe.py <<\'EOF\'\nsource\nEOF', ['/tmp/jmprobe']],
    ['E=/tmp/jm-android && rm -rf $E && mkdir -p $E && git archive HEAD | tar -x -C $E', ['/tmp/jm-android']],
    ['cd /Users/example/project && E="/tmp/jm-final-verify"; mkdir -p "${E}" && ./gradlew test', ['/tmp/jm-final-verify']],
    ['mkdir -p /tmp/jm-live/export /tmp/jm-live/out && git archive HEAD | tar -x -C /tmp/jm-live/export', ['/tmp/jm-live/export', '/tmp/jm-live/out']],
    ["E='/tmp/session outputs'; mkdir -- \"$E\"", ['/tmp/session outputs']],
    ['mkdir /private/tmp/another-session && echo done', ['/private/tmp/another-session']],
  ] as const) {
    const c = sessionTempCollector('codex'); c.record(command(cmd, 'done'));
    assert.deepEqual(c.creations.map(e => e.path), paths, cmd);
  }
});
test('mkdir evidence rejects references, shell control flow, unresolved expansions and non-temporary paths', () => {
  for (const cmd of [
    'echo "mkdir -p /tmp/not-created"', "cat <<'EOF'\nmkdir -p /tmp/not-created\nEOF",
    'if false; then mkdir -p /tmp/not-created; fi', 'false && mkdir -p /tmp/not-created',
    'false; mkdir -p /tmp/not-created', 'mkdir() { :; }; mkdir -p /tmp/not-created',
    '(mkdir -p /tmp/not-created)', 'mkdir -p /tmp/not-created &',
    'E=/tmp/first; eval "E=/tmp/second"; mkdir -p $E',
    'E=$(echo /tmp/not-created); mkdir -p $E', 'mkdir -p "$TMPDIR/unknown"',
    "E=/tmp/not-created; mkdir -p '$E'", 'mkdir -p relative', 'mkdir -p /tmp',
    'mkdir -p /Users/example/Documents', 'mkdir -p /tmp/a/../b', 'mkdir -p /tmp/scratchpad/a',
    'mkdir -p /tmp/a*', 'mkdir -p /tmp/{a,b}', 'mkdir -p /tmp/a > /tmp/log',
  ]) {
    const c = sessionTempCollector('codex'); c.record(command(cmd, ''));
    assert.deepEqual(c.creations, [], cmd);
  }
  const c = sessionTempCollector('codex'); c.record(command('mkdir -p /tmp/failed', '', 1));
  assert.deepEqual(c.creations, []);
});
test('Claude mkdir evidence excludes background, interrupted and failed results', () => {
  for (const extra of [{}, {toolUseResult: {backgroundTaskId: 'task'}}, {toolUseResult: {interrupted: true}}, {error: true}]) {
    const c = sessionTempCollector('claude');
    c.record({timestamp: time, type: 'assistant', message: {content: [{type: 'tool_use', id: 'mkdir', name: 'Bash', input: {command: 'mkdir -p /tmp/generated'}}]}});
    c.record({timestamp: time, type: 'user', ...extra, message: {content: [{type: 'tool_result', tool_use_id: 'mkdir', content: '', is_error: 'error' in extra}]}});
    assert.equal(c.creations.length, Object.keys(extra).length ? 0 : 1);
  }
});
test('only disposable text outputs qualify; code, images, scratchpad and hidden data stay', () => {
  for (const file of ['report.md', 'results/data.csv', '测试 结果/log.txt', 'command.output', 'run.log']) assert.equal(temporaryOutput(file), true, file);
  for (const file of ['source.ts', 'data.jsonl', 'image.png', 'data.json', 'scratchpad/log.txt', 'scratchpad.md', 'daemon.log', 'src/report.md', '.git/log.txt', 'AGENTS.md', 'README.md', 'config/report.txt', '../report.md', 'daemon/run.log', 'CMakeLists.txt']) assert.equal(temporaryOutput(file), false, file);
  assert.ok(tempPathAliases('/private/var/folders/a/b/T/x').includes('/var/folders/a/b/T/x'));
  assert.ok(tempPathAliases('/tmp/x').includes('/private/tmp/x'));
});

test('duplicate tool identities and reassigned Python results cannot prove creation', () => {
  const c = sessionTempCollector('codex'), row = command('mktemp -d /tmp/test-XXXXXX', '/tmp/test-abc123');
  c.record(row); c.record(row);
  assert.equal(c.creations.length, 0);
  for (const code of ["p: str = '/tmp/test-abcdefgh'", "p += 'other'", "tempfile.mkdtemp = lambda **kw: '/tmp/test-abcdefgh'", "def print(p): pass"]) {
    const no = sessionTempCollector('codex');
    no.record(command(`python3 - <<'PY'\nimport tempfile\np = tempfile.mkdtemp(prefix='test-')\n${code}\nprint(p)\nPY`, '/tmp/test-abcdefgh'));
    assert.equal(no.creations.length, 0, code);
  }
});

test('Python creation proof rejects quoted code and indirect variable rebinding', () => {
  for (const body of [
    `import tempfile\ns = '''\np = tempfile.mkdtemp(prefix='test-')\nprint(p)\n'''\nprint('/tmp/test-abcdefgh')`,
    `import tempfile\np = tempfile.mkdtemp(prefix='test-')\nfor p in ['/tmp/test-abcdefgh']: pass\nprint(p)`,
    `import tempfile\np = tempfile.mkdtemp(prefix='test-')\nglobals()['p'] = '/tmp/test-abcdefgh'\nprint(p)`,
  ]) {
    const c = sessionTempCollector('codex');
    c.record(command(`python3 - <<'PY'\n${body}\nPY`, '/tmp/test-abcdefgh'));
    assert.equal(c.creations.length, 0);
  }
});

// Disposable metadata fixtures only: no cleanup planner, preview, execution or recovery.
async function layout(t: import('node:test').TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-evidence-')));
  t.after(() => rm(base, {recursive: true, force: true}));
  const roots = {claude: join(base, 'claude'), codex: join(base, 'codex')};
  for (const path of Object.values(roots)) await mkdir(path, {mode: 0o700});
  const output = await mkdtemp(join(base, 'generated-'));
  const birth = (await lstat(output)).birthtimeMs;
  const source = join(roots.codex, 'sessions', 's1.jsonl');
  const put = async (path: string, content: string) => {
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    await writeFile(path, content, {mode: 0o600});
  };
  const row = command(`mktemp -d ${base}/generated-XXXXXX`, output);
  row.timestamp = new Date(birth).toISOString();
  await put(source, [JSON.stringify({type: 'session_meta', payload: {id: 's1'}}), JSON.stringify(row), ''].join('\n'));
  const discover = () => discoverSessionTemps(roots, Object.values(roots));
  return {base, roots, output, source, birth, put, discover};
}

test('creation discovery and scoped scans bind evidence and retain source, images and shared files', async t => {
  const f = await layout(t);
  for (const name of ['report.md', 'results/data.csv', 'source.ts', 'image.png', 'scratchpad.md', 'scratchpad/run.log', 'src/notes.txt', 'README.md']) await f.put(join(f.output, name), 'fixture');
  const result = await f.discover();
  assert.deepEqual(result.warnings, []); assert.equal(result.found.length, 1);
  const evidence = result.found[0].evidence;
  assert.equal(validSessionTempEvidence(evidence, f.output, 'codex'), true);
  const scope = {uid: process.getuid!(), excludedRoots: Object.values(f.roots), session: evidence};
  let inv = await scanSystemTemp(f.output, 'codex', scope);
  assert.equal(inv.complete, true, inv.errors.join('\n'));
  assert.deepEqual(inv.files.map(p => p.relative), ['report.md', 'results/data.csv']);
  assert.equal(inv.totalBytes, 14);
  await link(join(f.output, 'report.md'), join(f.base, 'shared-report'));
  await chmod(join(f.output, 'results/data.csv'), 0o666);
  inv = await scanSystemTemp(f.output, 'codex', scope);
  assert.equal(inv.files.length, 0);
  await f.put(join(f.roots.codex, 'sessions', 'new.jsonl'), JSON.stringify({type: 'session_meta', payload: {id: 'new'}}));
  await assert.rejects(verifySessionTempEvidence(evidence, 'codex'), /changed/);
});

test('cross-provider references through custom temporary variables retain the created directory', async t => {
  const f = await layout(t);
  await f.put(join(f.roots.claude, 'projects', 'project', 'other.jsonl'), JSON.stringify({type: 'user', sessionId: 'other', message: {content: `$TMPDIR/${f.output.split('/').at(-1)}/report.md`}}));
  const result = await f.discover();
  assert.equal(result.found.length, 0); assert.match(result.warnings.join('\n'), /referenced/);
});

test('a shared temporary directory retains separately discovered files and nested directories', async t => {
  const f = await layout(t), file = join(f.output, 'report.md');
  await f.put(file, 'fixture');
  const nested = await mkdtemp(join(f.output, 'nested-'));
  const directoryRow = command(`mktemp -d ${f.output}/nested-XXXXXX`, nested);
  directoryRow.timestamp = new Date((await lstat(nested)).birthtimeMs).toISOString();
  const fileRow = {timestamp: new Date((await lstat(file)).birthtimeMs).toISOString(), type: 'event_msg', payload: {
    type: 'item_completed', item: {type: 'FileChange', id: 'nested-file', status: 'completed', changes: {[file]: {type: 'add'}}},
  }};
  await f.put(f.source, await readFile(f.source, 'utf8') + [JSON.stringify(fileRow), JSON.stringify(directoryRow)].join('\n'));
  assert.deepEqual((await f.discover()).found.map(item => item.evidence.path), [f.output]);
  await f.put(join(f.roots.claude, 'projects', 'project', 'other.jsonl'), JSON.stringify({
    type: 'user', sessionId: 'other', cwd: f.output, message: {content: 'Use the working directory'},
  }));
  const result = await f.discover();
  assert.deepEqual(result.found, []);
  assert.match(result.warnings.join('\n'), /referenced/);
});

test('unsupported, linked or writable history fails closed; unrelated provider caches do not participate', async t => {
  const f = await layout(t);
  await f.put(join(f.roots.codex, 'plugins', 'broken.jsonl'), 'not a session');
  assert.equal((await f.discover()).found.length, 1);
  await chmod(f.source, 0o666);
  assert.equal((await f.discover()).found.length, 0);
  await chmod(f.source, 0o600);
  await symlink(f.output, join(f.roots.claude, 'projects'));
  assert.equal((await f.discover()).found.length, 0);
});

test('receipt evidence rejects non-history sources, provider overlap and non-temporary direct files', async t => {
  const f = await layout(t), e = (await f.discover()).found[0].evidence;
  assert.equal(validSessionTempEvidence({...e, source: join(f.roots.codex, 'config.jsonl')}, f.output, 'codex'), false);
  assert.equal(validSessionTempEvidence({...e, path: f.roots.claude}, f.roots.claude, 'codex'), false);
  const file = '/Users/example/Documents/report.md';
  assert.equal(validSessionTempEvidence({...e, path: file, kind: 'file'}, dirname(file), 'codex'), false);
});

test('source repositories and protected ancestors are retained during scans and rechecks', async t => {
  const f = await layout(t), e = (await f.discover()).found[0].evidence;
  const scope = {uid: process.getuid!(), excludedRoots: Object.values(f.roots), session: e};
  await f.put(join(f.output, 'report.md'), 'fixture');
  await f.put(join(f.output, 'checkout', '.git'), 'gitdir: /inert');
  await f.put(join(f.output, 'checkout', 'design.md'), 'source');
  assert.deepEqual((await scanSystemTemp(f.output, 'codex', scope)).files.map(p => p.relative), ['report.md']);
  await assert.rejects(verifySystemTempParents(f.output, join(f.output, 'checkout', 'design.md'), 'codex', scope), /repository/i);
  await f.put(join(f.base, '.git'), 'gitdir: /inert');
  assert.equal((await f.discover()).found.length, 0);
  await assert.rejects(verifySystemTempParents(f.output, join(f.output, 'report.md'), 'codex', scope), /repository/i);
  const path = '/tmp/scratchpad/generated-abc123';
  assert.equal(validSessionTempEvidence({...e, path}, path, 'codex'), false);
});

test('mkdir discovery binds filesystem birth time and protects exported source projects', async t => {
  const f = await layout(t);
  const row = command(`E="${f.output}" && rm -rf "$E" && mkdir -p "$E" && echo done`, 'done');
  row.timestamp = new Date(f.birth).toISOString();
  const history = [JSON.stringify({type: 'session_meta', payload: {id: 's1'}}), JSON.stringify(row)].join('\n');
  await f.put(f.source, history);
  await f.put(join(f.output, 'run.log'), 'fixture');
  let result = await f.discover();
  assert.equal(result.found.length, 1);
  const scope = {uid: process.getuid!(), excludedRoots: Object.values(f.roots), session: result.found[0].evidence};
  assert.deepEqual((await scanSystemTemp(f.output, 'codex', scope)).files.map(p => p.relative), ['run.log']);
  await f.put(f.source, history.replace(row.timestamp, '2000-01-01T00:00:00.000Z'));
  assert.equal((await f.discover()).found.length, 0);
  await f.put(f.source, history);
  await f.put(join(f.output, 'export', 'settings.gradle.kts'), 'source');
  await f.put(join(f.output, 'export', 'docs', 'design.md'), 'source');
  result = await f.discover();
  scope.session = result.found[0].evidence;
  assert.deepEqual((await scanSystemTemp(f.output, 'codex', scope)).files.map(p => p.relative), ['run.log']);
  await assert.rejects(verifySystemTempParents(f.output, join(f.output, 'export', 'docs', 'design.md'), 'codex', scope), /source project/i);
  await f.put(join(f.output, 'package.json'), '{}');
  assert.equal((await f.discover()).found.length, 0);
});

test('direct FileChange additions bind the file identity and creation time', async t => {
  const f = await layout(t), path = join(f.base, 'report.md');
  await f.put(path, 'fixture');
  const s = await lstat(path);
  const row = {timestamp: new Date(s.birthtimeMs).toISOString(), type: 'event_msg', payload: {type: 'item_completed', item: {
    type: 'FileChange', id: 'change-1', status: 'completed', changes: {[path]: {type: 'add'}},
  }}};
  const source = [JSON.stringify({type: 'session_meta', payload: {id: 's1'}}), JSON.stringify(row)].join('\n');
  await f.put(f.source, source);
  const result = await f.discover();
  assert.equal(result.found.length, 1);
  const e = result.found[0].evidence, scope = {uid: process.getuid!(), excludedRoots: Object.values(f.roots), session: e};
  assert.equal(e.kind, 'file');
  assert.deepEqual((await scanSystemTemp(f.base, 'codex', scope)).files.map(p => p.path), [path]);
  assert.equal((await scanSystemTemp(f.base, 'codex', {...scope, session: {...e, ino: e.ino + 1}})).files.length, 0);
  await f.put(f.source, source.replace(row.timestamp, '2000-01-01T00:00:00.000Z'));
  assert.equal((await f.discover()).found.length, 0);
});

test('malformed, compressed and inherited history cannot establish safe temporary ownership', async t => {
  const f = await layout(t), original = await readFile(f.source, 'utf8');
  for (const content of [original + '\nnot-json', original.replace('"id":"s1"', '"id":"s1","forked_from_id":"parent"')]) {
    await f.put(f.source, content);
    assert.equal((await f.discover()).found.length, 0);
  }
  await f.put(f.source, original);
  await f.put(join(f.roots.codex, 'archived_sessions', 'other.jsonl.zst'), 'compressed fixture');
  assert.equal((await f.discover()).found.length, 0);
});

test('temporary discovery and verification propagate cancellation', async t => {
  const f = await layout(t), e = (await f.discover()).found[0].evidence;
  const controller = new AbortController(); controller.abort(new Error('Cancelled'));
  await assert.rejects(discoverSessionTemps(f.roots, [], controller.signal), /Cancelled/);
  await assert.rejects(verifySessionTempEvidence(e, 'codex', true, controller.signal), /Cancelled/);
});
