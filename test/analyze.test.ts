import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { directoryEntries, scanRoot } from '../src/scan.ts';
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
