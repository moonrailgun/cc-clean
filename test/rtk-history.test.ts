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
