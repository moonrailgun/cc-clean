import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink, link, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { privateDir, atomicJson, jsonFiles, existingDir, readOrdinaryFile, validateReceipt } from '../src/state.ts';
import { readStats } from '../src/stats.ts';
import { recordCleanup, readCleanupLog } from '../src/history.ts';
import type { Receipt } from '../src/clean.ts';

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-state-')));
  t.after(() => rm(base, {recursive: true, force: true}));
  return {base, state: join(base, 'state')};
}
function receipt(base: string): Receipt {
  const root = join(base, 'source');
  return {
    schemaVersion: 1, operationId: randomUUID(), provider: 'codex', root, version: '0.167.0',
    source: 'clean', startedAt: '2026-11-08T00:00:00.000Z', executionStartedAt: '2026-11-08T00:00:30.000Z', finishedAt: '2026-11-08T00:01:00.000Z',
    warnings: [], scanComplete: true, status: 'completed', rootBeforeBytes: 100, rootAfterBytes: 81,
    confirmedReductionBytes: 19, attributionComplete: true,
    actions: [{id: randomUUID(), kind: 'delete-files', targetId: '..codex-global-state.json.tmp-example',
      files: [{path: join(root, '..codex-global-state.json.tmp-example'), relative: '..codex-global-state.json.tmp-example',
        size: 19, allocatedBytes: 4096, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1, nlink: 1, mode: 0o100600, category: 'temporary'}],
      status: 'completed', beforeBytes: 19, afterBytes: 0, recoveryState: 'finalized'}],
  };
}
async function save(state: string, r: Receipt, name = r.operationId) {
  const dir = join(state, 'providers', r.provider, 'operations');
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, `${name}.json`), JSON.stringify(r));
  return dir;
}

test('receipt savings estimates are optional, bounded and separate from measured savings', () => {
  const r = receipt('/inert');
  for (const estimate of [undefined, null, 0, 10, 19]) {
    r.actions[0].estimatedSavingsBytes = estimate;
    assert.equal(validateReceipt(r).confirmedReductionBytes, 19);
  }
  for (const estimate of [-1, 20, 0.5, Infinity, NaN, '19']) {
    const invalid = structuredClone(r);
    Object.assign(invalid.actions[0], { estimatedSavingsBytes: estimate });
    assert.throws(() => validateReceipt(invalid));
  }
});

test('privateDir refuses an existing directory below a symlink ancestor', async t => {
  const {base} = await fixture(t);
  await mkdir(join(base, 'external', 'nested'), {recursive: true});
  await symlink(join(base, 'external'), join(base, 'alias'));
  await assert.rejects(privateDir(join(base, 'alias', 'nested')), /symlink/i);
  await assert.rejects(privateDir(join(base, 'alias', 'new')), /symlink/i);
  await assert.rejects(lstat(join(base, 'external', 'new')), {code: 'ENOENT'});
});

test('directory checks reject lexical traversal that would hide a linked component', async t => {
  const {base} = await fixture(t);
  await mkdir(join(base, 'external', 'nested'), {recursive: true});
  await mkdir(join(base, 'ledger'));
  await symlink(join(base, 'external', 'nested'), join(base, 'alias'));
  const path = `${base}/alias/../ledger`;
  await assert.rejects(existingDir(path), /path|symlink/i);
  await assert.rejects(privateDir(path), /path|symlink/i);
});

test('ordinary reads are bounded and refuse symlinks, hardlinks and directories', async t => {
  const {base} = await fixture(t), path = join(base, 'data');
  await writeFile(path, '12345');
  assert.equal((await readOrdinaryFile(path, 5)).toString(), '12345');
  await assert.rejects(readOrdinaryFile(path, 4), /limit/);
  await assert.rejects(readOrdinaryFile(base));
  await symlink(path, join(base, 'symlink'));
  await assert.rejects(readOrdinaryFile(join(base, 'symlink')));
  await link(path, join(base, 'hardlink'));
  await assert.rejects(readOrdinaryFile(path));
});

