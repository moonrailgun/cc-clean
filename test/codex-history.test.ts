import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, mkdir, writeFile, appendFile, readFile, rm, link, rename, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { slimHistory, slimCodexItem } from '../src/slim.ts';
import { byteOffsetMap, projectionSnapshot, rewriteProjection, projectionHash, projectionState, applyProjection, readCodexHeader, verifyCodexRewriteLayout, verifyCodexDeletionHistories, decodeDuplicateHistory } from '../src/providers/codex-history.ts';
import { assertCodexDeleteCapabilities } from '../src/codex-delete.ts';
import { scanRoot } from '../src/scan.ts';

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

test('projection recovery distinguishes before, after, unchanged and conflicts', () => {
  assert.equal(projectionState('a', {beforeHash: 'a', afterHash: 'b'}), 'before');
  assert.equal(projectionState('b', {beforeHash: 'a', afterHash: 'b'}), 'after');
  assert.equal(projectionState('a', {beforeHash: 'a', afterHash: 'a'}), 'after');
  assert.throws(() => projectionState('c', {beforeHash: 'a', afterHash: 'b'}), /changed/);
});

test('old snapshot slimming coordinates line offsets and recovery hashes while preserving caches and ordinals', () => {
  const opts = {removeImages: false, compactTools: false, removeOldSnapshots: true};
  const snapshot = {type: 'compacted', payload: {message: 'Keep summary', window_number: 1,
    replacement_history: [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'Old context'}]}],
    replacement_history_metadata: [{}]}};
  const source = lines(header, {...snapshot, ordinal: 0}, {ordinal: 1, type: 'event_msg', payload: {type: 'item_completed', item}},
    {...snapshot, ordinal: 2, payload: {...snapshot.payload, window_number: 2}});
  const result = slimHistory(source, 'codex', opts), output = result.output!;
  const start = lines(header, {...snapshot, ordinal: 0}).length;
  const db = fixture();
  try {
    db.prepare('UPDATE thread_history_projection_state SET next_rollout_byte_offset=?, next_rollout_ordinal=3').run(source.length);
    db.prepare("UPDATE thread_turns SET rollout_byte_offset=?, rollout_end_byte_offset=?, rollout_ordinal=1 WHERE thread_id='rollout'").run(start, source.length);
    const before = projectionSnapshot(db, 'rollout'), other = projectionSnapshot(db, 'other');
    const after = rewriteProjection(before, byteOffsetMap(source, output), opts);
    assert.equal(after.thread_history_projection_state[0].next_rollout_byte_offset, BigInt(output.length));
    assert.equal(after.thread_turns[0].rollout_byte_offset, BigInt(start - result.savingsBytes.oldSnapshots!));
    assert.equal(after.thread_turns[0].rollout_end_byte_offset, BigInt(output.length));
    assert.equal(after.thread_turns[0].rollout_ordinal, 1n);
    assert.equal(after.thread_history_projection_state[0].next_rollout_ordinal, 3n);
    assert.deepEqual(after.thread_items, structuredClone(before.thread_items));
    const receipt = {beforeHash: projectionHash(before), afterHash: projectionHash(after)};
    assert.notEqual(receipt.beforeHash, receipt.afterHash);
    assert.equal(projectionState(projectionHash(projectionSnapshot(db, 'rollout')), receipt), 'before');
    db.exec('BEGIN'); applyProjection(db, before, after); db.exec('ROLLBACK');
    assert.deepEqual(projectionSnapshot(db, 'rollout'), before);
    db.exec('BEGIN'); applyProjection(db, before, after); db.exec('COMMIT');
    assert.equal(projectionState(projectionHash(projectionSnapshot(db, 'rollout')), receipt), 'after');
    assert.deepEqual(projectionSnapshot(db, 'other'), other);
  } finally { db.close(); }
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

test('link changes still reject incomplete plain headers and compressed histories', async t => {
  for (const compressed of [false, true]) {
    const {root, put} = await layout(t);
    const path = await put(compressed ? 'sessions/one.jsonl.zst' : 'sessions/one.jsonl', {id: 'one'});
    if (!compressed) await writeFile(path, JSON.stringify({type: 'session_meta', payload: {id: 'one'}}));
    const inv = await scanRoot(root, 'codex');
    await link(path, join(root, 'bridge-link'));
    await assert.rejects(verifyCodexRewriteLayout(inv), /changed/);
  }
});

test('reference inspection still rejects replaced, truncated, incomplete and changed compressed headers', async t => {
  const {root, put} = await layout(t);
  const plain = await put('sessions/one.jsonl', {id: 'one'});
  let inv = await scanRoot(root, 'codex');
  await writeFile(plain, lines({type: 'session_meta', payload: {id: 'one'}}));
  await assert.rejects(verifyCodexRewriteLayout(inv), /changed/);
  inv = await scanRoot(root, 'codex');
  await rename(plain, plain + '.old');
  await put('sessions/one.jsonl', {id: 'one'});
  await assert.rejects(verifyCodexRewriteLayout(inv), /changed/);
  await writeFile(plain, JSON.stringify({type: 'session_meta', payload: {id: 'one'}}));
  assert.equal((await verifyCodexRewriteLayout(await scanRoot(root, 'codex'))).has(plain),false);
  await writeFile(plain, '{"type":"session_meta","payload":');
  await assert.rejects(verifyCodexRewriteLayout(await scanRoot(root, 'codex')), /JSON/);
  await put('sessions/one.jsonl', {id: 'one'});
  const zipped = await put('sessions/two.jsonl.zst', {id: 'two'});
  inv = await scanRoot(root, 'codex');
  await appendFile(zipped, zstdCompressSync('extra'));
  await assert.rejects(verifyCodexRewriteLayout(inv), /changed/);
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

test('unrelated compressed and hardlinked histories do not block an independent paginated target', async t => {
  const {root, put} = await layout(t);
  const independent = await put('sessions/independent.jsonl', {id: 'independent', history_mode: 'paginated'});
  const zipped = await put('archived_sessions/zipped.jsonl.zst', {id: 'zipped'});
  const linked = await put('sessions/linked.jsonl', {id: 'linked'});
  await link(linked, join(root, 'linked-copy'));
  await writeFile(join(root, 'thread_history_1.sqlite'), 'layout-only sentinel');
  const blocked = await verifyCodexRewriteLayout(await scanRoot(root, 'codex'));
  assert.equal(blocked.has(independent), false);
  assert.match(blocked.get(zipped)!, /Compressed/);
  assert.match(blocked.get(linked)!, /hard links/);
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
