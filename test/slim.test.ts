import test from 'node:test';
import assert from 'node:assert/strict';
import { slimHistory, commandFilter, MAX_HISTORY_BYTES } from '../src/slim.ts';
import { filterRtkOutput } from '../src/vendor/rtk.ts';
import { verifyCodexRewriteLayout } from '../src/clean.ts';
import type { Inventory } from '../src/types.ts';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRoot } from '../src/scan.ts';
import { modernSnapshot } from './fixtures/codex-snapshot.ts';

// Synthetic buffers only: never call the cleanup planner, executor or native clients.
const both = { removeImages: true, compactTools: true };
const images = { removeImages: true, compactTools: false };
const tools = { removeImages: false, compactTools: true };
const data = 'aGVsbG8='.repeat(100);
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
const claude = (type: string, content: unknown[], extra = {}) => ({type, sessionId: 'synthetic', version: '2.1.319', message: {content}, ...extra});
const meta = {type: 'session_meta', payload: {id: 'synthetic', cli_version: '0.167.0'}};
const codex = (payload: unknown) => ({type: 'response_item', payload});
const jsonl = (...rows: unknown[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const oldSnapshots = {removeImages: false, compactTools: false, removeOldSnapshots: true};
const snapshot = (n: number) => ({type: 'compacted', payload: {
  message: `Summary ${n}`, window_id: n,
  replacement_history: [{type: 'message', role: 'user', content: [{type: 'input_text', text: `Checkpoint ${n}`}]}],
  replacement_history_metadata: [{}],
}});
const archives = [
  {type: 'api-request-blob', sessionId: 'synthetic', hash: 'blob', message: {role: 'user', content: 'archived prompt'}},
  {type: 'api-request-shape', sessionId: 'synthetic', shapeHash: 'shape', shape: {model: 'example'}},
  {type: 'api-request', sessionId: 'synthetic', id: 'request', shapeHash: 'shape', params: {}, base: 'previous', keep: 0, tail: ['blob'], cacheControl: [], requestDigest: 'digest'},
];
const successfulHook = {
  type: 'attachment', sessionId: 'synthetic', uuid: 'hook-id', parentUuid: 'user-id', timestamp: '2026-11-01T00:00:00Z',
  attachment: {type: 'hook_success', hookName: 'SessionStart:resume', hookEvent: 'SessionStart', toolUseID: 'tool-id',
    command: 'echo saved-command', content: 'saved context', stdout: 'saved output', stderr: 'saved diagnostic', exitCode: 0, durationMs: 12},
  rendered: [{content: 'model-facing context'}],
};
const toolSnapshot = {
  type: 'attachment', sessionId: 'synthetic', uuid: 'snapshot-id', parentUuid: 'user-id', timestamp: '2026-11-01T00:00:00Z',
  attachment: {type: 'prompt_snapshot', systemPrompt: ['Keep system instructions'], cliPrefix: 'keep', reminderFold: true,
    systemTurns: true, toolChangeHeader: true, inlineTools: true, keptReminders: true, echoWireToolInputs: false, contextRendering: 'keep',
    tools: [{name: 'Read', description: 'Read a file', schema: {name: 'Read', description: 'Read a file',
      input_schema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}, eager_input_streaming: true}}]},
};
const skillListing = {
  type: 'attachment', sessionId: 'synthetic', uuid: 'skills-id', parentUuid: 'snapshot-id', timestamp: '2026-11-01T00:00:00Z',
  attachment: {type: 'skill_listing', content: 'Available skills and their descriptions', names: ['example'], skillCount: 1, isInitial: true},
  rendered: [{content: 'Rendered skill descriptions'}], renderedRole: 'user',
};

test('Claude tool and skill slimming preserve raw prompts, chat, cost and graph while resetting skill discovery', () => {
  const user = JSON.stringify(claude('user', [{type: 'text', text: 'Keep 用户 text'}], {uuid: 'user-id', parentUuid: null}));
  const assistant = JSON.stringify(claude('assistant', [{type: 'thinking', thinking: 'keep', signature: 'keep-signature'}],
    {uuid: 'assistant-id', parentUuid: 'skills-id', usage: {input_tokens: 123, output_tokens: 45}}));
  const cost = '{ "type":"cost-state", "sessionId":"synthetic", "cost":1.230000, "large":9007199254740993 }';
  const rawSnapshot = JSON.stringify(toolSnapshot).replace('"cliPrefix":"keep"', '"cliPrefix" : "keep"')
    .replace('"timestamp":', '"extra":9007199254740993, "timestamp":');
  const listing = JSON.stringify(skillListing).replace('"skillCount":1', '"skillCount" : 1');
  const clearedSnapshot = rawSnapshot.replace(JSON.stringify(toolSnapshot.attachment.tools), '[]');
  const clearedListing = listing.replace(JSON.stringify(skillListing.attachment.content), '""')
    .replace(JSON.stringify(skillListing.attachment.names), '[]').replace('"skillCount" : 1', '"skillCount" : 0')
    .replace(JSON.stringify(skillListing.rendered), '[]');
  for (const newline of ['\n', '\r\n']) for (const finalNewline of ['', newline]) {
    const rows = [user, rawSnapshot, listing, assistant, cost];
    const input = Buffer.from(rows.join(newline) + finalNewline);
    for (const [compactToolDefinitions, compactSkillListings] of [[true, false], [false, true], [true, true]]) {
      const options = {removeImages: false, compactTools: false, compactToolDefinitions, compactSkillListings};
      const result = slimHistory(input, 'claude', options);
      assert.equal(result.output?.toString(), [user, compactToolDefinitions ? clearedSnapshot : rawSnapshot,
        compactSkillListings ? clearedListing : listing, assistant, cost].join(newline) + finalNewline);
      assert.deepEqual(result.counts, {images: 0, toolOutputs: 0,
        ...(compactToolDefinitions ? {toolDefinitions: 1} : {}), ...(compactSkillListings ? {skillListings: 1} : {})});
      assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), input.length - result.output!.length);
      assert.equal(slimHistory(result.output!, 'claude', options).output, null);
    }
  }
});