test('atomic JSON refuses an existing linked destination without changing its target', async t => {
  const {base, state} = await fixture(t), target = join(base, 'external');
  await mkdir(state); await writeFile(target, 'original');
  await symlink(target, join(state, 'symlink.json'));
  await link(target, join(state, 'hardlink.json'));
  await assert.rejects(atomicJson(join(state, 'symlink.json'), {}));
  await assert.rejects(atomicJson(join(state, 'hardlink.json'), {}));
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('atomicJson refuses linked ancestors and cleans up an unsuccessful serialization', async t => {
  const {base, state} = await fixture(t);
  await mkdir(state);
  await symlink(state, join(base, 'alias'));
  await assert.rejects(atomicJson(join(base, 'alias', 'outside.json'), {}), /symlink/i);
  await assert.rejects(lstat(join(state, 'outside.json')), {code: 'ENOENT'});
  await assert.rejects(atomicJson(join(state, 'invalid.json'), {value: 1n}));
  const {readdir} = await import('node:fs/promises');
  assert.deepEqual(await readdir(state), []);
});

test('ledger discovery rejects ancestor links, linked receipts, and mismatched identities', async t => {
  const {base, state} = await fixture(t);
  const r = receipt(base), dir = await save(state, r);
  await symlink(state, join(base, 'alias'));
  await assert.rejects(jsonFiles(join(base, 'alias', 'providers', 'codex', 'operations')), /symlink/i);
  await rm(join(dir, `${r.operationId}.json`));
  const external = join(base, 'external.json');
  await writeFile(external, JSON.stringify(r));
  await symlink(external, join(dir, `${r.operationId}.json`));
  await assert.rejects(jsonFiles(dir));
  await rm(join(dir, `${r.operationId}.json`));
  await link(external, join(dir, `${r.operationId}.json`));
  await assert.rejects(jsonFiles(dir));
  await rm(join(dir, `${r.operationId}.json`));
  await save(state, r, randomUUID());
  await assert.rejects(jsonFiles(dir), /record|receipt|identity/i);
});

test('ledger discovery refuses malformed JSON filenames and non-object receipts', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  const dir = await save(state, r, 'not-a-uuid');
  await assert.rejects(jsonFiles(dir), /record|receipt|filename/i);
  await rm(join(dir, 'not-a-uuid.json'));
  await writeFile(join(dir, `${r.operationId}.json`), 'null');
  await assert.rejects(jsonFiles(dir), /record|receipt/i);
});

test('missing stats return zero without creating a state directory', async t => {
  const {state} = await fixture(t);
  const stats = await readStats(state);
  assert.equal(stats.savedBytes, 0);
  assert.equal(stats.cleanedRecords, 0);
  await assert.rejects(lstat(state), {code: 'ENOENT'});
});

test('stats use recorded directory differences, not action estimates or cache sizes', async t => {
  const {base, state} = await fixture(t);
  const r = receipt(base); r.rootAfterBytes = 90;
  await save(state, r);
  assert.equal((await readStats(state)).savedBytes, 0, 'receipts alone do not create cleanup history');
  await recordCleanup(state, r);
  const stats = await readStats(state);
  assert.equal(stats.providers.codex.savedBytes, 10);
  assert.equal(stats.providers.claude.savedBytes, 0);
  assert.equal(stats.savedBytes, 10);
  assert.equal(stats.cleanedRecords, 1);
});

test('cleanup JSONL records execution timestamps, measured bytes and grouped record counts', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  r.actions[0].sessionIds = [randomUUID(), randomUUID()];
  await recordCleanup(state, r);
  const data = await readFile(join(state, 'cleanup.jsonl'), 'utf8');
  assert.equal(data.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(data), {
    schemaVersion: 1, operationId: r.operationId, provider: 'codex', root: r.root, source: 'clean',
    startedAt: r.executionStartedAt, finishedAt: r.finishedAt, status: 'completed',
    beforeBytes: 100, afterBytes: 81, savedBytes: 19, cleanedRecords: 2,
    cleanupTypes: [{type: 'delete-sessions', cleanedRecords: 2}], needsReview: false,
  });
  assert.equal((await lstat(join(state, 'cleanup.jsonl'))).mode & 0o777, 0o600);
});

test('mixed cleanup counts include only completed sessions and files, and no-op executions record zero', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  const add = (suffix: string) => {
    const action = structuredClone(r.actions[0]); action.id = randomUUID();
    action.files[0].path += suffix; action.files[0].relative += suffix;
    r.actions.push(action); return action;
  };
  const sessions = add('-sessions'); sessions.sessionIds = [randomUUID(), randomUUID()];
  const png = add('-png'); png.kind = 'compress-png'; png.afterBytes = 10;
  png.beforeHash = 'a'.repeat(64); png.afterHash = 'b'.repeat(64);
  for (const status of ['skipped', 'failed'] as const) {
    const action = add('-' + status); action.status = status; action.afterBytes = action.beforeBytes;
  }
  r.status = 'partial'; r.confirmedReductionBytes = 47; r.rootAfterBytes = 53;
  await recordCleanup(state, r);
  const [log] = await readCleanupLog(state);
  assert.equal(log.cleanedRecords, 4);
  assert.deepEqual(log.cleanupTypes, [
    {type: 'delete-files', cleanedRecords: 1}, {type: 'delete-sessions', cleanedRecords: 2},
    {type: 'compress-png', cleanedRecords: 1},
  ]);
  const empty = receipt(base); empty.actions = []; empty.confirmedReductionBytes = 0; empty.rootAfterBytes = empty.rootBeforeBytes;
  await recordCleanup(state, empty);
  const logs = await readCleanupLog(state);
  assert.equal(logs.length, 2);
  assert.equal(logs[1].savedBytes, 0); assert.equal(logs[1].cleanedRecords, 0);
  assert.deepEqual(logs[1].cleanupTypes, []);
  assert.equal((await readStats(state)).cleanedRecords, 4);
});

