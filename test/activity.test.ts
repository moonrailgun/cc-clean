import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityCheck } from '../src/activity.ts';

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