test('Claude slimming clears every recognized snapshot and resets initial and subsequent skill inventories', () => {
  const tool = toolSnapshot.attachment.tools[0];
  const nextSnapshot = {...toolSnapshot, uuid: 'snapshot-2', parentUuid: skillListing.uuid,
    attachment: {...toolSnapshot.attachment, systemPrompt: ['Keep updated instructions'],
      tools: [tool, {...tool, name: 'Other', schema: {...tool.schema, name: 'Other'}}]}};
  const nextListing = {...skillListing, uuid: 'skills-2', parentUuid: nextSnapshot.uuid, rendered: undefined,
    attachment: {...skillListing.attachment, content: '', isInitial: false,
      names: Array.from({length: 12}, (_, i) => `skill-${i}`), skillCount: 12}};
  const options = {removeImages: false, compactTools: false, compactToolDefinitions: true, compactSkillListings: true};
  const input = jsonl(toolSnapshot, skillListing, nextSnapshot, nextListing);
  const result = slimHistory(input, 'claude', options);
  assert.deepEqual(result.output, jsonl(
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, tools: []}},
    {...skillListing, attachment: {...skillListing.attachment, content: '', names: [], skillCount: 0}, rendered: []},
    {...nextSnapshot, attachment: {...nextSnapshot.attachment, tools: []}},
    {...nextListing, attachment: {...nextListing.attachment, content: '', names: [], skillCount: 0}},
  ));
  assert.deepEqual(result.counts, {images: 0, toolOutputs: 0, toolDefinitions: 3, skillListings: 2});
  assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), input.length - result.output!.length);
  assert.equal(slimHistory(result.output!, 'claude', options).output, null);
});

test('tool and skill slimming retains unknown shapes, other attachments and disabled or Codex content', () => {
  const options = {removeImages: false, compactTools: false, compactToolDefinitions: true, compactSkillListings: true};
  const tool = toolSnapshot.attachment.tools[0];
  for (const row of [
    {...toolSnapshot, uuid: undefined}, {...toolSnapshot, parentUuid: undefined},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, newContext: 'retain'}},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, systemPrompt: 'unexpected'}},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, tools: [{...tool, signature: 'retain'}]}},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, tools: [{...tool, schema: {name: 'Read'}}]}},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, tools: [{...tool, schema: {...tool.schema, newState: 'retain'}}]}},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, tools: undefined}},
    {...toolSnapshot, attachment: {...toolSnapshot.attachment, reminderFold: 'unexpected'}},
    {...skillListing, attachment: {...skillListing.attachment, names: ['example', 'mismatch']}},
    {...skillListing, attachment: {...skillListing.attachment, skillCount: -1}},
    {...skillListing, attachment: {...skillListing.attachment, content: null}},
    {...skillListing, attachment: {...skillListing.attachment, newState: 'retain'}},
    {...skillListing, attachment: {...skillListing.attachment, isInitial: 'unexpected'}},
    {...skillListing, rendered: [{content: 'keep', signature: 'retain'}]},
    {...skillListing, rendered: 'unknown'}, {...skillListing, attachment: {...skillListing.attachment, type: 'other'}},
    successfulHook,
  ]) assert.equal(slimHistory(jsonl(row), 'claude', options).output, null);
  assert.equal(slimHistory(jsonl(toolSnapshot, skillListing), 'claude', {removeImages: false, compactTools: false}).output, null);
  assert.equal(slimHistory(jsonl(meta, toolSnapshot, skillListing), 'codex', options).output, null);
  const result = slimHistory(jsonl({...skillListing, rendered: undefined}, {...toolSnapshot, version: 'future-version'}), 'claude', options);
  assert.equal(result.counts.skillListings, 1);
  assert.equal(result.counts.toolDefinitions, 1);
  assert.equal(JSON.parse(result.output!.toString().split('\n')[0]).attachment.skillCount, 0);
});

test('Claude archive and hook slimming preserve raw conversation, cost and graph bytes independently and together', () => {
  const user = JSON.stringify(claude('user', [{type: 'text', text: 'Keep 用户 text'}], {uuid: 'user-id', parentUuid: null}));
  const assistant = JSON.stringify(claude('assistant', [{type: 'thinking', thinking: 'keep', signature: 'keep-signature'}],
    {uuid: 'assistant-id', parentUuid: 'hook-id', usage: {input_tokens: 123, output_tokens: 45}}));
  const cost = '{ "type":"cost-state", "sessionId":"synthetic", "cost":1.230000, "large":9007199254740993 }';
  const hook = JSON.stringify(successfulHook).replace('"durationMs":12', '"durationMs":12.000');
  const cleared = JSON.stringify({...successfulHook, attachment: {...successfulHook.attachment,
    command: '', content: '', stdout: '', stderr: ''}, rendered: []}).replace('"durationMs":12', '"durationMs":12.000');
  for (const newline of ['\n', '\r\n']) for (const finalNewline of ['', newline]) {
    const rows = [user, hook, ...archives.map(row => JSON.stringify(row)), assistant, cost];
    const input = Buffer.from(rows.join(newline) + finalNewline);
    for (const [removeRequestArchives, compactHooks] of [[true, false], [false, true], [true, true]]) {
      const options = {removeImages: false, compactTools: false, removeRequestArchives, compactHooks};
      const result = slimHistory(input, 'claude', options);
      const expected = [user, compactHooks ? cleared : hook, ...(removeRequestArchives ? [] : rows.slice(2, 5)), assistant, cost];
      assert.equal(result.output?.toString(), expected.join(newline) + finalNewline);
      assert.deepEqual(result.counts, {images: 0, toolOutputs: 0,
        ...(removeRequestArchives ? {requestRecords: 3} : {}), ...(compactHooks ? {hooks: 1} : {})});
      assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), input.length - result.output!.length);
      assert.equal(slimHistory(result.output!, 'claude', options).output, null);
    }
  }
});

