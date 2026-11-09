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
const matches = Array.from({length: 40}, (_, i) => `src/very-long-directory-name/example.ts:${i + 1}:matching source line ${i}`).join('\n');
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
    Buffer.from(good.toString().replace('2.1.319', 'unknown')), Buffer.from(good.toString().replace('"sessionId":"synthetic",', '')),
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
  await assert.rejects(verifyCodexRewriteLayout(stale), /changed/);
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
