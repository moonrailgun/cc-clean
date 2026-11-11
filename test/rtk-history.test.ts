import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {slimHistory, slimCodexItem, commandFilter} from '../src/slim.ts';
const options = {removeImages: false, compactTools: true};
const meta = {type: 'session_meta', payload: {id: 'synthetic'}};
const row = (payload: unknown) => ({type: 'response_item', payload});
const jsonl = (...rows: unknown[]) => Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const raw = readFileSync(new URL('../third_party/rtk/fixtures/gradlew_build_raw.txt', import.meta.url), 'utf8');
const marker = '[cc-clean: RTK output compacted; omitted content is unavailable]';
const call = (id: string, name: string, args: object) => row({type: 'function_call', call_id: id, name, arguments: JSON.stringify(args)});
const result = (id: string, status: object, output = raw) => row({type: 'function_call_output', call_id: id, output: JSON.stringify({...status, output})});
const transform = (...rows: unknown[]) => slimHistory(jsonl(meta, ...rows), 'codex', options);

for (const [fixture, command, expected] of [
  ['next-build', 'npx next build', /3 routes \(2 static, 1 dynamic\)/],
  ['prisma-status', 'npx prisma migrate status', /Migrations: 9 applied, 0 pending/],
  ['prisma-deploy', 'npx prisma migrate deploy', /1 migration\(s\) deployed/],
] as const) {
  test(`${fixture}: history stores accurate route and migration summaries`, () => {
    const input = readFileSync(new URL(`fixtures/rtk-js/${fixture}.txt`, import.meta.url), 'utf8');
    const output = transform(call('x', 'exec_command', {cmd: command}), result('x', {exit_code: 0}, input));
    assert.equal(output.counts.toolOutputs, 1);
    const saved = JSON.parse(JSON.parse(output.output!.toString().trim().split('\n').at(-1)!).payload.output).output;
    assert.ok(saved.startsWith(marker));
    assert.match(saved, expected);
    if (fixture === 'next-build') {
      assert.match(saved, /\/about\s+156 kB/);
      assert.match(saved, /\/api\/auth\s+89 kB/);
    }
  });
}

test('Next.js route names do not corrupt statistics stored in history', () => {
  const input = readFileSync(new URL('fixtures/rtk-js/next-build.txt', import.meta.url), 'utf8')
    .replace('┌ ○ / ', '┌ ○ /warnings ').replace('/about', '/_error').replace('/api/auth', '/login/123ms');
  const output = transform(call('x', 'exec_command', {cmd: 'npx next build'}), result('x', {exit_code: 0}, input));
  assert.equal(output.counts.toolOutputs, 1);
  const saved = JSON.parse(JSON.parse(output.output!.toString().trim().split('\n').at(-1)!).payload.output).output;
  assert.ok(saved.startsWith(marker));
  assert.match(saved, /Time: 5\.0s \| Errors: 0 \| Warnings: 0$/);
});