test('Claude archives handle a final row without newline and retain unknown archive families or archive-only files', () => {
  const options = {removeImages: false, compactTools: false, removeRequestArchives: true};
  const conversation = jsonl(claude('user', []));
  const input = Buffer.concat([conversation, Buffer.from(JSON.stringify(archives[0]))]);
  const result = slimHistory(input, 'claude', options);
  assert.deepEqual(result.output, conversation);
  assert.equal(result.savingsBytes.requestRecords, input.length - conversation.length);
  assert.equal(slimHistory(jsonl(...archives), 'claude', options).output, null);
  for (const unknown of [
    {...archives[0], usage: {input_tokens: 123}}, {...archives[0], message: 'unexpected'},
    {...archives[1], shape: null}, {...archives[2], tail: [12]}, {...archives[2], keep: -1},
    {type: 'api-request-new', sessionId: 'synthetic'},
  ]) assert.equal(slimHistory(jsonl(claude('user', []), ...archives, unknown), 'claude', options).output, null);
  assert.throws(() => slimHistory(jsonl(claude('user', []), {...archives[0], sessionId: 'other'}), 'claude', options), /Mixed/);
  assert.throws(() => slimHistory(Buffer.concat([input, Buffer.from('\nnot-json')]), 'claude', options), /Malformed/);
});

test('hook compaction retains failures, unknown payloads, prompt snapshots and graph-less records', () => {
  const options = {removeImages: false, compactTools: false, compactHooks: true};
  for (const hook of [
    {...successfulHook, attachment: {...successfulHook.attachment, exitCode: 1}},
    {...successfulHook, attachment: {...successfulHook.attachment, type: 'hook_error'}},
    {...successfulHook, attachment: {...successfulHook.attachment, type: 'prompt_snapshot'}},
    {...successfulHook, attachment: {...successfulHook.attachment, content: null}},
    {...successfulHook, attachment: {...successfulHook.attachment, newContext: 'retain'}},
    {...successfulHook, uuid: undefined}, {...successfulHook, parentUuid: undefined},
    {...successfulHook, rendered: [{content: 'keep', signature: 'new-field'}]},
    {...successfulHook, rendered: 'unrecognized'},
  ]) assert.equal(slimHistory(jsonl(claude('user', []), hook), 'claude', options).output, null);
  const withoutRendered = {...successfulHook, rendered: undefined};
  assert.equal(slimHistory(jsonl(withoutRendered), 'claude', options).counts.hooks, 1);
  const input = jsonl(meta, ...archives, successfulHook);
  assert.equal(slimHistory(input, 'codex', {...options, removeRequestArchives: true}).output, null);
});
const matches = Array.from({length: 40}, (_, i) => `src/very-long-directory-name/example.ts:${i + 1}:matching source line ${i}`).join('\n');
test('Claude Quick clean combines all history operations without double counting', () => {
  const input = jsonl(
    claude('assistant', [{type: 'tool_use', id: 'a', name: 'Bash', input: {command: 'rg -n foo'}}]),
    claude('user', [image, {type: 'tool_result', tool_use_id: 'a', is_error: false, content: matches}]),
    ...archives, successfulHook, toolSnapshot, skillListing,
  );
  const options = {...both, removeRequestArchives: true, compactHooks: true, compactToolDefinitions: true, compactSkillListings: true};
  const result = slimHistory(input, 'claude', options);
  assert.ok(result.output);
  assert.deepEqual(result.counts, {images: 1, toolOutputs: 1, requestRecords: 3, hooks: 1, toolDefinitions: 1, skillListings: 1});
  let savings = 0;
  for (const option of ['removeImages', 'compactTools', 'removeRequestArchives', 'compactHooks', 'compactToolDefinitions', 'compactSkillListings'] as const) {
    const separate = slimHistory(input, 'claude', {removeImages: false, compactTools: false, [option]: true});
    assert.ok(separate.output);
    savings += input.length - separate.output.length;
  }
  assert.equal(savings, input.length - result.output.length);
  assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), savings);
  assert.equal(slimHistory(result.output, 'claude', options).output, null);
});

const compacted = (buffer: Buffer, provider: 'claude' | 'codex', options = both) => {
  const result = slimHistory(buffer, provider, options);
  assert.ok(result.output);
  assert.ok(result.output.length < buffer.length);
  assert.equal(result.savingsBytes.images + result.savingsBytes.toolOutputs, buffer.length - result.output.length);
  if (!options.removeImages) assert.equal(result.savingsBytes.images, 0);
  if (!options.compactTools) assert.equal(result.savingsBytes.toolOutputs, 0);
  const again = slimHistory(result.output, provider, options);
  assert.equal(again.output, null, 'second pass must be a no-op');
  assert.deepEqual(again.savingsBytes, {images: 0, toolOutputs: 0});
  return result;
};

test('mixed history savings match image-only and output-only byte reductions, including escaped Codex envelopes', () => {
  const output = matches.replaceAll('matching source line', '路径含有 "引号" 和 \\ 分隔符');
  const inputs = {
    claude: jsonl(
      claude('assistant', [{type: 'tool_use', id: 'a', name: 'Bash', input: {command: 'rg -n foo'}}]),
      claude('user', [image, {type: 'tool_result', tool_use_id: 'a', is_error: false, content: output}]),
    ),
    codex: jsonl(meta,
      codex({type: 'function_call', call_id: 'a', name: 'exec_command', arguments: JSON.stringify({cmd: 'rg -n foo'})}),
      codex({type: 'function_call_output', call_id: 'a', output: JSON.stringify({output, metadata: {exit_code: 0}})}),
      codex({type: 'message', content: [{type: 'input_image', image_url: `data:image/png;base64,${data}`}]}),
    ),
  };
  for (const provider of ['claude', 'codex'] as const) {
    const input = inputs[provider], result = compacted(input, provider);
    assert.deepEqual(result.savingsBytes, {
      images: input.length - compacted(input, provider, images).output!.length,
      toolOutputs: input.length - compacted(input, provider, tools).output!.length,
    });
  }
});

test('Claude image replacement preserves untouched bytes, signatures, numeric literals and CRLF', () => {
  const raw = `{ "type":"user", "version":"2.1.319", "sessionId":"synthetic", "number":9007199254740993123, "signature":"\\u0061\\\\\\\"", "message":{"content":[{"type":"text","text":"图片 \\u4e2d"},${JSON.stringify(image)}]}}\r\n`;
  const input = Buffer.from(raw), before = Buffer.from(input);
  const result = compacted(input, 'claude', images);
  assert.equal(result.output!.toString(), raw.replace(JSON.stringify(image), JSON.stringify({type: 'text', text: '[image removed]'})));
  assert.deepEqual(input, before);
  assert.deepEqual(result.counts, {images: 1, toolOutputs: 0});
});

