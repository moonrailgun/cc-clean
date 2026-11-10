import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, mkdir, writeFile, appendFile, readFile, rm, link, rename, symlink, open, lstat, utimes, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { slimHistory, slimCodexItem } from '../src/slim.ts';
import { decodeHistory, slimStoredHistory } from '../src/history-codec.ts';
import { byteOffsetMap, projectionSnapshot, rewriteProjection, projectionHash, projectionState, applyProjection, readCodexHeader, verifyCodexRewriteLayout, verifyCodexDeletionHistories, decodeDuplicateHistory } from '../src/providers/codex-history.ts';
import { assertCodexDeleteCapabilities } from '../src/codex-delete.ts';
import { scanRoot } from '../src/scan.ts';
import * as shared from '../src/codex-shared.ts';
import type { Action } from '../src/clean.ts';
import { modernSnapshot } from './fixtures/codex-snapshot.ts';

const options = {removeImages: true, compactTools: true};
const url = 'data:image/png;base64,' + 'YQ=='.repeat(300);
const lines = (...rows: unknown[]) => Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const header = {type: 'session_meta', payload: {id: 'rollout', session_id: 'stable-thread', history_mode: 'paginated'}};
const item = {type: 'UserMessage', id: 'u', content: [{type: 'text', text: '保留', text_elements: []}, {type: 'image', url}]};
const input = lines(header, {ordinal: 0, type: 'event_msg', payload: {type: 'item_completed', item}}, {ordinal: 1, type: 'future', payload: {text: '保留'}});

test('duplicate comparison decodes every frame and preserves exact bytes across Unicode boundaries', async () => {
  const split = input.indexOf(Buffer.from('保留')) + 1;
  const compressed = Buffer.concat([zstdCompressSync(''), zstdCompressSync(input.subarray(0, split)),
    zstdCompressSync(input.subarray(split)), zstdCompressSync('')]);
  assert.deepEqual(await decodeDuplicateHistory(compressed, input.length), input);
  const changed = Buffer.from(input); changed[changed.indexOf(Buffer.from('保留'))] ^= 1;
  assert.equal((await decodeDuplicateHistory(zstdCompressSync(changed), input.length)).equals(input), false);
  const shorter = input.subarray(0, input.length - 1);
  assert.equal((await decodeDuplicateHistory(zstdCompressSync(shorter), input.length)).equals(input), false);
  await assert.rejects(decodeDuplicateHistory(Buffer.concat([compressed, zstdCompressSync('extra')]), input.length), /differs|size/);
});

test('duplicate decoding rejects damaged streams, output overruns and cancellation', async () => {
  const valid = zstdCompressSync(input);
  for (const data of [Buffer.alloc(0), Buffer.from('invalid frame'), valid.subarray(0, valid.length - 2),
    Buffer.concat([valid, Buffer.from('invalid trailing frame')]), Buffer.concat([valid, valid.subarray(0, valid.length - 2)])])
    await assert.rejects(decodeDuplicateHistory(data, input.length * 2));
  for (const limit of [0, -1, 0.5, NaN, Infinity, 64 * 1024 * 1024 + 1])
    await assert.rejects(decodeDuplicateHistory(valid, limit), /limit|empty/);
  await assert.rejects(decodeDuplicateHistory(valid, input.length - 1), /differs|size/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decodeDuplicateHistory(valid, input.length, controller.signal), {name: 'AbortError'});
});

test('paginated canonical events preserve ordinals and unknown bytes', () => {
  const result = slimHistory(input, 'codex', options);
  assert.ok(result.output);
  assert.deepEqual(result.savingsBytes, {images: input.length - result.output.length, toolOutputs: 0});
  const rows = result.output.toString().trim().split('\n').map(r => JSON.parse(r));
  assert.deepEqual(rows[0], header);
  assert.deepEqual(rows.map(r => r.ordinal), [undefined, 0, 1]);
  assert.deepEqual(rows[1].payload.item.content[1], {type: 'text', text: '[image removed]', text_elements: []});
  assert.ok(result.output.toString().endsWith(input.toString().split('\n').at(-2)! + '\n'));
  assert.equal(slimHistory(result.output, 'codex', options).output, null);
  for (const ordinal of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = lines(header, {ordinal: 0, type: 'future'}, {ordinal, type: 'future'});
    assert.throws(() => slimHistory(bad, 'codex', options), /ordinal/);
  }
});

