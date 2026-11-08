import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, readdir, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteCodexSession, getCodexVersion } from '../src/codex-delete.ts';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555'];

test('native adapter validates IDs/version, isolates roots, and sanitizes failure', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-fake-codex-')));
  const root = join(temp, 'root $(no-shell); space');
  const bin = join(temp, 'bin');
  await mkdir(root); await mkdir(bin);
  const settings = join(temp, 'settings.json');
  const calls = join(temp, 'calls.jsonl');
  await writeFile(join(bin, 'codex'), `#!${process.execPath}
const fs=require('node:fs');
const settings=JSON.parse(fs.readFileSync(${JSON.stringify(settings)},'utf8'));
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,cwd:process.cwd(),root:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME})+'\\n');
if(args[0]==='--version'){console.log(settings.version??'codex-cli 0.167.0');process.exit(0);}
if(settings.fail){console.error('SECRET_TOKEN private conversation');process.exit(7);}
if(settings.hang){require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});process.exit(0);}
`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME };
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.CODEX_HOME = join(temp, 'wrong-home');
  process.env.CODEX_SQLITE_HOME = join(temp, 'wrong-sqlite');
  const configure = (value: object) => writeFile(settings, JSON.stringify(value));
  const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  try {
    await configure({});
    await t.test('uses a UUID argument and explicitly pinned canonical data directories', async () => {
      assert.equal(await getCodexVersion(), '0.167.0');
      await deleteCodexSession(root, ids[0]);
      const call = (await readCalls()).at(-1);
      assert.deepEqual(call.args, ['delete', ids[0], '--force', '-c', `sqlite_home=${JSON.stringify(root)}`, '-c', `log_dir=${JSON.stringify(join(root, 'log'))}`,
        '-c', 'features.local_thread_store_compression=false', '-c', 'features.background_paginated_rollout_migration=false']);
      assert.equal(call.root, root); assert.equal(call.sqlite, root); assert.equal(call.cwd, root);
    });
    await t.test('rejects injected arguments, names, and paths before starting any process', async () => {
      const count = (await readCalls()).length;
      for (const id of ['--remote', `${ids[0]} --force`, '../session', 'saved-name', `${ids[0]}\n`, '$(touch injected)']) {
        await assert.rejects(deleteCodexSession(root, id), /UUID/);
      }
      assert.equal((await readCalls()).length, count);
    });
    await t.test('rejects relative and symlink roots', async () => {
      await assert.rejects(deleteCodexSession('.', ids[0]), /absolute directory/);
      const link = join(temp, 'alias'); await symlink(root, link);
      await assert.rejects(deleteCodexSession(link, ids[0]), /absolute directory/);
    });
    await t.test('rejects inherited remote execution selection before launching Codex', async () => {
      const count = (await readCalls()).length;
      for (const key of ['CODEX_EXEC_SERVER_URL', 'CODEX_EXEC_SERVER_NOISE_REGISTRY_URL']) {
        const previousValue = process.env[key];
        try {
          process.env[key] = 'ws://127.0.0.1:1/synthetic-only';
          await assert.rejects(deleteCodexSession(root, ids[0]), /Remote.*blocked/);
        } finally {
          if (previousValue === undefined) delete process.env[key]; else process.env[key] = previousValue;
        }
      }
      assert.equal((await readCalls()).length, count);
    });
    await t.test('rejects links along native write paths without touching their external targets', async () => {
      const outside = join(temp, 'external-sentinel');
      await writeFile(outside, 'must survive');
      for (const name of ['state_5.sqlite', 'skills/.system', '.tmp/nested', 'tmp/nested',
        'log/nested', 'logs/nested', 'thread-writer-locks/nested', 'sessions/nested', 'archived_sessions/nested', 'installation_id',
        'session_index.jsonl', 'session_index.jsonl.lock']) {
        const path = join(root, name); await mkdir(dirname(path), { recursive: true });
        await symlink(outside, path);
        await assert.rejects(deleteCodexSession(root, ids[0]), /links or special files/);
        assert.deepEqual((await readCalls()).at(-1).args, ['--version']);
        await rm(path);
      }
      for (const name of ['state_5.sqlite-wal', 'log/hardlink', 'session_index.jsonl.lock']) {
        const path = join(root, name); await link(outside, path);
        await assert.rejects(deleteCodexSession(root, ids[0]), /links or special files/);
        await rm(path);
      }
      assert.equal(await readFile(outside, 'utf8'), 'must survive');
    });
    await t.test('allows ordinary plugin and user skill symlinks outside native write paths', async () => {
      await mkdir(join(root, 'plugins', 'cache'), { recursive: true });
      const outside = join(temp, 'ordinary-plugin'); await mkdir(outside);
      await symlink(outside, join(root, 'plugins', 'cache', 'current'));
      await symlink(outside, join(root, 'skills', 'user-skill'));
      await mkdir(join(root, 'tmp', 'arg0-macos', 'codex-arg0synthetic'), { recursive: true });
      await symlink(outside, join(root, 'tmp', 'arg0-macos', 'codex-arg0synthetic', 'apply_patch'));
      await deleteCodexSession(root, ids[0]);
      assert.equal((await readCalls()).at(-1).args[0], 'delete');
    });
    await t.test('does not delete with another version or malformed version output', async () => {
      await configure({ version: 'codex-cli 0.168.0' });
      await assert.rejects(deleteCodexSession(root, ids[0]), /Unverified/);
      assert.deepEqual((await readCalls()).at(-1).args, ['--version']);
      await configure({ version: 'SECRET_TOKEN' });
      await assert.rejects(getCodexVersion(), error => error instanceof Error && error.message === 'Cannot determine Codex version');
    });
    await t.test('discards native error output', async () => {
      await configure({ fail: true });
      await assert.rejects(deleteCodexSession(root, ids[0]), error => error instanceof Error
        && error.message === 'Codex command did not complete successfully; deletion needs review' && !error.cause);
    });
    await t.test('kills a stalled command within the documented timeout', async () => {
      await configure({ hang: true });
      const start = Date.now();
      await assert.rejects(deleteCodexSession(root, ids[0]), /timed out.*must not be retried automatically/);
      assert.ok(Date.now() - start < 18_000);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