test('Claude slimming follows record shape across old, new and mixed versions', () => {
  const versions = ['2.1.246', '2.1.277', '2.1.300', '2.1.319', '2.1.320', '3.0.0', 'custom-build', undefined];
  for (const version of versions) {
    const call = claude('assistant', [{type: 'tool_use', id: 'a', name: 'Bash', input: {command: 'rg -n foo'}}], {version, uuid: 'call'});
    for (const resultVersion of [version, '2.1.319']) {
      const result = claude('user', [image, {type: 'tool_result', tool_use_id: 'a', is_error: false, content: matches}], {version: resultVersion, uuid: 'result', parentUuid: 'call'});
      const input = jsonl(call, result), before = Buffer.from(input);
      const originals = input.toString().trim().split('\n').map(line => JSON.parse(line));
      const rewritten = compacted(input, 'claude');
      assert.deepEqual(rewritten.counts, {images: 1, toolOutputs: 1});
      const rows = rewritten.output!.toString().trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(rows[0], originals[0]);
      assert.deepEqual(rows[1], {...originals[1], message: {content: [
        {type: 'text', text: '[image removed]'},
        {type: 'tool_result', tool_use_id: 'a', is_error: false, content: rows[1].message.content[1].content},
      ]}});
      assert.match(rows[1].message.content[1].content, /RTK output compacted/);
      assert.deepEqual(input, before);
    }
  }
});

test('Codex legacy slimming follows record shape rather than the CLI version', () => {
  for (const cli_version of ['0.154.0', '0.163.0', '0.165.0', '0.166.0', '0.167.0', '0.168.0', 'custom-build', undefined]) {
    const header = {...meta, payload: {...meta.payload, cli_version}};
    const call = codex({type: 'function_call', call_id: 'a', name: 'exec_command', arguments: JSON.stringify({cmd: 'rg -n foo'})});
    const output = codex({type: 'function_call_output', call_id: 'a', output: JSON.stringify({output: matches, metadata: {exit_code: 0}})});
    const message = codex({type: 'message', role: 'user', content: [{type: 'input_image', image_url: `data:image/png;base64,${data}`} ]});
    const input = jsonl(header, call, output, message), before = Buffer.from(input);
    const result = compacted(input, 'codex');
    assert.deepEqual(result.counts, {images: 1, toolOutputs: 1});
    assert.ok(result.output!.toString().startsWith(jsonl(header, call).toString()));
    assert.deepEqual(input, before);
  }
});

test('Claude nested tool images are removed while unknown Base64 and reasoning remain intact', () => {
  const content = [image, {type: 'tool_result', tool_use_id: 'a', content: [image, {type: 'text', text: data}]},
    {type: 'thinking', thinking: data, signature: data}, {type: 'image', source: {type: 'url', url: 'https://example.test/image.png'}}];
  const result = compacted(jsonl(claude('user', content)), 'claude', images);
  assert.equal(result.counts.images, 2);
  const after = JSON.parse(result.output!.toString()).message.content;
  assert.deepEqual(after.slice(2), content.slice(2));
  assert.equal(after[1].content[1].text, data);
  assert.equal(slimHistory(jsonl(claude('user', content)), 'claude', tools).output, null);
});

test('Codex uses a valid input_text block and preserves message identity and remote images', () => {
  const message = {type: 'message', id: 'm', role: 'user', content: [{type: 'input_image', image_url: `data:image/png;base64,${data}`}, {type: 'input_image', image_url: 'https://example.test/image.png'}]};
  const result = compacted(jsonl(meta, codex(message)), 'codex', images);
  const after = JSON.parse(result.output!.toString().split('\n')[1]).payload;
  assert.equal(after.id, 'm');
  assert.deepEqual(after.content[0], {type: 'input_text', text: '[image removed]'});
  assert.deepEqual(after.content[1], message.content[1]);
});

test('Codex UI image copies keep remote images, parallel hints and file ordering aligned', () => {
  const url = `data:image/png;base64,${data}`, remote = 'https://example.test/image.png';
  const event = {type: 'event_msg', payload: {type: 'user_message', message: 'Original text',
    images: [url, remote, url], image_details: ['high', null], file_ids: ['file-1'], file_id_details: ['low'],
    image_order: ['inline', 'file', 'inline', 'inline'], local_images: ['/synthetic/asset.png']}};
  const result = compacted(jsonl(meta, event), 'codex', images);
  assert.equal(result.counts.images, 2);
  assert.deepEqual(JSON.parse(result.output!.toString().split('\n')[1]).payload, {
    ...event.payload, images: [remote], image_details: [null], image_order: ['file', 'inline'],
  });
  const legacy = {type: 'event_msg', payload: {type: 'user_message', message: 'text', images: [url]}};
  assert.deepEqual(JSON.parse(compacted(jsonl(meta, legacy), 'codex', images).output!.toString().split('\n')[1]).payload.images, []);
  for (const extra of [{image_details: [null, null, null, null]}, {image_order: ['inline']}, {image_order: ['unknown']}, {image_order: null}]) {
    assert.equal(slimHistory(jsonl(meta, {...event, payload: {...event.payload, ...extra}}), 'codex', images).output, null);
  }
  assert.equal(slimHistory(jsonl(meta, event), 'codex', tools).output, null);
});

test('Claude filters only paired successful Bash outputs and keeps metadata', () => {
  const call = claude('assistant', [{type: 'tool_use', id: 'a', name: 'Bash', input: {command: 'rg -n foo src'}}]);
  for (const content of [matches, [{type: 'text', text: matches}]]) {
    const result = compacted(jsonl(call, claude('user', [{type: 'tool_result', tool_use_id: 'a', is_error: false, content}])), 'claude', tools);
    assert.deepEqual(result.counts, {images: 0, toolOutputs: 1});
    assert.match(result.output!.toString(), /RTK output compacted/);
    assert.match(result.output!.toString(), /\+30/);
    assert.ok(result.output!.toString().startsWith(JSON.stringify(call) + '\n'));
  }
  for (const block of [
    {tool_use_id: 'a', is_error: true}, {tool_use_id: 'missing', is_error: false}, {tool_use_id: 'a'},
  ]) {
    assert.equal(slimHistory(jsonl(call, claude('user', [{type: 'tool_result', content: matches, ...block}])), 'claude', tools).output, null);
  }
  const other = claude('assistant', [{type: 'tool_use', id: 'a', name: 'Read', input: {command: 'rg -n foo src'}}]);
  assert.equal(slimHistory(jsonl(other, claude('user', [{type: 'tool_result', tool_use_id: 'a', is_error: false, content: matches}])), 'claude', tools).output, null);
});

