import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink, link, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { privateDir, atomicJson, jsonFiles, existingDir, readOrdinaryFile, validateReceipt } from '../src/state.ts';
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