test('cache and canonical item rewriting preserve unknown fields and successful command metadata', () => {
  const output = Array.from({length: 40}, (_, i) => `src/long-directory/file.ts:${i}:matching source line`).join('\n');
  for (const canonical of [true, false]) {
    const record = canonical ? {type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'rg foo'], aggregated_output: output, exit_code: 0}
      : {type: 'commandExecution', command: 'rg foo', aggregatedOutput: output, exitCode: 0};
    const raw = JSON.stringify({...record, id: 'cmd', status: 'completed', unknown: 'retain'}).replace('"unknown":"retain"', '"unknown":9007199254740993123');
    const after = slimCodexItem(raw, options);
    assert.match(after, /RTK output compacted/);
    assert.match(after, /9007199254740993123/);
    assert.equal(slimCodexItem(after, options), after);
    const history = lines(header, {ordinal: 0, type: 'event_msg', payload: {type: 'item_completed', item: JSON.parse(raw)}});
    const result = slimHistory(history, 'codex', options);
    assert.ok(result.output);
    assert.deepEqual(result.savingsBytes, {images: 0, toolOutputs: history.length - result.output.length});
    assert.equal(slimCodexItem(raw.replace('completed', 'failed'), options), raw.replace('completed', 'failed'));
  }
  const raw = JSON.stringify({...item, type: 'userMessage'});
  assert.doesNotMatch(slimCodexItem(raw, options), /base64/);
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
    CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_byte_offset INTEGER, rollout_end_byte_offset INTEGER, rollout_ordinal INTEGER, extra INTEGER, PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE TABLE thread_realtime_items(thread_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id,item_id));`);
  db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run('rollout', input.length, 2);
  const start = input.indexOf(10) + 1, end = input.indexOf(10, start) + 1;
  db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)').run('rollout', 'turn', start, end, 0, 9007199254740993123n);
  db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)').run('other', 'turn', 55, null, 2, 9);
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('rollout', 'turn', 'u', JSON.stringify({...item, type: 'userMessage'}));
  return db;
}

test('identical history bytes leave SQLite offsets, ordinals and cache text unchanged', () => {
  const db = fixture();
  try {
    const before = projectionSnapshot(db, 'rollout'), other = projectionSnapshot(db, 'other');
    const after = rewriteProjection(before, byteOffsetMap(input, input), {removeImages: false, compactTools: false});
    assert.deepEqual(after, structuredClone(before));
    assert.equal(projectionHash(after), projectionHash(before));
    applyProjection(db, before, after);
    assert.deepEqual(projectionSnapshot(db, 'rollout'), before);
    assert.deepEqual(projectionSnapshot(db, 'other'), other);
  } finally { db.close(); }
});

test('projection maps UTF-8 line boundaries and cached items without touching other threads', () => {
  const db = fixture();
  try {
    const output = slimHistory(input, 'codex', options).output!;
    const before = projectionSnapshot(db, 'rollout');
    const after = rewriteProjection(before, byteOffsetMap(input, output), options);
    assert.equal(after.thread_history_projection_state[0].next_rollout_byte_offset, BigInt(output.length));
    assert.equal(after.thread_turns[0].rollout_end_byte_offset, BigInt(output.indexOf(10, output.indexOf(10) + 1) + 1));
    assert.equal(after.thread_turns[0].extra, 9007199254740993123n);
    assert.doesNotMatch(String(after.thread_items[0].item_json), /base64/);
    assert.equal(db.prepare("SELECT rollout_byte_offset FROM thread_turns WHERE thread_id='other'").get()!.rollout_byte_offset, 55);
    assert.notEqual(projectionHash(before), projectionHash(after));
    assert.deepEqual(projectionSnapshot(db, 'rollout'), before, 'pure rewrite never writes SQLite');
    assert.deepEqual(rewriteProjection({thread_turns: [{rollout_byte_offset: null}]}, byteOffsetMap(input, output), options), {thread_turns: [{rollout_byte_offset: null}]});
    assert.throws(() => rewriteProjection({thread_turns: [{rollout_byte_offset: 3n}]}, byteOffsetMap(input, output), options), /boundary/);
  } finally { db.close(); }
});

test('structured tool images coordinate decoded offsets, cache preservation and recovery hashes', async () => {
  const source = lines(header,
    {ordinal: 0, type: 'response_item', payload: {type: 'function_call_output', call_id: 'tool', output: [{type: 'input_image', image_url: url}]}},
    {ordinal: 1, type: 'response_item', payload: {type: 'custom_tool_call_output', call_id: 'custom', output: [{type: 'input_image', image_url: url}]}},
    {ordinal: 2, type: 'future', payload: {text: 'Keep'}});
  for (const path of ['history.jsonl', 'history.jsonl.zst']) {
    const stored = path.endsWith('.zst') ? zstdCompressSync(source) : source;
    const result = await slimStoredHistory(stored, 'codex', path, options);
    assert.ok(result.output);
    assert.equal(result.counts.images, 2);
    const output = await decodeHistory(result.output, path), db = fixture();
    try {
      db.prepare('UPDATE thread_history_projection_state SET next_rollout_byte_offset=? WHERE thread_id=?').run(source.length, 'rollout');
      const start = source.indexOf(10) + 1, end = source.indexOf(10, start) + 1;
      db.prepare('UPDATE thread_turns SET rollout_byte_offset=?,rollout_end_byte_offset=? WHERE thread_id=?').run(start, end, 'rollout');
      // Tool text may quote data URLs; only recognized image blocks may be replaced.
      const cached = JSON.stringify({type: 'commandExecution', id: 'tool', status: 'completed', exitCode: 0, command: 'echo source', aggregatedOutput: url});
      db.prepare('UPDATE thread_items SET item_json=?').run(cached);
      db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?)').run('rollout', 'tool', cached);
      const before = projectionSnapshot(db, 'rollout'), other = projectionSnapshot(db, 'other');
      const after = rewriteProjection(before, byteOffsetMap(source, output), options);
      assert.equal(after.thread_history_projection_state[0].next_rollout_byte_offset, BigInt(output.length));
      assert.equal(after.thread_turns[0].rollout_end_byte_offset, BigInt(output.indexOf(10, start) + 1));
      assert.equal(after.thread_turns[0].extra, 9007199254740993123n);
      assert.equal(after.thread_items[0].item_json, cached);
      assert.equal(after.thread_realtime_items[0].item_json, cached);
      const receipt = {beforeHash: projectionHash(before), afterHash: projectionHash(after)};
      assert.equal(projectionState(projectionHash(before), receipt), 'before');
      db.exec('BEGIN'); applyProjection(db, before, after); db.exec('COMMIT');
      assert.equal(projectionState(projectionHash(projectionSnapshot(db, 'rollout')), receipt), 'after');
      assert.deepEqual(projectionSnapshot(db, 'other'), other);
    } finally { db.close(); }
  }
});

test('projection recovery distinguishes before, after, unchanged and conflicts', () => {
  assert.equal(projectionState('a', {beforeHash: 'a', afterHash: 'b'}), 'before');
  assert.equal(projectionState('b', {beforeHash: 'a', afterHash: 'b'}), 'after');
  assert.equal(projectionState('a', {beforeHash: 'a', afterHash: 'a'}), 'after');
  assert.throws(() => projectionState('c', {beforeHash: 'a', afterHash: 'b'}), /changed/);
});

for (const suffix of ['.jsonl', '.jsonl.zst']) test(`${suffix} home indexes converge from mixed commits without altering other threads`, async () => {
  const homes = [fixture(), fixture()];
  try {
    const path = 'history' + suffix, stored = suffix.endsWith('.zst') ? zstdCompressSync(input) : input;
    const result = await slimStoredHistory(stored, 'codex', path, options);
    assert.ok(result.output);
    // Backups have no extension; recovery must use the original history path.
    const decodedInput = await decodeHistory(stored, path), output = await decodeHistory(result.output, path);
    assert.deepEqual(decodedInput, input);
    if (suffix.endsWith('.zst')) assert.notEqual(output.length, result.output.length);
    const snapshots = homes.map(db => projectionSnapshot(db, 'rollout'));
    const other = homes.map(db => projectionSnapshot(db, 'other'));
    const rewritten = snapshots.map(before => rewriteProjection(before, byteOffsetMap(decodedInput, output), options));
    for (const after of rewritten) {
      assert.equal(after.thread_history_projection_state[0].next_rollout_byte_offset, BigInt(output.length));
      assert.equal(after.thread_turns[0].extra, 9007199254740993123n);
      assert.doesNotMatch(String(after.thread_items[0].item_json), /base64/);
    }
    const receipts = snapshots.map((before, i) => ({beforeHash: projectionHash(before), afterHash: projectionHash(rewritten[i])}));
    applyProjection(homes[0], snapshots[0], rewritten[0]);
    assert.deepEqual(homes.map((db, i) => projectionState(projectionHash(projectionSnapshot(db, 'rollout')), receipts[i])), ['after', 'before']);
    for (let pass = 0; pass < 2; pass++) for (const [i, db] of homes.entries()) {
      const before = projectionSnapshot(db, 'rollout');
      if (projectionState(projectionHash(before), receipts[i]) === 'before') {
        db.exec('BEGIN'); applyProjection(db, before, rewriteProjection(before, byteOffsetMap(decodedInput, output), options)); db.exec('COMMIT');
      }
      assert.equal(projectionHash(projectionSnapshot(db, 'rollout')), receipts[i].afterHash);
      assert.deepEqual(projectionSnapshot(db, 'other'), other[i]);
    }
    homes[1].exec("UPDATE thread_turns SET rollout_end_byte_offset=7 WHERE thread_id='rollout'");
    assert.throws(() => projectionState(projectionHash(projectionSnapshot(homes[1], 'rollout')), receipts[1]), /changed/);
    assert.equal(projectionHash(projectionSnapshot(homes[0], 'rollout')), receipts[0].afterHash);
  } finally {for (const db of homes) db.close();}
});

test('plain and zstd old snapshots coordinate decoded offsets and recovery hashes while preserving caches and ordinals', async () => {
  const opts = {removeImages: false, compactTools: false, removeOldSnapshots: true};
  const snapshot = {type: 'compacted', payload: {message: 'Keep summary', window_number: 1,
    replacement_history: [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'Old context'}]}],
    replacement_history_metadata: [{}]}};
  for (const older of [snapshot, modernSnapshot(1)]) for (const path of ['history.jsonl', 'history.jsonl.zst']) {
    const latest = {...older, ordinal: 2, payload: {...older.payload, window_number: 2}};
    const superseded = {...older, ordinal: 0, payload: {...older.payload,
      replacement_history: [...older.payload.replacement_history, {type: 'message', role: 'user',
        content: [{type: 'input_text', text: Array.from({length: 50}, (_, i) => `Superseded context ${i}`).join('\n')}]}],
      replacement_history_metadata: [...older.payload.replacement_history_metadata, {}]}};
    const source = lines(header, superseded, {ordinal: 1, type: 'event_msg', payload: {type: 'item_completed', item}}, latest);
    const stored = path.endsWith('.zst') ? zstdCompressSync(source) : source;
    const result = await slimStoredHistory(stored, 'codex', path, opts);
    assert.ok(result.output);
    assert.equal(result.counts.oldSnapshots, 1);
    assert.equal(result.savingsBytes.oldSnapshots, stored.length - result.output.length);
    const output = await decodeHistory(result.output, path);
    assert.deepEqual(result.decodedInput, source);
    assert.deepEqual(result.decodedOutput, output);
    assert.deepEqual(output.subarray(output.length - lines(latest).length), lines(latest));
    const start = lines(header, superseded).length;
    const db = fixture();
    try {
      db.prepare('UPDATE thread_history_projection_state SET next_rollout_byte_offset=?, next_rollout_ordinal=3').run(source.length);
      db.prepare("UPDATE thread_turns SET rollout_byte_offset=?, rollout_end_byte_offset=?, rollout_ordinal=1 WHERE thread_id='rollout'").run(start, source.length);
      db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?)').run('rollout', 'u', JSON.stringify(item));
      const before = projectionSnapshot(db, 'rollout'), other = projectionSnapshot(db, 'other');
      const after = rewriteProjection(before, byteOffsetMap(source, output), opts);
      assert.equal(after.thread_history_projection_state[0].next_rollout_byte_offset, BigInt(output.length));
      assert.equal(after.thread_turns[0].rollout_byte_offset, BigInt(start - (source.length - output.length)));
      assert.equal(after.thread_turns[0].rollout_end_byte_offset, BigInt(output.length));
      assert.equal(after.thread_turns[0].rollout_ordinal, 1n);
      assert.equal(after.thread_history_projection_state[0].next_rollout_ordinal, 3n);
      assert.deepEqual(after.thread_items, structuredClone(before.thread_items));
      assert.deepEqual(after.thread_realtime_items, structuredClone(before.thread_realtime_items));
      const receipt = {beforeHash: projectionHash(before), afterHash: projectionHash(after)};
      assert.notEqual(receipt.beforeHash, receipt.afterHash);
      assert.equal(projectionState(projectionHash(projectionSnapshot(db, 'rollout')), receipt), 'before');
      db.exec('BEGIN'); applyProjection(db, before, after); db.exec('ROLLBACK');
      assert.deepEqual(projectionSnapshot(db, 'rollout'), before);
      db.exec('BEGIN'); applyProjection(db, before, after); db.exec('COMMIT');
      assert.equal(projectionState(projectionHash(projectionSnapshot(db, 'rollout')), receipt), 'after');
      assert.deepEqual(projectionSnapshot(db, 'other'), other);
    } finally { db.close(); }
  }
});

test('in-memory projection updates commit or roll back as a unit and preserve other threads', () => {
  const db = fixture();
  try {
    // The native schema includes this delete-only trigger; it does not affect updates.
    db.exec(`CREATE TRIGGER thread_realtime_items_projection_cleanup AFTER DELETE ON thread_history_projection_state
      BEGIN DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id; END;
      ALTER TABLE thread_turns ADD COLUMN root_turn_id TEXT;
      UPDATE thread_turns SET root_turn_id = 'root-turn';`);
    db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?)').run('rollout', 'u', JSON.stringify({...item, type: 'userMessage'}));
    const before = projectionSnapshot(db, 'rollout'), other = projectionSnapshot(db, 'other');
    const output = slimHistory(input, 'codex', options).output!;
    const after = rewriteProjection(before, byteOffsetMap(input, output), options);
    db.exec('BEGIN'); applyProjection(db, before, after);
    assert.equal(projectionHash(projectionSnapshot(db, 'rollout')), projectionHash(after));
    db.exec('ROLLBACK');
    assert.deepEqual(projectionSnapshot(db, 'rollout'), before);
    db.exec('BEGIN'); applyProjection(db, before, after); db.exec('COMMIT');
    assert.equal(projectionHash(projectionSnapshot(db, 'rollout')), projectionHash(after));
    assert.deepEqual(projectionSnapshot(db, 'other'), other);
    assert.equal(after.thread_turns[0].root_turn_id, 'root-turn');
    assert.doesNotMatch(String(after.thread_realtime_items[0].item_json), /base64/);
    const invalid = structuredClone(after); invalid.thread_items[0].item_id = 'different';
    assert.throws(() => applyProjection(db, after, invalid), /Unexpected/);
  } finally { db.close(); }
});

test('reasoning-only and combined slimming synchronize offsets and caches in memory', () => {
  const reasoning = {type: 'response_item', payload: {type: 'reasoning', id: 'r', summary: [{text: '保留'}], encrypted_content: 'cipher'.repeat(300)}};
  const command = {type: 'CommandExecution', id: 'cmd', status: 'completed', command: ['/bin/zsh', '-lc', 'rg foo'], exit_code: 0,
    aggregated_output: Array.from({length: 40}, (_, i) => `src/long-directory/file.ts:${i}:matching source line`).join('\n')};
  const rows = [header, reasoning, {ordinal: 0, type: 'event_msg', payload: {type: 'item_completed', item}},
    {ordinal: 1, type: 'event_msg', payload: {type: 'item_completed', item: command}}, {ordinal: 2, type: 'future', payload: {text: '保留'}}];
  const history = lines(...rows), start = lines(...rows.slice(0, 2)).length;
  const cachedReasoning = '{ "type": "reasoning", "id": "r", "summary": ["保留"], "content": [], "future": 9007199254740993123 }';
  for (const combined of [false, true]) {
    const opts = {removeImages: combined, compactTools: combined, removeReasoning: true};
    const db = fixture();
    try {
      db.prepare('UPDATE thread_history_projection_state SET next_rollout_byte_offset=?, next_rollout_ordinal=3 WHERE thread_id=?').run(history.length, 'rollout');
      db.prepare('UPDATE thread_turns SET rollout_byte_offset=?, rollout_end_byte_offset=? WHERE thread_id=?').run(start, history.length, 'rollout');
      db.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('rollout', 'turn', 'r', cachedReasoning);
      db.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('rollout', 'turn', 'cmd', JSON.stringify(command));
      db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?)').run('rollout', 'r', cachedReasoning);
      const before = projectionSnapshot(db, 'rollout'), other = projectionSnapshot(db, 'other');
      const result = slimHistory(history, 'codex', opts), output = result.output!;
      assert.ok(output);
      assert.deepEqual(result.counts, {images: combined ? 1 : 0, toolOutputs: combined ? 1 : 0, reasoning: 1});
      assert.equal(Object.values(result.savingsBytes).reduce((sum, value) => sum + value, 0), history.length - output.length);
      assert.doesNotMatch(output.toString(), /encrypted_content/);
      const after = rewriteProjection(before, byteOffsetMap(history, output), opts);
      assert.equal(after.thread_history_projection_state[0].next_rollout_byte_offset, BigInt(output.length));
      assert.equal(after.thread_turns[0].rollout_byte_offset, BigInt(start - result.savingsBytes.reasoning!));
      assert.equal(after.thread_turns[0].rollout_end_byte_offset, BigInt(output.length));
      assert.equal(after.thread_turns[0].extra, 9007199254740993123n);
      assert.equal(after.thread_turns[0].rollout_ordinal, before.thread_turns[0].rollout_ordinal);
      assert.equal(after.thread_history_projection_state[0].next_rollout_ordinal, 3n);
      assert.equal(after.thread_items.find(row => row.item_id === 'r')!.item_json, cachedReasoning);
      assert.equal(after.thread_realtime_items[0].item_json, cachedReasoning);
      if (combined) {
        assert.doesNotMatch(String(after.thread_items.find(row => row.item_id === 'u')!.item_json), /base64/);
        assert.match(String(after.thread_items.find(row => row.item_id === 'cmd')!.item_json), /RTK output compacted/);
      } else {
        assert.equal(projectionHash(after.thread_items), projectionHash(before.thread_items));
      }
      db.exec('BEGIN'); applyProjection(db, before, after); db.exec('ROLLBACK');
      assert.deepEqual(projectionSnapshot(db, 'rollout'), before);
      db.exec('BEGIN'); applyProjection(db, before, after); db.exec('COMMIT');
      assert.equal(projectionHash(projectionSnapshot(db, 'rollout')), projectionHash(after));
      assert.deepEqual(projectionSnapshot(db, 'other'), other);
    } finally { db.close(); }
  }
});

async function layout(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-header-')));
  const inherited = process.env.CODEX_SQLITE_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  t.after(async () => {
    if (inherited === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = inherited;
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(join(root, 'sessions')); await mkdir(join(root, 'archived_sessions'));
  const put = async (name: string, meta: Record<string, unknown>) => {
    const path = join(root, name), data = lines({type: 'session_meta', payload: meta}, {type: 'future', text: '保留'.repeat(10000)});
    await writeFile(path, name.endsWith('.zst') ? zstdCompressSync(data) : data);
    return path;
  };
  return {root, put};
}

for (const suffix of ['.jsonl', '.jsonl.zst']) test(`${suffix} shared layout accepts aliases and retains independent copies and references`, async t => {
  const primary = await layout(t), other = await layout(t);
  const plain = await primary.put('sessions/one' + suffix, {id: 'one', session_id: 'stable'});
  const alias = join(other.root, 'sessions/one' + suffix); await link(plain, alias);
  const inspect = async (duplicates = false, coordinated: string[][] = []) => {
    const inventories = await Promise.all([primary, other].map(home => scanRoot(home.root, 'codex')));
    return verifyCodexRewriteLayout(inventories[0], undefined, duplicates, inventories.slice(1), coordinated);
  };
  assert.equal((await inspect()).size, 0);
  await assert.rejects(verifyCodexDeletionHistories(await scanRoot(primary.root, 'codex'), new Set(['stable']), new Set([plain])), /linked/);
  const copy = await other.put('archived_sessions/copy.jsonl', {id: 'one'});
  for (const path of [plain, alias, copy]) assert.match((await inspect()).get(path)!, /copies/);
  await rm(copy);
  const dependent = await other.put('archived_sessions/dependent.jsonl', {id: 'dependent', history_base: {thread_id: 'stable', end_byte_offset: 100}});
  for (const path of [plain, alias]) assert.match((await inspect()).get(path)!, /referenced/);
  await rm(dependent);
  const zipped = await primary.put('sessions/one' + (suffix.endsWith('.zst') ? '.jsonl' : '.jsonl.zst'), {id: 'one', session_id: 'stable'});
  assert.equal((await inspect(true)).size, 0, 'missing compressed alias can be coordinated');
  for (const path of [plain, alias, zipped]) assert.ok((await inspect()).has(path));
  await rm(zipped);
  const linked = join(other.root, 'sessions/unknown.jsonl'); await symlink(plain, linked);
  await assert.rejects(inspect(), /Linked/); await rm(linked);
  const invs = await Promise.all([primary, other].map(home => scanRoot(home.root, 'codex')));
  await assert.rejects(verifyCodexRewriteLayout(invs[0], undefined, false, [{...invs[1], complete: false}]), /complete/);
  // Model a partially replaced alias with header-only fixtures; no cleanup/recovery executor.
  await rm(alias); await other.put('sessions/one' + suffix, {id: 'one', session_id: 'stable'});
  assert.match((await inspect()).get(plain)!, /copies/);
  assert.equal((await inspect(false, [[plain, alias]])).size, 0);
});

test('per-action dependency inspection catches forks created after the batch scan', async t => {
  for (const coordinated of [false, true]) for (const duplicate of [false, true]) {
    const primary = await layout(t), other = await layout(t);
    const plain = await primary.put('sessions/source.jsonl', {id: 'source', session_id: 'stable'});
    if (coordinated) await link(plain, join(other.root, 'sessions/source.jsonl'));
    if (duplicate) await primary.put('sessions/source.jsonl.zst', {id: 'source', session_id: 'stable'});
    const inventories = await Promise.all([primary, other].map(h => scanRoot(h.root, 'codex')));
    const files = [inventories[0].files.find(f => f.path === plain)!,
      ...duplicate ? [inventories[0].files.find(f => f.path === plain + '.zst')!] : []];
    const a = {kind: duplicate ? 'deduplicate-history' : 'slim-history', files,
      ...coordinated ? {codexShared: {...shared.sharedHistoryGroups(files, inventories),
        homes: inventories.map(i => ({root: i.root, dev: 1, ino: 1, codexProjection: []}))}} : {},
    } as Action;
    const cached = await verifyCodexRewriteLayout(inventories[0], undefined, duplicate, coordinated ? inventories.slice(1) : []);
    assert.equal(cached.has(plain), false);
    await shared.verifyHistoryDependencies(a, primary.root);
    await (coordinated ? other : primary).put('archived_sessions/late-fork.jsonl',
      {id: 'fork', history_base: {thread_id: 'stable', end_byte_offset: files[0].size}});
    assert.equal(cached.has(plain), false, 'a cached batch result cannot see the late fork');
    await assert.rejects(shared.verifyHistoryDependencies(a, primary.root), /referenced/);
    const fresh = (await scanRoot(primary.root, 'codex')).files.find(f => f.path === plain)!;
    assert.deepEqual(fresh, files[0], 'the source itself need not change when another rollout references it');
  }
});

test('dedup layout does not confuse paired names with an extra alias of a different basename', async t => {
  const primary = await layout(t), other = await layout(t);
  const plain = await primary.put('sessions/one.jsonl', {id: 'one'});
  const zipped = await primary.put('sessions/one.jsonl.zst', {id: 'one'});
  const wrong = join(other.root, 'sessions/two.jsonl.zst'); await link(zipped, wrong);
  const invs = await Promise.all([primary, other].map(home => scanRoot(home.root, 'codex')));
  const blocked = await verifyCodexRewriteLayout(invs[0], undefined, true, invs.slice(1));
  for (const path of [plain, plain + '.zst', wrong]) assert.match(blocked.get(path)!, /copies/);
});

test('duplicate layout allows only the same-basename pair and retains additional identity copies', async t => {
  const {root, put} = await layout(t);
  for (const meta of [{id: 'one'}, {id: 'one', session_id: 'stable'}, {id: 'one', session_id: 'one'}]) {
    const plain = await put('sessions/one.jsonl', meta), zipped = await put('sessions/one.jsonl.zst', meta);
    const inventory = await scanRoot(root, 'codex');
    const allowed = await verifyCodexRewriteLayout(inventory, undefined, true);
    assert.equal(allowed.has(plain), false); assert.equal(allowed.has(zipped), false);
    const rewrite = await verifyCodexRewriteLayout(inventory);
    assert.equal(rewrite.has(plain), true); assert.equal(rewrite.has(zipped), true);
    for (const thirdMeta of [{id: 'one'}, {id: 'third', session_id: meta.session_id ?? meta.id}]) {
      const third = await put('archived_sessions/third.jsonl.zst', thirdMeta);
      const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'), undefined, true);
      for (const path of [plain, zipped, third]) assert.match(blocked.get(path)!, /copies|referenced/);
      await rm(third);
    }
  }
});

test('duplicate layout retains shared, hardlinked and unknown-format pairs', async t => {
  const {root, put} = await layout(t);
  const plain = await put('sessions/one.jsonl', {id: 'one', session_id: 'stable'});
  const zipped = await put('sessions/one.jsonl.zst', {id: 'one', session_id: 'stable'});
  for (const id of ['one', 'stable']) {
    const dependent = await put('archived_sessions/dependent.jsonl.zst', {id: 'dependent', history_base: {thread_id: id, end_byte_offset: 100}});
    const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'), undefined, true);
    for (const path of [plain, zipped]) assert.match(blocked.get(path)!, /referenced/);
    await rm(dependent);
  }
  for (const path of [plain, zipped]) {
    const alias = join(root, 'linked-copy'); await link(path, alias);
    const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'), undefined, true);
    assert.match(blocked.get(path)!, /hard links/);
    await rm(alias);
  }
  for (const meta of [{id: 'one', history_mode: 'unknown'}, {id: 'one', imported: true}, {id: 'one', attached_thread: 'other'}]) {
    await put('sessions/one.jsonl', meta); await put('sessions/one.jsonl.zst', meta);
    const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'), undefined, true);
    assert.equal(blocked.has(plain), true); assert.equal(blocked.has(zipped), true);
  }
});

test('header inspection supports plain and compressed layouts and rejects stale snapshots', async t => {
  const {root, put} = await layout(t);
  const plain = await put('sessions/one.jsonl', {id: 'one', history_mode: 'paginated'});
  await put('archived_sessions/two.jsonl.zst', {id: 'two'});
  const inv = await scanRoot(root, 'codex');
  for (const file of inv.files) {
    const original = await readFile(file.path);
    assert.ok((await readCodexHeader(file)).payload.id);
    assert.deepEqual(await readFile(file.path), original);
  }
  await writeFile(plain, lines(header));
  await assert.rejects(readCodexHeader(inv.files.find(f => f.path === plain)!), /changed/);
});

test('header inspection reads concatenated zstd frames across empty, UTF-8 and newline boundaries', async t => {
  const {root} = await layout(t);
  const row = {type: 'session_meta', payload: {id: 'framed', cwd: '/保留'}}, data = lines(row);
  const split = data.indexOf(Buffer.from('保留')) + 1;
  for (const parts of [[Buffer.alloc(0), data], [data.subarray(0, split), data.subarray(split)],
    [data.subarray(0, -1), Buffer.from('\n')], [Buffer.alloc(0), data.subarray(0, -1)]]) {
    const stored = Buffer.concat(parts.map(part => zstdCompressSync(part)));
    for (const name of ['framed.jsonl.zst', 'extensionless']) {
      const path = join(root, name); await writeFile(path, stored);
      assert.deepEqual(await readCodexHeader({...await lstat(path), path}, undefined, {detectCompression: true}), row);
      assert.deepEqual(await readFile(path), stored);
    }
  }
});

test('multi-frame header inspection enforces the combined limit and rejects damaged input and cancellation', async t => {
  const {root} = await layout(t), path = join(root, 'framed.jsonl.zst');
  const first = zstdCompressSync(lines(header).subarray(0, -1));
  const newline = zstdCompressSync('\n');
  for (const stored of [Buffer.concat([first, Buffer.from('invalid frame')]),
    Buffer.concat([first, newline.subarray(0, -1)]),
    Buffer.concat([zstdCompressSync(''), zstdCompressSync('')])]) {
    await writeFile(path, stored);
    await assert.rejects(readCodexHeader({...await lstat(path), path}));
  }
  const large = lines({type: 'session_meta', payload: {id: 'large', cwd: 'x'.repeat(1024 * 1024)}});
  await writeFile(path, Buffer.concat([zstdCompressSync(large.subarray(0, 600000)), zstdCompressSync(large.subarray(600000))]));
  await assert.rejects(readCodexHeader({...await lstat(path), path}), /exceeds 1 MiB/);
  await writeFile(path, Buffer.concat([zstdCompressSync(''), zstdCompressSync(lines(header))]));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readCodexHeader({...await lstat(path), path}, controller.signal), {name: 'AbortError'});
});

test('header inspection stops at the first complete line without decoding later frames', async t => {
  const {root} = await layout(t), path = join(root, 'header-only.jsonl.zst');
  await writeFile(path, Buffer.concat([zstdCompressSync(''), zstdCompressSync(lines(header)), Buffer.from('unread body')]));
  assert.deepEqual(await readCodexHeader({...await lstat(path), path}), header);
});

test('multi-frame reference inspection preserves inbound protection without blocking independent histories', async t => {
  const {root, put} = await layout(t);
  const independent = await put('sessions/independent.jsonl', {id: 'independent'});
  const source = await put('sessions/source.jsonl', {id: 'source', session_id: 'stable'});
  const path = join(root, 'sessions/framed.jsonl.zst');
  const data = lines({type: 'session_meta', payload: {id: 'framed', history_base: {thread_id: 'stable', end_byte_offset: 99}}});
  await writeFile(path, Buffer.concat([zstdCompressSync(''), zstdCompressSync(data.subarray(0, 32)), zstdCompressSync(data.subarray(32))]));
  const inv = await scanRoot(root, 'codex');
  for (const duplicates of [false, true]) {
    const blocked = await verifyCodexRewriteLayout(inv, undefined, duplicates);
    assert.equal(blocked.has(independent), false);
    assert.match(blocked.get(source)!, /referenced/);
  }
});

test('unrelated compressed and hardlinked histories do not block an independent paginated target', async t => {
  const {root, put} = await layout(t);
  const independent = await put('sessions/independent.jsonl', {id: 'independent', history_mode: 'paginated'});
  const zipped = await put('archived_sessions/zipped.jsonl.zst', {id: 'zipped'});
  const linked = await put('sessions/linked.jsonl', {id: 'linked'});
  await link(linked, join(root, 'linked-copy'));
  await writeFile(join(root, 'thread_history_1.sqlite'), 'layout-only sentinel');
  const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
  assert.equal(blocked.has(independent), false);
  assert.equal(blocked.has(zipped), false);
  assert.match(blocked.get(linked)!, /hard links/);
});

test('a growing unrelated rollout retains its inbound references without blocking independent history', async t => {
  const {root, put} = await layout(t);
  const source = await put('sessions/source.jsonl', {id: 'source', session_id: 'stable'});
  const independent = await put('sessions/independent.jsonl', {id: 'independent'});
  const active = await put('sessions/active.jsonl', {id: 'active', history_base: {thread_id: 'stable', end_byte_offset: 99}});
  const inv = await scanRoot(root, 'codex');
  await appendFile(active, lines({type: 'event_msg', payload: {type: 'task_started'}}));
  const blocked = await verifyCodexRewriteLayout(inv);
  assert.equal(blocked.has(independent), false);
  assert.match(blocked.get(source)!, /referenced/);
  assert.equal(blocked.has(active), true);
  const duplicateBlocked = await verifyCodexRewriteLayout(inv, undefined, true);
  assert.equal(duplicateBlocked.has(independent), false);
  assert.equal(duplicateBlocked.has(active), true);
  await assert.rejects(readCodexHeader(inv.files.find(f => f.path === active)!), /changed/);
  await assert.rejects(verifyCodexDeletionHistories(inv, new Set(['independent']), new Set([independent])), /changed/);
});

test('completed replacements retain affected histories without aborting independent reference checks', async t => {
  for (const suffix of ['.jsonl', '.jsonl.zst']) await t.test(suffix, async t => {
    const {root, put} = await layout(t);
    const source = await put('sessions/source.jsonl', {id: 'source', session_id: 'stable'});
    const independent = await put('sessions/independent.jsonl', {id: 'independent'});
    const pair = await put('sessions/pair.jsonl', {id: 'pair'});
    await put('sessions/pair.jsonl.zst', {id: 'pair'});
    const changing = await put('sessions/changing' + suffix, {id: 'changing', history_base: {thread_id: 'stable', end_byte_offset: 99}});
    const time = new Date('2020-01-01T00:00:00Z'); await utimes(changing, time, time);
    const inv = await scanRoot(root, 'codex'), before = inv.files.find(f => f.path === changing)!;
    const bytes = await readFile(changing);
    await writeFile(changing + '.replacement', bytes);
    await utimes(changing + '.replacement', time, time);
    await rename(changing + '.replacement', changing);
    const after = await lstat(changing);
    assert.notEqual(after.ino, before.ino);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    for (const duplicates of [false, true]) {
      const blocked = await verifyCodexRewriteLayout(inv, undefined, duplicates);
      assert.equal(blocked.has(independent), false);
      assert.equal(blocked.has(changing), true);
      assert.match(blocked.get(source)!, /referenced/);
      if (duplicates) for (const path of [pair, pair + '.zst']) assert.equal(blocked.has(path), false);
    }
    assert.deepEqual(await readFile(changing), bytes);
    await assert.rejects(readCodexHeader(before), /changed/);
    await assert.rejects(verifyCodexDeletionHistories(inv, new Set(['independent']), new Set([independent])), /changed/);
  });
});

test('new references in a replacement header retain their source', async t => {
  for (const suffix of ['.jsonl', '.jsonl.zst']) await t.test(suffix, async t => {
    const {root, put} = await layout(t);
    const source = await put('sessions/source.jsonl', {id: 'source', session_id: 'stable'});
    const independent = await put('sessions/independent.jsonl', {id: 'independent'});
    const changing = await put('sessions/changing' + suffix, {id: 'old'});
    const inv = await scanRoot(root, 'codex');
    const replacement = await put('replacement' + suffix, {id: 'new', history_base: {thread_id: 'stable', end_byte_offset: 99}});
    await rename(replacement, changing);
    for (const duplicates of [false, true]) {
      const blocked = await verifyCodexRewriteLayout(inv, undefined, duplicates);
      assert.equal(blocked.has(changing), true);
      assert.match(blocked.get(source)!, /referenced/);
      assert.equal(blocked.has(independent), false);
    }
  });
});

test('replacement headers retain old and new physical aliases', async t => {
  const primary = await layout(t), other = await layout(t);
  const source = await primary.put('sessions/source.jsonl', {id: 'source'});
  const independent = await primary.put('sessions/independent.jsonl', {id: 'independent'});
  const changing = await primary.put('sessions/changing.jsonl', {id: 'old'});
  const oldAlias = join(other.root, 'sessions/changing.jsonl'); await link(changing, oldAlias);
  const replacement = await primary.put('sessions/replacement.jsonl', {id: 'new', history_base: {thread_id: 'source', end_byte_offset: 99}});
  const invs = await Promise.all([primary, other].map(h => scanRoot(h.root, 'codex')));
  await link(replacement, changing + '.replacement'); await rename(changing + '.replacement', changing);
  for (const duplicates of [false, true]) {
    const blocked = await verifyCodexRewriteLayout(invs[0], undefined, duplicates, invs.slice(1));
    for (const path of [changing, oldAlias, replacement]) assert.equal(blocked.has(path), true);
    assert.match(blocked.get(source)!, /referenced/);
    assert.equal(blocked.has(independent), false);
  }
});

test('link-count changes retain affected histories and references without blocking unrelated histories', async t => {
  for (const remove of [false, true]) await t.test(remove ? 'removed link' : 'added link', async t => {
    const {root, put} = await layout(t);
    const source = await put('sessions/source.jsonl', {id: 'source', session_id: 'stable'});
    const independent = await put('sessions/independent.jsonl', {id: 'independent'});
    const pair = await put('sessions/pair.jsonl', {id: 'pair'});
    await put('sessions/pair.jsonl.zst', {id: 'pair'});
    const changing = await put('sessions/changing.jsonl', {id: 'changing', history_base: {thread_id: 'stable', end_byte_offset: 99}});
    const alias = join(root, 'bridge-link');
    if (remove) await link(changing, alias);
    const inv = await scanRoot(root, 'codex');
    if (remove) await rm(alias); else await link(changing, alias);
    for (const duplicates of [false, true]) {
      const blocked = await verifyCodexRewriteLayout(inv, undefined, duplicates);
      assert.equal(blocked.has(independent), false);
      assert.equal(blocked.has(changing), true);
      assert.match(blocked.get(source)!, /referenced/);
      if (duplicates) for (const path of [pair, pair + '.zst']) assert.equal(blocked.has(path), false);
    }
    await assert.rejects(readCodexHeader(inv.files.find(f => f.path === changing)!), /changed/);
    await assert.rejects(verifyCodexDeletionHistories(inv, new Set(['independent']), new Set([independent])), /changed/);
  });
});

test('a link added while inspecting a later alias also retains already inspected aliases', async t => {
  for (const duplicates of [false, true]) await t.test(duplicates ? 'deduplication' : 'slimming', async t => {
    const primary = await layout(t), other = await layout(t);
    const plain = await primary.put('sessions/shared.jsonl', {id: 'shared'});
    const alias = join(other.root, 'sessions/shared.jsonl'); await link(plain, alias);
    const independent = await primary.put('sessions/independent.jsonl', {id: 'independent'});
    const invs = await Promise.all([primary, other].map(h => scanRoot(h.root, 'codex')));
    const handle = await open(plain, 'r'), prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const read = prototype.read, headerLine = lines({type: 'session_meta', payload: {id: 'shared'}});
    let inspected = 0;
    const mock = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: any[]) {
      const result = await Reflect.apply(read, this, args);
      if (Buffer.isBuffer(args[0]) && args[0].equals(headerLine) && ++inspected === 2)
        await link(plain, join(primary.root, 'bridge-link'));
      return result;
    });
    const blocked = await verifyCodexRewriteLayout(invs[0], undefined, duplicates, invs.slice(1));
    mock.mock.restore();
    assert.equal(inspected, 2);
    for (const path of [plain, alias]) assert.equal(blocked.has(path), true);
    assert.equal(blocked.has(independent), false);
  });
});

test('reference inspection rejects a header rewritten between its two reads', async t => {
  const {root, put} = await layout(t);
  const plain = await put('sessions/one.jsonl', {id: 'one'});
  const inv = await scanRoot(root, 'codex'), original = await readFile(plain);
  const headerLine = lines({type: 'session_meta', payload: {id: 'one'}});
  const handle = await open(plain, 'r'), prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const read = prototype.read;
  let changed = false;
  const mock = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: any[]) {
    if (!changed && args[0]?.length === headerLine.length) {
      changed = true;
      await writeFile(plain, original.toString().replace('"id":"one"', '"id":"two"'));
    }
    return Reflect.apply(read, this, args);
  });
  await assert.rejects(verifyCodexRewriteLayout(inv), /header changed/);
  mock.mock.restore();
  assert.equal(changed, true);
});

test('link changes during inspection still reject incomplete plain headers and compressed histories', async t => {
  for (const compressed of [false, true]) await t.test(compressed ? 'compressed' : 'incomplete', async t => {
    const {root, put} = await layout(t);
    const path = await put(compressed ? 'sessions/one.jsonl.zst' : 'sessions/one.jsonl', {id: 'one'});
    if (!compressed) await writeFile(path, JSON.stringify({type: 'session_meta', payload: {id: 'one'}}));
    const inv = await scanRoot(root, 'codex');
    const handle = await open(path, 'r'), prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const stat = prototype.stat;
    let changed = false;
    const mock = t.mock.method(prototype, 'stat', async function(this: FileHandle, ...args: any[]) {
      const result = await Reflect.apply(stat, this, args);
      if (!changed) { changed = true; await link(path, join(root, 'bridge-link')); }
      return result;
    });
    await assert.rejects(verifyCodexRewriteLayout(inv), /changed/);
    mock.mock.restore();
    assert.equal(changed, true);
  });
});

test('reference inspection rejects replacement or truncation during the header read', async t => {
  for (const replace of [false, true]) await t.test(replace ? 'replaced' : 'truncated', async t => {
    const {root, put} = await layout(t);
    const path = await put('sessions/one.jsonl', {id: 'one'});
    const inv = await scanRoot(root, 'codex'), bytes = await readFile(path);
    const headerLine = lines({type: 'session_meta', payload: {id: 'one'}});
    const handle = await open(path, 'r'), prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const read = prototype.read;
    let changed = false;
    const mock = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: any[]) {
      if (!changed && args[0]?.length === headerLine.length) {
        changed = true;
        if (replace) { await writeFile(path + '.replacement', bytes); await rename(path + '.replacement', path); }
        else await writeFile(path, headerLine);
      }
      return Reflect.apply(read, this, args);
    });
    await assert.rejects(verifyCodexRewriteLayout(inv), /changed/);
    mock.mock.restore();
    assert.equal(changed, true);
  });
});

test('completed changes retain their files while unreadable current headers still block reference checks', async t => {
  const {root, put} = await layout(t);
  const plain = await put('sessions/one.jsonl', {id: 'one'});
  const independent = await put('sessions/independent.jsonl', {id: 'independent'});
  let inv = await scanRoot(root, 'codex');
  await writeFile(plain, lines({type: 'session_meta', payload: {id: 'one'}}));
  const blocked = await verifyCodexRewriteLayout(inv);
  assert.equal(blocked.has(plain), true); assert.equal(blocked.has(independent), false);
  await writeFile(plain, JSON.stringify({type: 'session_meta', payload: {id: 'one'}}));
  assert.equal((await verifyCodexRewriteLayout(await scanRoot(root, 'codex'))).has(plain),false);
  await writeFile(plain, '{"type":"session_meta","payload":');
  await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /JSON/);
  await put('sessions/one.jsonl', {id: 'one'});
  const zipped = await put('sessions/two.jsonl.zst', {id: 'two'});
  inv = await scanRoot(root, 'codex');
  await appendFile(zipped, zstdCompressSync('extra'));
  const changed = await verifyCodexRewriteLayout(inv);
  assert.equal(changed.has(zipped), true); assert.equal(changed.has(independent), false);
  await rm(plain);
  await assert.rejects(verifyCodexRewriteLayout(inv), /ENOENT/);
});

test('inbound references through rollout and session identities retain only dependent histories', async t => {
  const {root, put} = await layout(t);
  const source = await put('sessions/source.jsonl', {id: 'source', session_id: 'stable-source', history_mode: 'paginated'});
  const independent = await put('sessions/independent.jsonl', {id: 'independent'});
  for (const id of ['source', 'stable-source']) {
    const dependent = await put('archived_sessions/shared.jsonl.zst', {id: 'dependent', history_base: {thread_id: id, end_byte_offset: 99}});
    const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
    assert.match(blocked.get(source)!, /referenced/);
    assert.equal(blocked.has(independent), false);
    assert.equal(blocked.has(dependent), true);
  }
});

test('native ownership checks allow unrelated copies but reject unpreviewed owned rollouts and references', async t => {
  const {root, put} = await layout(t);
  const target = await put('sessions/target.jsonl', {id: 'immutable', session_id: 'selected'});
  const unrelated = await put('archived_sessions/unrelated.jsonl.zst', {id: 'unrelated'});
  await link(unrelated, join(root, 'linked-copy'));
  const ids = new Set(['selected']), paths = new Set([target]);
  await verifyCodexDeletionHistories(await scanRoot(root, 'codex'), ids, paths);
  for (const meta of [
    {id: 'another-immutable', session_id: 'selected'},
    {id: 'dependent', history_base: {thread_id: 'immutable', end_byte_offset: 99}},
  ]) {
    const path = await put('archived_sessions/other.jsonl.zst', meta);
    await assert.rejects(verifyCodexDeletionHistories(await scanRoot(root, 'codex'), ids, paths), /unpreviewed|referenced/);
    await rm(path);
  }
  await put('sessions/target.jsonl.zst', {id: 'immutable'});
  await assert.rejects(verifyCodexDeletionHistories(await scanRoot(root, 'codex'), ids, paths), /unpreviewed/);
});

test('unknown offset-bearing schemas and update triggers are refused explicitly', () => {
  const db = fixture();
  try {
    db.exec('ALTER TABLE thread_turns ADD COLUMN future_byte_offset INTEGER');
    assert.throws(() => projectionSnapshot(db, 'rollout'), /offset/);
  } finally { db.close(); }
  const triggered = fixture();
  try {
    triggered.exec('CREATE TRIGGER surprise AFTER UPDATE ON thread_items BEGIN DELETE FROM thread_turns; END');
    assert.throws(() => projectionSnapshot(triggered, 'rollout'), /trigger/);
  } finally { triggered.close(); }
});

test('native capability validation depends on advertised behavior, not versions', () => {
  const help = 'Usage: codex delete [OPTIONS] <SESSION>\n -c, --config <key=value>\n --force';
  const features = 'local_thread_store_compression experimental false\nbackground_paginated_rollout_migration experimental false\n';
  assert.doesNotThrow(() => assertCodexDeleteCapabilities(help, features));
  for (const text of [help.replace('--force', ''), help.replace('<SESSION>', '[SESSION]'), help.replace('--config', '--other')])
    assert.throws(() => assertCodexDeleteCapabilities(text, features), /capabilit/);
  assert.throws(() => assertCodexDeleteCapabilities(help, features.replace('experimental false', 'experimental true')), /capabilit/);
});
