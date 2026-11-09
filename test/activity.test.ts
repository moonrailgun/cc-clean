import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, link, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityCheck, activityReason } from '../src/activity.ts';
import { readActivityMetadata } from '../src/claude-activity.ts';

// Mock OS results and disposable metadata only; never run cleanup or native clients.
function fixture(commands = '/bin/zsh\n', args = '', opened = '') {
  const calls: {file: string; args: string[]}[] = [];
  const check = createActivityCheck(async (file, argv) => {
    calls.push({file, args: argv});
    if (file === '/bin/ps') return {stdout: argv.includes('comm=') ? commands : args};
    if (opened) return {stdout: opened};
    throw Object.assign(new Error('No open files'), {code: 1, stdout: '', stderr: ''});
  }, 'darwin');
  return {check, calls};
}

test('idle native and desktop clients protect their provider without an open transcript', async () => {
  for (const command of ['claude', '/Users/example/.local/share/claude/versions/2.1.319', '/Applications/ClaudeCode.app/Contents/MacOS/helper']) {
    const f = fixture(command);
    assert.match((await f.check('claude', '/inert', ['/inert/old.jsonl']))!, /idle|open session/i);
    assert.equal(f.calls.filter(c => c.file.endsWith('lsof')).length, 0);
  }
  for (const command of ['codex', '/Applications/Codex.app/Contents/MacOS/Codex', '/Applications/ChatGPT.app/Contents/Resources/CodexCLI.app/Contents/MacOS/helper'])
    assert.ok(await fixture(command).check('codex', '/inert'));
});

test('known npm clients launched through a runtime retain idle sessions', async () => {
  for (const [provider, script] of [['claude', '@anthropic-ai/claude-code/cli.js'], ['codex', '@openai/codex/bin/codex.js']] as const) {
    for (const runtime of ['node', '/opt/homebrew/bin/bun']) {
      const f = fixture(runtime, `${runtime} /inert/node_modules/${script} --resume private-prompt`);
      const reason = await f.check(provider, '/inert');
      assert.ok(reason);
      assert.doesNotMatch(reason!, /private-prompt/);
    }
  }
});

test('closed clients and other-provider or unrelated processes do not block', async () => {
  assert.equal(await fixture().check('claude', '/inert'), null);
  assert.equal(await fixture('codex').check('claude', '/inert'), null);
  assert.equal(await fixture('claude').check('codex', '/inert'), null);
  assert.equal(await fixture('node', 'node /inert/server.js --message @anthropic-ai/claude-code/cli.js').check('claude', '/inert'), null);
});

test('open candidate files and unreliable OS inspection remain protected', async () => {
  assert.match((await fixture('/bin/zsh', '', 'n/inert/session.jsonl\n').check('codex', '/inert'))!, /open files/i);
  for (const failure of [new Error('ps unavailable'), Object.assign(new Error('partial lsof'), {code: 1, stdout: '', stderr: 'Permission denied'})]) {
    const check = createActivityCheck(async file => {
      if (file === '/bin/ps' && 'code' in failure) return {stdout: '/bin/zsh\n'};
      throw failure;
    }, 'darwin');
    assert.match((await check('claude', '/inert'))!, /Cannot reliably check/);
  }
  assert.match((await createActivityCheck(async () => ({stdout: ''}), 'linux')('codex', '/inert'))!, /not verified/);
});

test('external candidates are checked in bounded batches without recursively scanning shared temp roots', async () => {
  const f = fixture(), files = Array.from({length: 205}, (_, i) => `/tmp/candidate-${i}`);
  assert.equal(await f.check('claude', '/tmp', files), null);
  const scans = f.calls.filter(c => c.file.endsWith('lsof'));
  assert.equal(scans.length, 3);
  assert.ok(scans.every(c => !c.args.includes('+D')));
  assert.deepEqual(scans.flatMap(c => c.args.slice(c.args.indexOf('--') + 1)), files);
});

