import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants, zstdCompressSync } from 'node:zlib';
import { decodeHistory, slimStoredHistory } from '../src/history-codec.ts';
import { slimHistory, MAX_HISTORY_BYTES, MAX_CODEX_HISTORY_BYTES, historyByteLimit } from '../src/slim.ts';

const options = {removeImages: true, compactTools: false, removeReasoning: true};
const header = '{"type":"session_meta","payload":{"id":"codec","history_mode":"legacy"}}\r\n';
const image = JSON.stringify({type: 'response_item', payload: {type: 'message', content: [
  {type: 'input_image', image_url: 'data:image/png;base64,' + randomBytes(12000).toString('base64')},
]}}) + '\r\n';
const reasoning = JSON.stringify({type: 'response_item', payload: {type: 'reasoning', summary: ['保留'], encrypted_content: randomBytes(12000).toString('base64')}}) + '\n';
const tail = ' \t\r\n {"type":"future","payload":{"text":"保留","number":9007199254740993123}}';
const input = Buffer.from(header + image + reasoning + tail);

test('compressed slimming consumes every frame and accounts for stored savings exactly', async () => {
  const split = input.indexOf(Buffer.from('保留')) + 1;
  const stored = Buffer.concat([zstdCompressSync(''), zstdCompressSync(input.subarray(0, split)), zstdCompressSync(input.subarray(split)), zstdCompressSync('')]);
  const result = await slimStoredHistory(stored, 'codex', 'history.jsonl.zst', options);
  const plain = slimHistory(input, 'codex', options);
  assert.ok(result.output);
  assert.deepEqual(result.decodedInput, input);
  assert.deepEqual(result.decodedOutput, plain.output);
  assert.deepEqual(await decodeHistory(result.output, 'history.jsonl.zst'), plain.output);
  assert.ok(result.decodedOutput!.subarray(-Buffer.byteLength(tail)).equals(Buffer.from(tail)));
  assert.deepEqual(result.counts, plain.counts);
  assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), stored.length - result.output.length);
  assert.ok(result.savingsBytes.images > 0 && result.savingsBytes.reasoning! > 0);
  assert.deepEqual((await slimStoredHistory(stored, 'codex', 'history.jsonl.zst', options)).output, result.output);
  assert.equal((await slimStoredHistory(result.output, 'codex', 'history.jsonl.zst', options)).output, null);
  // Recovery supplies the original path even when the bytes come from 0.original.
  assert.deepEqual(await decodeHistory(stored, 'history.jsonl.zst'), input);
  assert.deepEqual((await slimStoredHistory(input, 'codex', 'history.jsonl', options)).output, plain.output);
});

test('compressed slimming rejects corrupt later frames, expansion, invalid text and cancellation', async () => {
  const stored = zstdCompressSync(input);
  for (const bytes of [Buffer.alloc(0), stored.subarray(0, stored.length - 2), Buffer.concat([stored, Buffer.from('invalid')]),
    Buffer.concat([stored, stored.subarray(0, stored.length - 2)])])
    await assert.rejects(slimStoredHistory(bytes, 'codex', 'history.jsonl.zst', options));
  await assert.rejects(decodeHistory(stored, 'history.jsonl.zst', input.length - 1), /size|limit/);
  for (const limit of [0, -1, NaN, Infinity, 1.5, MAX_CODEX_HISTORY_BYTES + 1])
    await assert.rejects(decodeHistory(stored, 'history.jsonl.zst', limit), /limit/);
  for (const bytes of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), input]), Buffer.concat([input, Buffer.from('\n{')])])
    await assert.rejects(slimStoredHistory(zstdCompressSync(bytes), 'codex', 'history.jsonl.zst', options));
  const controller = new AbortController(); controller.abort();
  for (const path of ['history.jsonl', 'history.jsonl.zst'])
    await assert.rejects(slimStoredHistory(stored, 'codex', path, options, controller.signal), {name: 'AbortError'});
});

test('compressed output that grows is retained with zero estimated savings', async () => {
  const content = Array.from({length: 1000}, (_, i) => `word${i % 31} ${i % 13} word${i % 21}`).join(' ');
  const source = Buffer.from(header + JSON.stringify({type: 'future', payload: {text: content}}) + '\n' +
    '{"type":"response_item","payload":{"type":"reasoning","encrypted_content":"x"}}\n');
  const stored = zstdCompressSync(source, {params: {[constants.ZSTD_c_compressionLevel]: 19}});
  const plain = slimHistory(source, 'codex', options).output!;
  assert.ok(plain.length < source.length);
  assert.ok(zstdCompressSync(plain, {params: {[constants.ZSTD_c_compressionLevel]: 3}}).length > stored.length);
  const result = await slimStoredHistory(stored, 'codex', 'history.jsonl.zst', options);
  assert.equal(result.output, null);
  assert.equal(result.decodedOutput, null);
  assert.ok(Object.values(result.counts).every(value => value === 0));
  assert.ok(Object.values(result.savingsBytes).every(value => value === 0));
  const noop = await slimStoredHistory(zstdCompressSync(header + tail), 'codex', 'history.jsonl.zst', options);
  assert.equal(noop.output, null);
  assert.equal(Object.values(noop.savingsBytes).reduce((a, b) => a + b, 0), 0);
});

test('Codex supports multiline histories above 64 MiB, retaining exact unchanged bytes', async () => {
  assert.equal(historyByteLimit('claude'), MAX_HISTORY_BYTES);
  assert.equal(historyByteLimit('codex'), MAX_CODEX_HISTORY_BYTES);
  const line = Buffer.from(JSON.stringify({type: 'future', payload: 'x'.repeat(1024 * 1024)}) + '\n');
  const prefix = Buffer.concat([Buffer.from(header), ...Array(65).fill(line)]);
  const source = Buffer.concat([prefix, Buffer.from(image)]);
  assert.ok(source.length > MAX_HISTORY_BYTES);
  for (const path of ['large.jsonl', 'large.jsonl.zst']) {
    const stored = path.endsWith('.zst') ? zstdCompressSync(source) : source;
    const result = await slimStoredHistory(stored, 'codex', path, options);
    assert.ok(result.output);
    assert.equal(result.counts.images, 1);
    assert.ok(result.decodedOutput!.subarray(0, prefix.length).equals(prefix));
    assert.equal(Object.values(result.savingsBytes).reduce((a, b) => a + b, 0), stored.length - result.output.length);
  }
  assert.throws(() => slimHistory(source, 'claude', options), /64 MiB/);
  assert.throws(() => slimHistory(Buffer.alloc(MAX_HISTORY_BYTES + 1, 32), 'codex', options), /line.*64 MiB/i);
});

test('unsafe old snapshots retain the whole compressed history despite removable images', async () => {
  const snapshot = {type: 'compacted', payload: {message: 'summary', replacement_history: []}};
  const source = Buffer.from(header + image + JSON.stringify(snapshot) + '\n' + JSON.stringify({type: 'compacted', payload: {message: 'incomplete'}}) + '\n');
  for (const path of ['history.jsonl', 'history.jsonl.zst'])
    await assert.rejects(slimStoredHistory(path.endsWith('.zst') ? zstdCompressSync(source) : source, 'codex', path,
      {...options, removeOldSnapshots: true}), /snapshots retained/);
});