test('Codex preserves text and JSON success envelopes, rejecting failures and live output', () => {
  const call = codex({type: 'function_call', call_id: 'a', name: 'functions.exec_command', arguments: JSON.stringify({cmd: 'rg -n foo src'})});
  const prefix = 'Chunk ID: abc\nWall time: 0.2 seconds\nProcess exited with code 0\nOriginal token count: 900\nFinal output:\n';
  for (const output of [prefix + matches, JSON.stringify({output: matches, metadata: {exit_code: 0, duration_seconds: 0.2}})]) {
    const result = compacted(jsonl(meta, call, codex({type: 'function_call_output', call_id: 'a', output})), 'codex', tools);
    assert.equal(result.counts.toolOutputs, 1);
    const after = JSON.parse(result.output!.toString().split('\n')[2]).payload.output;
    if (output.startsWith('{')) assert.deepEqual(JSON.parse(after).metadata, JSON.parse(output).metadata);
    else assert.ok(after.startsWith(prefix));
  }
  for (const output of [prefix.replace('code 0', 'code 1') + matches, 'Process running with session ID 1\n' + matches,
    JSON.stringify({output: matches, metadata: {exit_code: 0, session_id: 1}}), matches]) {
    assert.equal(slimHistory(jsonl(meta, call, codex({type: 'function_call_output', call_id: 'a', output})), 'codex', tools).output, null);
  }
});

test('ambiguous commands never select a filter', () => {
  for (const command of ['echo hello', 'rtk rg foo', 'rg foo | head', 'rg foo; pwd', 'rg $(pwd)', 'rg `pwd`', 'rg "unclosed',
    'find . -exec rm {} +', 'fd --exec cat', 'rg --json foo', 'rg -A2 foo', 'rg --files-with-matches foo']) assert.equal(commandFilter(command), undefined, command);
  for (const [command, filter] of [['rg -n "hello world" src', 'grep'], ['rg --files -g *.ts', 'find'], ['find . -type f', 'find'], ['fd --type f', 'find'], ['cargo test', 'cargo-test'], ['python3 -m pytest', 'pytest']]) assert.equal(commandFilter(command), filter);
});

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

test('malformed or unsupported history is rejected as a whole without changing input', () => {
  const good = jsonl(claude('user', [image]));
  for (const input of [Buffer.concat([good, Buffer.from('{bad')]), Buffer.from(good.toString().replace('"version":', '"version":"2.1.319","version":')),
    Buffer.from(good.toString().replace('"sessionId":"synthetic",', '')),
    Buffer.from(good.toString().replace('"type":"user"', '"type":"user","isImported":true')),
    Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), good]), Buffer.alloc(MAX_HISTORY_BYTES + 1)]) {
    const before = Buffer.from(input);
    assert.throws(() => slimHistory(input, 'claude', both));
    assert.deepEqual(input, before);
  }
  assert.throws(() => slimHistory(jsonl(claude('user', [image]), claude('user', [], {sessionId: 'other'})), 'claude', both), /Mixed/);
  assert.throws(() => slimHistory(jsonl(meta, {...meta}), 'codex', both), /Multiple/);
  for (const payload of [{history_mode: 'unknown'}, {history_base: {end_byte_offset: 1}}, {forked_from_id: 'other'}, {attached_thread: true},
    {forked_from_ordinal_exclusive: 0}, {subagent_history_start_ordinal: 1}, {id: ''}, {id: null}]) {
    assert.throws(() => slimHistory(jsonl({...meta, payload: {...meta.payload, ...payload}}), 'codex', both));
  }
});

test('duplicate calls and oversized nesting are rejected; empty options make no edits', () => {
  const call = claude('assistant', [{type: 'tool_use', id: 'a', name: 'Bash', input: {command: 'rg -n foo'}}]);
  assert.throws(() => slimHistory(jsonl(call, call), 'claude', tools), /Duplicate tool/);
  let value: unknown = 'leaf'; for (let i = 0; i < 105; i++) value = [value];
  assert.throws(() => slimHistory(jsonl(claude('user', [image], {value})), 'claude', images), /nesting/);
  assert.equal(slimHistory(jsonl(claude('user', [image])), 'claude', {removeImages: false, compactTools: false}).output, null);
  const noNewline = Buffer.from(jsonl(claude('user', [image])).toString().trimEnd());
  assert.equal(compacted(noNewline, 'claude', images).output!.at(-1), 125);
});

test('Codex root layout rejects linked history and incomplete inventories before reading', async () => {
  const inv: Inventory = {provider: 'codex', root: '/synthetic', exists: true, complete: true, files: [], links: [], totalBytes: 0, allocatedBytes: 0, errors: []};
  await assert.rejects(verifyCodexRewriteLayout({...inv, links: [{path: '/synthetic/sessions', target: '/outside'}]}), /Codex|SQLite/);
  await assert.rejects(verifyCodexRewriteLayout({...inv, complete: false}), /complete/);
});

test('Codex layout checks all synthetic headers and config without changing files', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-layout-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const inherited = process.env.CODEX_SQLITE_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  t.after(() => { if (inherited === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = inherited; });
  await mkdir(join(root, 'sessions')); await mkdir(join(root, 'archived_sessions'));
  const current = join(root, 'sessions', 'current.jsonl'), other = join(root, 'archived_sessions', 'other.jsonl');
  await writeFile(current, jsonl(meta)); await writeFile(other, jsonl({...meta, payload: {...meta.payload, cli_version: '0.154.0'}}));
  await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
  assert.deepEqual(await readFile(current), jsonl(meta));
  await writeFile(other, jsonl({...meta, payload: {...meta.payload, history_base: {end_byte_offset: 42}}}));
  await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /shared/);
  await writeFile(other, jsonl(meta));
  await writeFile(join(root, 'config.toml'), 'sqlite_home = "/elsewhere"\n');
  await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /External.*SQLite/);
  await writeFile(join(root, 'config.toml'), 'model = "example"\n');
  await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
  const stale = await scanRoot(root, 'codex');
  await writeFile(current, jsonl(meta, codex({type: 'message', content: []})));
  assert.equal((await verifyCodexRewriteLayout(stale)).has(current), true);
});