test('open-file inspection excludes its own transaction but retains external writers', async () => {
  let externalWriter = false;
  const check = createActivityCheck(async (file, args) => {
    if (file.endsWith('ps')) return {stdout: '/bin/zsh\n'};
    const excludesSelf = args.includes('-a') && args[args.indexOf('-p') + 1] === `^${process.pid}`;
    if (!excludesSelf || externalWriter) return {stdout: `p${externalWriter ? process.pid + 1 : process.pid}\nn/inert/state_5.sqlite\n`};
    throw Object.assign(new Error('No open files'), {code: 1, stdout: '', stderr: ''});
  }, 'darwin');
  assert.equal(await check('codex', '/inert'), null);
  externalWriter = true;
  assert.match(await check('codex', '/inert') as string, /open files/);
});

const active = '11111111-1111-4111-8111-111111111111', source = '22222222-2222-4222-8222-222222222222';
const start = 'Mon Nov  9 02:40:18 2026', uid = process.getuid!();
function registeredFixture() {
  const rows = [{pid: 10, ppid: 1, uid, start, comm: 'claude', args: 'claude'}];
  const metadata: Record<string, any> = {'sessions/10.json': {pid: 10, procStart: start, sessionId: active, kind: 'interactive', pidDomain: 'darwin'}};
  let opened = '', snapshots = 0;
  const run = async (file: string, args: string[], options: any) => {
    if (file.endsWith('lsof')) {
      if (opened) return {stdout: opened};
      throw Object.assign(new Error('No opens'), {code: 1, stdout: '', stderr: ''});
    }
    if (args.includes('comm=')) return {stdout: 'claude\nnode\n'};
    if (args.some(a => a.includes('lstart'))) {
      snapshots++; assert.equal(options.env.TZ, 'UTC'); assert.equal(options.env.LC_ALL, 'C');
      return {stdout: rows.map(p => `${p.pid} ${p.ppid} ${p.uid} ${p.start} ${p.comm}`).join('\n')};
    }
    return {stdout: rows.map(p => `${p.pid} ${p.args}`).join('\n')};
  };
  const read = async (root: string, path: string) => { assert.equal(root, '/claude'); return structuredClone(metadata[path] ?? null); };
  return {rows, metadata, run, read, check: createActivityCheck(run, 'darwin', read), open: (s: string) => {opened = s;}, snapshots: () => snapshots};
}

test('verified idle registrations yield session protection with fresh PID start checks', async () => {
  const f = registeredFixture();
  assert.deepEqual(await f.check('claude', '/claude', []), {sessionIds: [active], openFiles: []});
  assert.equal(f.snapshots(), 2);
  f.metadata['sessions/10.json'].sessionId = source;
  assert.deepEqual(await f.check('claude', '/claude', []), {sessionIds: [source], openFiles: []});
  f.open('p99\nn/claude/projects/p/closed.jsonl\n');
  assert.deepEqual(await f.check('claude', '/claude', ['/claude/projects/p/closed.jsonl']), {sessionIds: [source], openFiles: ['/claude/projects/p/closed.jsonl']});
});

test('unattributed clients, reused PIDs and unsafe metadata retain the whole provider', async () => {
  for (const change of [
    (f: ReturnType<typeof registeredFixture>) => {delete f.metadata['sessions/10.json'];},
    f => {f.metadata['sessions/10.json'].procStart = 'Sun Nov 8 02:40:18 2026';},
    f => {f.metadata['sessions/10.json'].pid = 11;},
    f => {f.rows[0].uid++;},
    f => {f.rows.push({...f.rows[0], pid: 11});},
    f => {f.metadata['sessions/10.json'].sessionId = '../invalid';},
  ] as ((f: ReturnType<typeof registeredFixture>) => void)[]) {
    const f = registeredFixture(); change(f);
    assert.match(await f.check('claude', '/claude', []) as string, /cannot reliably|cannot associate/i);
  }
  const f = registeredFixture();
  assert.match(await createActivityCheck(f.run, 'darwin', async () => {throw new Error('Unsafe metadata with secret');})('claude', '/claude', []) as string, /cannot reliably|cannot associate/i);
});