test('logging retains prior lines, updates recovered operations once, and never logs previews', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  r.status = 'needs-review'; r.actions[0].recoveryState = 'applied'; r.attributionComplete = false;
  await recordCleanup(state, r);
  assert.equal((await readStats(state)).savedBytes, 0);
  const second = receipt(base); second.provider = 'claude';
  await recordCleanup(state, second);
  const before = (await readFile(join(state, 'cleanup.jsonl'), 'utf8')).trim().split('\n');
  r.actions[0].recoveryState = 'finalized'; r.status = 'interrupted'; r.attributionComplete = true; r.rootAfterBytes = null;
  await recordCleanup(state, r); await recordCleanup(state, r);
  const after = (await readFile(join(state, 'cleanup.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(after.length, 2); assert.equal(after[1], before[1]);
  assert.equal(JSON.parse(after[0]).savedBytes, null);
  assert.equal((await readStats(state)).savedBytes, 19);
  const preview = receipt(base); preview.status = 'dry-run';
  await recordCleanup(state, preview);
  assert.deepEqual(await readFile(join(state, 'cleanup.jsonl'), 'utf8'), after.join('\n') + '\n');
  const legacy = receipt(base); delete legacy.executionStartedAt;
  await recordCleanup(state, legacy);
  assert.equal((await readCleanupLog(state)).length, 2);
});

test('unknown measurements and unfinished actions are excluded; real growth stays negative', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  r.rootAfterBytes = 105;
  await recordCleanup(state, r);
  assert.equal((await readStats(state)).savedBytes, -5);
  const unknown = receipt(base); unknown.rootAfterBytes = null;
  await recordCleanup(state, unknown);
  const pending = receipt(base); pending.actions[0].recoveryState = 'applied';
  await recordCleanup(state, pending); await save(state, pending);
  const stats = await readStats(state);
  assert.equal(stats.savedBytes, -5); assert.equal(stats.providers.codex.pending, 2);
  assert.equal((await readCleanupLog(state)).find(r => r.operationId === pending.operationId)?.cleanedRecords, 0);
});

test('invalid or truncated cleanup history is rejected without overwriting it', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  await recordCleanup(state, r);
  const path = join(state, 'cleanup.jsonl'), valid = await readFile(path, 'utf8');
  const entry = JSON.parse(valid);
  for (const invalid of [valid + '{', valid.trim(), valid + valid,
    JSON.stringify({...entry, savedBytes: 999}) + '\n',
    JSON.stringify({...entry, cleanedRecords: 999}) + '\n',
    JSON.stringify({...entry, startedAt: 'bad'}) + '\n',
    JSON.stringify({...entry, needsReview: 'false'}) + '\n']) {
    await writeFile(path, invalid);
    await assert.rejects(readStats(state), /cleanup|Duplicate/i);
    await assert.rejects(recordCleanup(state, receipt(base)), /cleanup|Duplicate/i);
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
});

test('cleanup history refuses linked destinations without changing their targets', async t => {
  const {base, state} = await fixture(t), target = join(base, 'external'), path = join(state, 'cleanup.jsonl');
  await mkdir(state); await writeFile(target, 'original');
  for (const createLink of [symlink, link]) {
    await createLink(target, path);
    await assert.rejects(recordCleanup(state, receipt(base)));
    await assert.rejects(readStats(state));
    assert.equal(await readFile(target, 'utf8'), 'original');
    await rm(path);
  }
});

for (const [label, mutate] of [
  ['inflated claimed savings', (r: Receipt) => { r.confirmedReductionBytes = 20; }],
  ['truthy attribution flag', (r: Receipt) => { (r as any).attributionComplete = 'yes'; }],
  ['invalid timestamp', (r: Receipt) => { r.startedAt = 'bad'; }],
  ['duplicate action', (r: Receipt) => { r.actions.push(structuredClone(r.actions[0])); r.confirmedReductionBytes *= 2; }],
  ['invalid byte total', (r: Receipt) => { r.actions[0].beforeBytes = -1; r.confirmedReductionBytes = -1; }],
  ['file outside root', (r: Receipt) => { r.actions[0].files[0].path = '/outside-file'; }],
  ['file relative path mismatch', (r: Receipt) => { r.actions[0].files[0].relative = '../../outside'; }],
  ['invalid recovery state', (r: Receipt) => { (r.actions[0] as any).recoveryState = 'unknown'; }],
  ['completed dry-run', (r: Receipt) => { r.status = 'dry-run'; }],
] as const) {
  test(`stats reject ${label}`, async t => {
    const {base, state} = await fixture(t), r = receipt(base);
    mutate(r); await save(state, r);
    await assert.rejects(readStats(state), /record|receipt|statistics/);
  });
}

test('pending or unfinalized operations never earn confirmed savings', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  r.status = 'needs-review'; r.actions[0].recoveryState = 'applied';
  await save(state, r);
  const stats = await readStats(state);
  assert.equal(stats.providers.codex.savedBytes, 0);
  assert.equal(stats.providers.codex.pending, 1);
});