test('Codex layout parses TOML keys and strings without unrelated config false positives', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-config-layout-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const inherited = process.env.CODEX_SQLITE_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  t.after(() => { if (inherited === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = inherited; });
  const path = join(root, 'config.toml');
  for (const config of [
    String.raw`"model" = "custom" # sqlite is mentioned in a comment`,
    String.raw`instructions = """
Use sqlite and \n in examples.
sqlite_home = \"not a config key\"
"""`,
    String.raw`'sqlite_home' = '.'`,
    String.raw`"sqlite\u005fhome" = '.'`,
    `[projects."/sqlite/project"]\nnotes = 'sqlite_home = /elsewhere'`,
    `[profiles.example]\nsqlite_home = '/elsewhere'`,
  ]) {
    await writeFile(path, config);
    const before = await readFile(path);
    await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
    assert.deepEqual(await readFile(path), before);
  }
  for (const key of ['sqlite_home', '"sqlite_home"', String.raw`"sqlite\u005fhome"`]) {
    await writeFile(path, `${key} = '/elsewhere'`);
    await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /External.*SQLite/);
  }
  for (const config of ['sqlite_home = ["/elsewhere"]', 'sqlite_home = ""', 'model = "synthetic-private-value']) {
    await writeFile(path, config);
    await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), error => {
      assert.match(String(error), /SQLite.*config/);
      assert.doesNotMatch(String(error), /synthetic-private-value/);
      return true;
    });
  }
  await writeFile(path, 'model = "custom"');
  process.env.CODEX_SQLITE_HOME = `  ${root}  `;
  await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
  process.env.CODEX_SQLITE_HOME = '  ';
  await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
  process.env.CODEX_SQLITE_HOME = '.';
  await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /working directory/);
  process.env.CODEX_SQLITE_HOME = '/elsewhere';
  await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /External.*SQLite/);
  await writeFile(path, 'sqlite_home = "."');
  await verifyCodexRewriteLayout(await scanRoot(root, 'codex')); // Config takes precedence over the environment.
  const stale = await scanRoot(root, 'codex');
  await writeFile(path, 'sqlite_home = "/elsewhere"');
  await assert.rejects(verifyCodexRewriteLayout(stale), /changed|config/);
});

test('Codex reasoning removal deletes only the encrypted member and preserves surrounding raw bytes', () => {
  const reasoning = {removeImages: false, compactTools: false, removeReasoning: true};
  const member = '"encrypted_content" : "密文\\u0061"';
  for (const [payload, expected] of [
    [`{ ${member}, "type":"reasoning", "id":9007199254740993123 }`, '{  "type":"reasoning", "id":9007199254740993123 }'],
    [`{ "type":"reasoning", ${member}, "signature":"keep" }`, '{ "type":"reasoning", "signature":"keep" }'],
    [`{ "type":"reasoning", "summary":[], ${member} }`, '{ "type":"reasoning", "summary":[] }'],
    ['{"type":"reasoning","encrypted_\\u0063ontent":"opaque","content":[]}', '{"type":"reasoning","content":[]}'],
  ]) {
    const prefix = jsonl(meta).toString(), line = `{"type":"response_item","payload":${payload},"ordinal":1}\r\n`;
    const input = Buffer.from(prefix + line), before = Buffer.from(input);
    const result = slimHistory(input, 'codex', reasoning);
    assert.equal(result.output?.toString(), prefix + line.replace(payload, expected));
    assert.equal(result.counts.reasoning, 1);
    assert.equal(result.savingsBytes.reasoning, input.length - result.output!.length);
    assert.deepEqual(input, before);
    assert.equal(slimHistory(result.output!, 'codex', reasoning).output, null);
    assert.equal(slimHistory(input, 'codex', tools).output, null);
  }
});

test('reasoning removal preserves compaction, nested history, unknown ciphertext and Claude thinking', () => {
  const options = {removeImages: false, compactTools: false, removeReasoning: true};
  const encrypted = {type: 'reasoning', encrypted_content: 'opaque', summary: [{type: 'summary_text', text: 'Keep'}], content: []};
  const input = jsonl(meta, codex({type: 'compaction', encrypted_content: 'opaque'}),
    {type: 'compacted', payload: {replacement_history: [encrypted]}},
    {type: 'event_msg', payload: encrypted}, codex({type: 'unknown', encrypted_content: 'opaque'}),
    ...[null, '', 123, {data: 'opaque'}].map(encrypted_content => codex({...encrypted, encrypted_content})));
  assert.equal(slimHistory(input, 'codex', options).output, null);
  assert.equal(slimHistory(jsonl(claude('assistant', [{type: 'thinking', thinking: 'Keep', encrypted_content: 'opaque', signature: 'signed'}])), 'claude', options).output, null);
});