test('verified daemon, worker and standby processes protect worker and fork source sessions', async () => {
  const f = registeredFixture();
  f.rows[0].ppid = 20; f.metadata['sessions/10.json'].kind = 'bg';
  f.rows.push(
    {pid: 20, ppid: 30, uid, start, comm: 'claude', args: `claude --bg-pty-host --session-id ${active} --fork-session --resume /claude/projects/p/${source}.jsonl`},
    {pid: 30, ppid: 1, uid, start, comm: 'claude', args: 'claude daemon'},
    {pid: 40, ppid: 30, uid, start, comm: 'claude bg-pty-host', args: 'claude bg-pty-host --bg-pty-host --bg-spare'},
    {pid: 41, ppid: 40, uid, start, comm: 'claude bg-spare', args: 'claude bg-spare --bg-spare'});
  f.metadata['daemon.lock'] = {pid: 30, procStart: start};
  f.metadata['daemon/roster.json'] = {supervisorPid: 30, workers: {w: {pid: 20, procStart: start, replPid: 10, replProcStart: start, sessionId: active, dispatch: {sessionId: active, launch: {sessionId: `/claude/projects/p/${source}.jsonl`, fork: true}}}}};
  assert.deepEqual(await f.check('claude', '/claude', []), {sessionIds: [active, source], openFiles: []});
  f.rows[4].ppid = 1;
  assert.equal(typeof await f.check('claude', '/claude', []), 'string');
});

test('a live registered process does not conceal an unregistered npm client', async () => {
  const f = registeredFixture();
  f.rows.push({pid: 99, ppid: 1, uid, start, comm: 'node', args: 'node /tools/node_modules/@anthropic-ai/claude-code/cli.js'});
  assert.equal(typeof await f.check('claude', '/claude', []), 'string');
});

test('registry or process changes during inspection fail closed', async () => {
  const f = registeredFixture(); let reads = 0;
  const check = createActivityCheck(f.run, 'darwin', async (root, path) => {
    const data = await f.read(root, path);
    if (path === 'sessions/10.json' && ++reads > 1) data.sessionId = source;
    return data;
  });
  assert.equal(typeof await check('claude', '/claude', []), 'string');
});

test('transaction copies use original session ownership and retain open backups', () => {
  const backup = '/state/work/action/0.original', output = '/state/work/action/output';
  const original = `/claude/projects/p/${source}.jsonl`;
  assert.equal(activityReason({sessionIds: [active], openFiles: []}, '/claude', [backup, output], [], [original]), null);
  assert.match(activityReason({sessionIds: [source], openFiles: []}, '/claude', [backup], [], [original])!, /active session/);
  for (const opened of [backup, output])
    assert.match(activityReason({sessionIds: [], openFiles: [opened]}, '/claude', [backup, output], [], [original])!, /open files/);
});

test('metadata reader accepts safe records and rejects unsafe files and parents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-activity-')));
  try {
    const sessions = join(root, 'sessions'), record = join(sessions, '10.json');
    await mkdir(sessions, {mode: 0o700});
    await writeFile(record, JSON.stringify({pid: 10}), {mode: 0o600});
    assert.deepEqual(await readActivityMetadata(root, 'sessions/10.json'), {pid: 10});
    assert.equal(await readActivityMetadata(root, 'sessions/99.json'), null);
    await chmod(record, 0o666);
    await assert.rejects(readActivityMetadata(root, 'sessions/10.json'));
    await chmod(record, 0o600); await chmod(sessions, 0o777);
    await assert.rejects(readActivityMetadata(root, 'sessions/10.json'));
    await chmod(sessions, 0o700);
    await symlink(record, join(sessions, 'linked.json'));
    await assert.rejects(readActivityMetadata(root, 'sessions/linked.json'));
    await symlink(sessions, join(root, 'linked-dir'));
    await assert.rejects(readActivityMetadata(root, 'linked-dir/10.json'));
    await link(record, join(sessions, 'hardlinked.json'));
    await assert.rejects(readActivityMetadata(root, 'sessions/10.json'));
    await writeFile(join(sessions, 'large.json'), ' '.repeat(1024 * 1024 + 1), {mode: 0o600});
    await assert.rejects(readActivityMetadata(root, 'sessions/large.json'));
    for (const invalid of ['[]', 'null', '{bad']) {
      await writeFile(join(sessions, 'invalid.json'), invalid, {mode: 0o600});
      await assert.rejects(readActivityMetadata(root, 'sessions/invalid.json'));
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