for (const [status, recoveryState] of [['failed', 'prepared'], ['skipped', 'applied']] as const) {
  test(`an unresolved ${status} action keeps the entire receipt pending`, async t => {
    const {base, state} = await fixture(t), r = receipt(base);
    r.status = 'interrupted';
    const action = structuredClone(r.actions[0]); action.id = randomUUID();
    action.files[0].path += '-other'; action.files[0].relative += '-other';
    action.status = status; action.recoveryState = recoveryState; action.afterBytes = action.beforeBytes;
    r.actions.push(action); await save(state, r);
    const stats = await readStats(state);
    assert.equal(stats.providers.codex.savedBytes, 0);
    assert.equal(stats.providers.codex.pending, 1);
  });
}

test('analysis caches alone do not create history or negative savings', async t => {
  const {state} = await fixture(t);
  const claude = join(state, 'providers', 'claude'), codex = join(state, 'providers', 'codex');
  await mkdir(claude, {recursive: true}); await mkdir(codex, {recursive: true});
  await writeFile(join(claude, 'cache.bin'), '123456789');
  await link(join(claude, 'cache.bin'), join(codex, 'cache.bin'));
  await link(join(claude, 'cache.bin'), join(state, 'common.bin'));
  const stats = await readStats(state);
  assert.equal(stats.savedBytes, 0);
  assert.deepEqual(stats.providers.claude.operations, []);
  assert.deepEqual(stats.providers.codex.operations, []);
  await assert.rejects(lstat(join(state, 'cleanup.jsonl')), {code: 'ENOENT'});
});

test('stats reject a symlinked state ancestor without reading its ledger', async t => {
  const {base, state} = await fixture(t);
  const r = receipt(base), dir = await save(state, r);
  await symlink(state, join(base, 'alias'));
  await assert.rejects(readStats(join(base, 'alias')), /symlink/i);
  assert.equal(JSON.parse(await readFile(join(dir, `${r.operationId}.json`), 'utf8')).operationId, r.operationId);
});

test('duplicate operation IDs across providers are rejected instead of counted twice', async t => {
  const {base, state} = await fixture(t), r = receipt(base);
  await save(state, r);
  r.provider = 'claude'; await save(state, r);
  await assert.rejects(readStats(state), /Duplicate/);
});

test('receipt validation accepts optional verified root and index identities', () => {
  const r = receipt('/synthetic');
  assert.equal(validateReceipt(r), r);
  r.rootIdentity = {dev: 1, ino: 2}; r.codexIndexFingerprint = 'a'.repeat(64);
  assert.equal(validateReceipt(r), r);
});

for (const [label, value] of [
  ['null root identity', {rootIdentity: null}],
  ['missing root inode', {rootIdentity: {dev: 1}}],
  ['negative root inode', {rootIdentity: {dev: 1, ino: -1}}],
  ['non-numeric root device', {rootIdentity: {dev: '1', ino: 2}}],
  ['invalid index fingerprint', {codexIndexFingerprint: 'not-a-hash'}],
] as const) {
  test(`receipt validation rejects ${label}`, () => {
    assert.throws(() => validateReceipt({...receipt('/synthetic'), ...value}), /receipt/);
  });
}

test('Claude receipts permit bounded agent IDs while Codex requires UUIDs', () => {
  const r = receipt('/synthetic'); r.provider = 'claude';
  r.actions[0].sessionIds = [randomUUID(), 'agent-a123'];
  assert.equal(validateReceipt(r), r);
  for (const id of ['', 'a'.repeat(513), 'agent\nname', 'agent\u007fname']) {
    r.actions[0].sessionIds = [id]; assert.throws(() => validateReceipt(r), /receipt/);
  }
  r.provider = 'codex'; r.actions[0].sessionIds = ['agent-a123'];
  assert.throws(() => validateReceipt(r), /receipt/);
});