test('successful kubectl reads preserve workload failures in Codex and Claude history', () => {
  const command = 'kubectl get pods -o json';
  const input = JSON.stringify({kind: 'PodList', items: [{metadata: {name: 'web', namespace: 'prod'}, status: {
    phase: 'Running', conditions: [{type: 'Ready', status: 'False', reason: 'ContainersNotReady'}],
    containerStatuses: [
      {name: 'sidecar', ready: true, restartCount: 0, state: {running: {}}},
      {name: 'app', ready: false, restartCount: 0, state: {waiting: {
        reason: 'ImagePullBackOff', message: 'Back-off pulling image "app:missing"',
      }}},
    ],
  }}]});
  assert.equal(commandFilter(command), 'native:kube-pods');
  const codex = transform(call('x', 'exec_command', {cmd: command}), result('x', {exit_code: 0}, input));
  const claude = slimHistory(jsonl(
    {type: 'assistant', sessionId: 'synthetic', uuid: 'a', message: {content: [{type: 'tool_use', id: 'x', name: 'Bash', input: {command}}]}},
    {type: 'user', sessionId: 'synthetic', uuid: 'b', parentUuid: 'a', message: {content: [{type: 'tool_result', tool_use_id: 'x', is_error: false, content: input}]}},
  ), 'claude', options);
  for (const output of [codex, claude]) {
    assert.equal(output.counts.toolOutputs, 0);
    assert.equal(output.output, null);
  }
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} history retains Kubernetes named target ports`, () => {
    const command = 'kubectl get services -o json';
    const input = JSON.stringify({kind: 'ServiceList', items: [{metadata: {name: 'web', namespace: 'prod'},
      spec: {type: 'ClusterIP', ports: [{port: 80, targetPort: 'http'}]}}]});
    const output = provider === 'codex'
      ? transform(call('x', 'exec_command', {cmd: command}), result('x', {exit_code: 0}, input))
      : slimHistory(jsonl(
        {type: 'assistant', sessionId: 'synthetic', uuid: 'a', message: {content: [{type: 'tool_use', id: 'x', name: 'Bash', input: {command}}]}},
        {type: 'user', sessionId: 'synthetic', uuid: 'b', parentUuid: 'a', message: {content: [{type: 'tool_result', tool_use_id: 'x', is_error: false, content: input}]}},
      ), 'claude', options);
    assert.equal(output.counts.toolOutputs, 1);
    const saved = JSON.parse(output.output!.toString().trim().split('\n').at(-1)!);
    const content = provider === 'codex' ? JSON.parse(saved.payload.output).output : saved.message.content[0].content;
    assert.equal(content, `${marker}\n1 services:\n  prod/web ClusterIP [80→http]\n`);
  });
}

test('Pod readiness gates remain intact in Codex and Claude history', () => {
  const command = 'kubectl get pods -o json';
  assert.equal(commandFilter(command), 'native:kube-pods');
  for (const status of ['False', 'Unknown']) {
    const input = JSON.stringify({kind: 'PodList', items: [{metadata: {name: 'web', namespace: 'prod'},
      spec: {readinessGates: [{conditionType: 'example.com/load-balancer-ready'}]}, status: {
        phase: 'Running', conditions: [{type: 'ContainersReady', status: 'True'},
          {type: 'Ready', status, reason: 'ReadinessGatesNotReady', message: 'Load balancer readiness gate has not passed'}],
        containerStatuses: [{name: 'app', ready: true, restartCount: 0, state: {running: {}}}],
      }}]});
    const codex = transform(call('x', 'exec_command', {cmd: command}), result('x', {exit_code: 0}, input));
    const claude = slimHistory(jsonl(
      {type: 'assistant', sessionId: 'synthetic', uuid: 'a', message: {content: [{type: 'tool_use', id: 'x', name: 'Bash', input: {command}}]}},
      {type: 'user', sessionId: 'synthetic', uuid: 'b', parentUuid: 'a', message: {content: [{type: 'tool_result', tool_use_id: 'x', is_error: false, content: input}]}},
    ), 'claude', options);
    for (const output of [codex, claude]) {
      assert.equal(output.counts.toolOutputs, 0);
      assert.equal(output.output, null);
    }
  }
});

test('expanded filters reach Claude Bash and preserve record graph and output metadata', () => {
  const assistant = {type: 'assistant', sessionId: 'synthetic', uuid: 'a', message: {content: [{type: 'tool_use', id: 'call', name: 'Bash', input: {command: 'env CI=1 ./gradlew build'}}]}};
  const user = {type: 'user', sessionId: 'synthetic', uuid: 'b', parentUuid: 'a', usage: {input_tokens: 123}, message: {content: [{type: 'tool_result', tool_use_id: 'call', is_error: false, content: raw}]}};
  const input = jsonl(assistant, user), output = slimHistory(input, 'claude', options);
  assert.equal(output.counts.toolOutputs, 1);
  const [savedAssistant, savedUser] = output.output!.toString().trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(savedAssistant, assistant);
  assert.equal(savedUser.parentUuid, 'a');
  assert.deepEqual(savedUser.usage, user.usage);
  assert.match(savedUser.message.content[0].content, /BUILD SUCCESSFUL/);
  assert.ok(savedUser.message.content[0].content.startsWith(marker));
  assert.equal(slimHistory(output.output!, 'claude', options).output, null);
  assert.equal(output.savingsBytes.toolOutputs, input.length - output.output!.length);
});

test('literal exec wrappers compact their single printed successful result', () => {
  const wrapped = row({type: 'custom_tool_call', name: 'functions.exec', call_id: 'wrapped', input: 'const r = await tools.exec_command({cmd:"cd /tmp && ./gradlew build"}); text(r);'});
  const envelope = '{ "chunk_id":"abc", "wall_time_seconds":1.2300, "large":9007199254740993, "exit_code":0, "output":' + JSON.stringify(raw) + ' }';
  const output = transform(wrapped, row({type: 'custom_tool_call_output', call_id: 'wrapped', output: envelope}));
  assert.equal(output.counts.toolOutputs, 1);
  const saved = JSON.parse(output.output!.toString().trim().split('\n').at(-1)!).payload.output;
  assert.ok(saved.startsWith('{ "chunk_id":"abc", "wall_time_seconds":1.2300, "large":9007199254740993, "exit_code":0, "output":'));
  assert.ok(JSON.parse(saved).output.startsWith(marker));
  for (const input of ['text(await tools.exec_command({cmd: getCommand()}));', 'text(await tools.exec_command({cmd:"gradle build"})); text(await tools.exec_command({cmd:"cargo test"}));', 'text((await tools.exec_command({cmd:"gradle build"})).output);']) {
    assert.equal(transform(row({...wrapped.payload as object, input}), row({type: 'custom_tool_call_output', call_id: 'wrapped', output: envelope})).output, null);
  }
  const prefix = 'Script completed\nWall time: 0.1 seconds\nOutput:\n';
  const rendered = transform(wrapped, row({type: 'custom_tool_call_output', call_id: 'wrapped', output: prefix + envelope}));
  const savedRendered = JSON.parse(rendered.output!.toString().trim().split('\n').at(-1)!).payload.output;
  assert.ok(savedRendered.startsWith(prefix));
  assert.ok(JSON.parse(savedRendered.slice(prefix.length)).output.startsWith(marker));
  for (const output of ['Script running with cell ID 1\nOutput:\n' + envelope, prefix + envelope + '\n' + envelope])
    assert.equal(transform(wrapped, row({type: 'custom_tool_call_output', call_id: 'wrapped', output})).output, null);
  assert.equal(transform(wrapped, result('wrapped', {exit_code: 0})).output, null);
});

test('completed write_stdin output follows its original command while live chunks stay unchanged', () => {
  const start = call('start', 'exec_command', {cmd: 'gradle build'}), live = result('start', {session_id: 42}, 'still running');
  const poll = call('poll', 'write_stdin', {session_id: 42, chars: ''}), livePoll = result('poll', {session_id: 42}, 'more progress');
  const end = call('end', 'write_stdin', {session_id: 42});
  const output = transform(start, live, poll, livePoll, end, result('end', {exit_code: 0}));
  assert.equal(output.counts.toolOutputs, 1);
  const saved = output.output!.toString().trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(saved.slice(1, 6), [start, live, poll, livePoll, end]);
  assert.ok(JSON.parse(saved.at(-1).payload.output).output.startsWith(marker));
  assert.equal(transform(start, live, call('input', 'write_stdin', {session_id: 42, chars: 'other command\n'}), result('input', {exit_code: 0})).output, null);
  assert.equal(transform(start, live, poll, call('second', 'write_stdin', {session_id: 42}), result('poll', {exit_code: 0}), result('second', {exit_code: 0})).output, null);
  assert.equal(transform(start, live, poll, call('reuse', 'exec_command', {cmd: 'gradle build'}), result('reuse', {session_id: 42}), result('poll', {exit_code: 0})).output, null);
});

test('failures, conflicting sessions, malformed envelopes and unmatched output remain intact', () => {
  for (const status of [{exit_code: 1}, {session_id: 42}, {}, {exit_code: 0, session_id: 42}, {exit_code: '0'}, {metadata: {exit_code: 0}, exit_code: 1}])
    assert.equal(transform(call('x', 'exec_command', {cmd: 'gradle build'}), result('x', status)).output, null);
  assert.equal(transform(result('missing', {exit_code: 0})).output, null);
  assert.equal(transform(call('x', 'write_stdin', {session_id: 999}), result('x', {exit_code: 0})).output, null);
  assert.equal(transform(call('a', 'exec_command', {cmd: 'gradle build'}), result('a', {session_id: 42}), call('b', 'exec_command', {cmd: 'gradle build'}), result('b', {session_id: 42}), call('poll', 'write_stdin', {session_id: 42}), result('poll', {exit_code: 0})).output, null);
  const duplicated = row({type: 'function_call', call_id: 'x', name: 'exec_command', arguments: '{"cmd":"gradle build","cmd":"cargo test"}'});
  assert.equal(transform(duplicated, result('x', {exit_code: 0})).output, null);
  assert.throws(() => transform(call('x', 'exec_command', {cmd: 'gradle build'}), result('x', {exit_code: 0}), result('x', {exit_code: 0})), /Duplicate tool result/);
});

test('canonical events and SQLite UI items resolve argv and shell wrappers consistently', () => {
  for (const item of [
    {type: 'CommandExecution', status: 'completed', exit_code: 0, command: ['./gradlew', 'build'], aggregated_output: raw},
    {type: 'commandExecution', status: 'completed', exitCode: 0, command: 'cd /tmp && ./gradlew build', aggregatedOutput: raw},
  ]) {
    const text = JSON.stringify({...item, id: 'keep', duration: 42}), output = slimCodexItem(text, options);
    assert.ok(output.includes(marker));
    assert.equal(JSON.parse(output).id, 'keep');
    assert.equal(slimCodexItem(output, options), output);
    assert.equal(slimCodexItem(JSON.stringify({...item, status: 'inProgress'}), options), JSON.stringify({...item, status: 'inProgress'}));
  }
  assert.equal(commandFilter('npx --yes tsc --noEmit'), 'tsc');
  assert.equal(commandFilter('npm run build'), undefined);
});

test('known ANSI styling and CRLF are filtered but cursor control remains untouched', () => {
  const colored = raw.replace('BUILD SUCCESSFUL', '\x1b[32mBUILD SUCCESSFUL\x1b[0m').replace(/\n/g, '\r\n');
  assert.equal(transform(call('x', 'exec_command', {cmd: 'gradle build'}), result('x', {exit_code: 0}, colored)).counts.toolOutputs, 1);
  assert.equal(transform(call('x', 'exec_command', {cmd: 'gradle build'}), result('x', {exit_code: 0}, raw + '\x1b[2J')).output, null);
});