test('old snapshots remove paired arrays only and preserve latest history, summaries and usage bytes', () => {
  const usage = {input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 3, total_tokens: 120};
  const usageRecord = {thread_id: '00000000-0000-0000-0000-000000000001', session_id: '00000000-0000-0000-0000-000000000002',
    turn_id: 'turn', root_turn_id: 'root', response_id: 'response', usage, turn_token_usage: usage, thread_token_usage: usage};
  for (const paginated of [false, true]) for (const eol of ['\n', '\r\n']) for (const ending of ['', eol]) {
    const rows = [meta, codex({type: 'message', role: 'user', content: [{type: 'input_text', text: 'Original question'}]}),
      snapshot(1), {type: 'token_usage_record', payload: usageRecord}, snapshot(2), snapshot(3),
      codex({type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Latest answer'}]})];
    const old = rows[2] as ReturnType<typeof snapshot>;
    Object.assign(old.payload, {latest_token_usage_record: usageRecord, compaction_response_id: 'response',
      resume_metadata: {multi_agent_version: 'v2', previous_turn_settings: {model: 'synthetic', comp_hash: 'hash'}}});
    if (paginated) rows[0] = {...meta, payload: {...meta.payload, history_mode: 'paginated'} as typeof meta.payload};
    const raw = rows.map((row, n) => JSON.stringify(paginated && n ? {...row, ordinal: n - 1} : row));
    const input = Buffer.from(raw.join(eol) + ending), before = Buffer.from(input);
    const result = slimHistory(input, 'codex', oldSnapshots);
    assert.ok(result.output);
    assert.deepEqual(result.counts, {images: 0, toolOutputs: 0, oldSnapshots: 2});
    assert.deepEqual(result.savingsBytes, {images: 0, toolOutputs: 0, oldSnapshots: input.length - result.output.length});
    const after = result.output.toString().split(eol);
    for (const n of [0, 1, 3, 5, 6]) assert.equal(after[n], raw[n]);
    for (const n of [2, 4]) {
      const expected = JSON.parse(raw[n]);
      delete expected.payload.replacement_history; delete expected.payload.replacement_history_metadata;
      assert.equal(after[n], JSON.stringify(expected));
    }
    assert.deepEqual(input, before);
    assert.equal(slimHistory(result.output, 'codex', oldSnapshots).output, null);
    assert.equal(slimHistory(input, 'codex', {removeImages: false, compactTools: false}).output, null);
  }
});

test('paired snapshot removal preserves raw spans for every member position and absent or null metadata', () => {
  const history = '"replacement_history" : []', metadata = '"replacement_history_metadata" : []';
  const rest = '"message" : "Keep \\u0061", "window_number":1';
  for (const [payload, expected] of [
    [`{${history}, ${metadata}, ${rest}}`, `{  ${rest}}`],
    [`{${rest}, ${history}, ${metadata}}`, `{${rest}}`],
    [`{${history}, ${rest}, ${metadata}}`, `{ ${rest}}`],
    [`{${metadata}, ${rest}, ${history}}`, `{ ${rest}}`],
    [`{${rest}, ${metadata}, ${history}}`, `{${rest}}`],
    [`{${history}, ${rest}}`, `{ ${rest}}`],
    [`{${history}, "replacement_history_metadata":null, ${rest}}`, `{  ${rest}}`],
  ]) {
    const prefix = jsonl(meta).toString(), suffix = jsonl(snapshot(2)).toString();
    const row = `{"type":"compacted","payload":${payload}}\r\n`;
    const input = Buffer.from(prefix + row + suffix);
    const result = slimHistory(input, 'codex', oldSnapshots);
    assert.equal(result.output?.toString(), prefix + row.replace(payload, expected) + suffix);
    assert.equal(result.savingsBytes.oldSnapshots, input.length - result.output!.length);
  }
});

test('latest empty checkpoint is preserved and old-snapshot cleanup composes with other operations', () => {
  const latest = {type: 'compacted', payload: {message: 'Latest empty', window_number: 2, replacement_history: [], replacement_history_metadata: []}};
  const input = jsonl(meta, snapshot(1), latest);
  assert.deepEqual(JSON.parse(slimHistory(input, 'codex', oldSnapshots).output!.toString().trim().split('\n').at(-1)!), latest);
  for (const rows of [[meta], [meta, latest], [meta, {type: 'compacted', payload: {message: 'Only summary'}}]])
    assert.equal(slimHistory(jsonl(...rows), 'codex', oldSnapshots).output, null);
  assert.equal(slimHistory(jsonl(claude('user', ['Keep']), snapshot(1), snapshot(2)), 'claude', oldSnapshots).output, null);
  const reasoning = {type: 'reasoning', summary: [{type: 'summary_text', text: 'Keep'}], encrypted_content: 'opaque'};
  const message = {type: 'message', role: 'user', content: [{type: 'input_image', image_url: 'data:image/png;base64,' + data}]};
  const checkpoint = {type: 'compacted', payload: {message: 'Keep latest', window_number: 2, replacement_history: [reasoning, message]}};
  const combined = {...oldSnapshots, removeImages: true, removeReasoning: true};
  const source = jsonl(meta, snapshot(1), checkpoint, codex(reasoning), codex(message));
  const result = slimHistory(source, 'codex', combined);
  assert.deepEqual(result.counts, {images: 1, toolOutputs: 0, reasoning: 1, oldSnapshots: 1});
  assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), source.length - result.output!.length);
  assert.equal(result.output!.toString().split('\n')[2], JSON.stringify(checkpoint));
});

test('supported snapshot tools and metadata preserve the latest row independently of version', () => {
  const history = [
    {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text: 'Keep', annotations: [], logprobs: []}]},
    {type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'function', encrypted_function_args: ['opaque']},
    {type: 'function_call_output', call_id: 'function', output: 'Keep output'},
    {type: 'custom_tool_call', name: 'apply_patch', input: 'patch', call_id: 'custom'},
    {type: 'custom_tool_call_output', call_id: 'custom', output: 'Keep result'},
    {type: 'compaction', encrypted_content: 'opaque'}, {type: 'context_compaction'},
  ];
  const latest = {type: 'compacted', payload: {message: 'Keep summary', window_number: 2, window_id: 'window',
    replacement_history: history, replacement_history_metadata: history.map(() => ({client_authored: false, guardian_sources: []})),
    resume_metadata: {multi_agent_version: 'v2', previous_turn_settings: {model: 'synthetic', realtime_active: false}}}};
  for (const cli_version of [undefined, '0.167.0', 'future-custom']) {
    const input = jsonl({...meta, payload: {...meta.payload, cli_version}}, snapshot(1),
      {type: 'compacted', payload: {message: 'Earlier summary without checkpoint'}}, latest);
    const result = slimHistory(input, 'codex', oldSnapshots);
    assert.equal(result.counts.oldSnapshots, 1);
    assert.equal(result.output!.toString().trim().split('\n').at(-1), JSON.stringify(latest));
  }
  for (const invalid of [
    {...history[1], arguments: {}}, {...history[1], encrypted_function_args: [1]},
    {...history[3], input: null}, {...history[5], encrypted_content: null},
  ]) {
    const payload = {...latest.payload, replacement_history: [invalid], replacement_history_metadata: [{}]};
    assert.throws(() => slimHistory(jsonl(meta, snapshot(1), {...latest, payload}), 'codex', oldSnapshots), /snapshots retained/);
  }
});

