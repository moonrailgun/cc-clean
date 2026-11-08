import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { directoryEntries, scanRoot } from '../src/scan.ts';
import { readCodexIndex } from '../src/providers/codex.ts';
import type { ScanProgress } from '../src/types.ts';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'cc-clean-analysis-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return realpath(base);
}
async function file(root: string, path: string, content: string) {
  const dest = join(root, path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content);
  return dest;
}
function jsonl(records: unknown[]) { return records.map(record => JSON.stringify(record)).join('\n') + '\n'; }
const stamp = '2026-11-01T10:00:00.000Z';

test('directory browsing reconciles nested totals and does not count hardlinks twice', async t => {
  const root = await fixture(t);
  const a = await file(root, 'large/nested/a', '1234567890');
  await file(root, 'small/b', '123');
  await link(a, join(root, 'small', 'alias'));
  const inventory = await scanRoot(root, 'claude');
  const entries = directoryEntries(inventory);
  assert.deepEqual(entries.map(e => e.name), ['large', 'small']);
  assert.equal(entries.reduce((n, e) => n + e.bytes, 0), 13);
  assert.equal(directoryEntries(inventory, 'large/')[0].directory, true);
  assert.deepEqual(directoryEntries(inventory, 'large/nested/').map(e => [e.name, e.bytes, e.directory]), [['a', 10, false]]);
  assert.equal(directoryEntries(inventory, 'small/').reduce((n, e) => n + e.bytes, 0), 3);
  assert.deepEqual(directoryEntries(inventory, 'missing/'), []);
});

test('scanner canonicalizes link targets through another directory alias', async t => {
  const base = await fixture(t), root = join(base, 'root');
  const target = await file(root, 'target', 'retained');
  await symlink(root, join(base, 'root-alias'));
  await symlink(join(base, 'root-alias/target'), join(root, 'reference'));
  const inventory = await scanRoot(root, 'codex');
  assert.equal(inventory.links[0].target, target);
});

test('Codex index graph fingerprints ignore row order and change with relationships', async t => {
  const root = await fixture(t), dbPath = join(root, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, archived INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
  insert.run('b', 'sessions/b.jsonl', 0); insert.run('a', 'sessions/a.jsonl', 0);
  const first = await readCodexIndex(await scanRoot(root, 'codex'));
  assert.equal(first.complete, true);
  assert.match(first.fingerprint!, /^[a-f0-9]{64}$/);
  db.exec('DELETE FROM threads');
  insert.run('a', 'sessions/a.jsonl', 0); insert.run('b', 'sessions/b.jsonl', 0);
  assert.equal((await readCodexIndex(await scanRoot(root, 'codex'))).fingerprint, first.fingerprint);
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('a', 'b', 'running');
  assert.notEqual((await readCodexIndex(await scanRoot(root, 'codex'))).fingerprint, first.fingerprint);
  db.exec('DROP TABLE thread_spawn_edges');
  const missing = await readCodexIndex(await scanRoot(root, 'codex'));
  assert.equal(missing.complete, false);
  assert.equal(missing.fingerprint, null);
});

test('Codex spawn graph exceeding its bounded row limit cannot validate deletions', async t => {
  const root = await fixture(t), db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); BEGIN');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('child', 'sessions/child.jsonl');
  const edge = db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)');
  for (let i = 0; i < 100001; i++) edge.run('parent', 'child');
  db.exec('COMMIT'); db.close();
  const result = await readCodexIndex(await scanRoot(root, 'codex'));
  assert.equal(result.complete, false);
  assert.equal(result.fingerprint, null);
  assert.match(result.warnings.join(' '), /edge limit/);
});