test('modern snapshot state is validated while only superseded replacement arrays are removed', () => {
  const older = modernSnapshot(1), latest = modernSnapshot(2);
  for (const eol of ['\n', '\r\n']) {
    const raw = [meta, older, latest].map(row => JSON.stringify(row));
    const input = Buffer.from(raw.join(eol));
    const result = slimHistory(input, 'codex', oldSnapshots);
    const expected = structuredClone(older) as any;
    delete expected.payload.replacement_history; delete expected.payload.replacement_history_metadata;
    assert.equal(result.output?.toString(), [raw[0], JSON.stringify(expected), raw[2]].join(eol));
    assert.equal(result.counts.oldSnapshots, 1);
    assert.equal(result.savingsBytes.oldSnapshots, input.length - result.output!.length);
    assert.equal(slimHistory(result.output!, 'codex', oldSnapshots).output, null);
  }
  const minimal = {type: 'compacted', payload: {message: 'Legacy defaults', window_number: 3, replacement_history: [],
    retained_context: {verified_answers: [], incomplete: false}, guardian_history: [],
    mcp_resource_origins: {origins: [], turns: []}, resume_metadata: {dynamic_tools: null, turn_attribution: null,
      previous_turn_settings: {model: 'synthetic', cyber_access_program: null}}}};
  assert.equal(slimHistory(jsonl(meta, older, minimal), 'codex', oldSnapshots).counts.oldSnapshots, 1);
});

test('unknown or malformed modern state protects both older and latest snapshots and combined image cleanup', () => {
  const mutations: [string, unknown][] = [
    ['replacement_history.0.internal_chat_message_metadata_passthrough.future', true],
    ['replacement_history.0.internal_chat_message_metadata_passthrough.create_time', '123'],
    ['replacement_history.0.internal_chat_message_metadata_passthrough.content_item_metadata.0.provenance.type', 'future'],
    ['replacement_history.0.internal_chat_message_metadata_passthrough.content_item_metadata.5.provenance.from_additional_requirements', null],
    ['replacement_history.0.internal_chat_message_metadata_passthrough.executed_tool_calls.0.tool_result_sources.0.id', 1],
    ['replacement_history.0.content.3.audio_url', null],
    ['replacement_history.2.content.1.encrypted_content', false],
    ['replacement_history.3.output.3', {type: 'input_audio', file_id: 'unsupported'}],
    ['replacement_history.4.call_id', null],
    ['replacement_history.4.namespace', 'unsupported'],
    ['replacement_history.5.tools', {}],
    ['replacement_history_metadata.0.guardian_sources.0.id.role', 'developer'],
    ['replacement_history_metadata.0.retained_source.complete', 'true'],
    ['replacement_history_metadata.0.mcp_attribution.status', 'future'],
    ['replacement_history_metadata.0.mcp_attribution.sources.0.first_turn_id', 1],
    ['replacement_history_metadata.0.sender_user_messages.text', null],
    ['guardian_history.0.guardian_metadata.future', true],
    ['guardian_history.1.type', 'future'],
    ['retained_context.verified_answers.0.questions.0.answer', null],
    ['retained_context.user_messages.0.origin', null],
    ['retained_context.assistant_messages.0.phase', 'future'],
    ['retained_context.sender_deliveries.0.order', -1],
    ['retained_context.next_order', 0.5],
    ['mcp_resource_origins.origins.0.ambiguous_account', 0],
    ['mcp_resource_origins.turns', [1]],
    ['resume_metadata.dynamic_tools.thread_id', 'invalid'],
    ['resume_metadata.dynamic_tools.tools.0.inputSchema', undefined],
    ['resume_metadata.dynamic_tools.tools.0.deferLoading', null],
    ['resume_metadata.dynamic_tools.tools.1.tools.0.type', 'namespace'],
    ['resume_metadata.turn_attribution.initiating_agent_path', '/root/root'],
    ['resume_metadata.turn_attribution.initiating_agent_path', '/root/worker/'],
    ['resume_metadata.previous_turn_settings.cyber_access_program', 'future'],
  ];
  for (const [path, value] of mutations) for (const position of [0, 1]) {
    const rows = [modernSnapshot(1), modernSnapshot(2)];
    const keys = path.split('.'), key = keys.pop()!;
    const parent = keys.reduce<any>((item, part) => item[part], rows[position].payload);
    parent[key] = value;
    const input = jsonl(meta, codex({type: 'message', role: 'user', content: [{type: 'input_image', image_url: 'data:image/png;base64,' + data}]}), ...rows);
    const before = Buffer.from(input);
    assert.throws(() => slimHistory(input, 'codex', {...oldSnapshots, removeImages: true}), /snapshots retained/, `${path} in snapshot ${position}`);
    assert.deepEqual(input, before);
  }
});

test('ambiguous snapshots and rollback histories cannot remove earlier checkpoints', () => {
  const latest = snapshot(2);
  for (const payload of [
    {...latest.payload, replacement_history: undefined}, {...latest.payload, replacement_history: null},
    {...latest.payload, replacement_history: {}}, {...latest.payload, replacement_history_metadata: []},
    {...latest.payload, replacement_history_metadata: [null]}, {...latest.payload, replacement_history_metadata: [{unknown: true}]},
    {...latest.payload, replacement_history: [{type: 'message', role: 'user'}]},
    {...latest.payload, replacement_history: [{type: 'unknown'}]},
    {...latest.payload, replacement_history: [{type: 'reasoning', summary: [{}]}]},
    {...latest.payload, replacement_history: [{type: 'function_call_output', call_id: 'id', output: [{type: 'text', text: 'Keep'}]}]},
    {...latest.payload, message: null}, {...latest.payload, window_id: 'id'},
    {...latest.payload, window_number: -1}, {...latest.payload, future: true},
    {...latest.payload, resume_metadata: {multi_agent_version: 'future'}},
    {...latest.payload, latest_token_usage_record: {}}, {...latest.payload, retained_context: {}},
  ]) assert.throws(() => slimHistory(jsonl(meta, snapshot(1), {...latest, payload}), 'codex', oldSnapshots), /snapshots retained/);
  for (const n of [1, 2, 3]) {
    const rows: unknown[] = [meta, snapshot(1), snapshot(2)];
    rows.splice(n, 0, {type: 'event_msg', payload: {type: 'thread_rolled_back', num_turns: 1}});
    assert.throws(() => slimHistory(jsonl(...rows), 'codex', oldSnapshots), /rollback/);
  }
  assert.throws(() => slimHistory(jsonl(meta, {...snapshot(1), future: true}, latest), 'codex', oldSnapshots), /snapshots retained/);
});
