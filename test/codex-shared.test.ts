import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, mkdir, realpath, rm, lstat, chmod, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sharedHistoryGroups, sharedTransitionState, knownCodexHome } from '../src/codex-shared.ts';
import * as shared from '../src/codex-shared.ts';
import { ageProtectionReason, protectActiveContent, type Action, type Receipt } from '../src/clean.ts';
import { validateReceipt } from '../src/state.ts';
import { cleanupFileNodes } from '../src/ui.ts';
import type { FileEntry, Inventory } from '../src/types.ts';

// Inert metadata and disposable directory inspection; no cleanup planning, previews, execution or recovery probes.
const roots = [join(homedir(), '.codex'), join(homedir(), 'Library/Application Support/Orca/codex-runtime-home/home')];
const dir = '/inert/work';
const now = Date.parse('2026-11-10T00:00:00Z'), cutoff = now - 72 * 3600000;
function file(root: string, zipped = false): FileEntry {
  const relative = 'sessions/one.jsonl' + (zipped ? '.zst' : '');
  return {path: join(root, relative), relative, dev: 1, ino: zipped ? 2 : 1, size: zipped ? 30 : 100,
    nlink: zipped ? 1 : 2, mode: 0o100600, mtimeMs: cutoff - 1, ctimeMs: 2, allocatedBytes: 4096, category: 'sessions'};
}
function inventory(root: string, files: FileEntry[]): Inventory {
  return {root, files, provider: 'codex', exists: true, complete: true, errors: [], links: [], totalBytes: 130, allocatedBytes: 8192};
}
function receipt(dedup = false): Receipt {
  const plain = file(roots[0]), alias = file(roots[1]), zipped = file(roots[0], true);
  const action: Action = {id: randomUUID(), kind: dedup ? 'deduplicate-history' : 'slim-history', targetId: plain.relative,
    files: dedup ? [plain, zipped] : [plain], status: 'planned', recoveryState: 'prepared', beforeBytes: dedup ? 130 : 100,
    afterBytes: dedup ? 130 : 100, estimatedSavingsBytes: dedup ? 100 : 20, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64),
    codexProjection: [], codexShared: {homes: roots.map((root, i) => ({root, dev: 1, ino: 100 + i, codexProjection: []})),
      groups: dedup ? [[plain, alias], [zipped]] : [[plain, alias]], compressedLinks: dedup ? [alias.path + '.zst'] : []},
    ...dedup ? {} : {slimOptions: {removeImages: true, compactTools: false}, slimCounts: {images: 1, toolOutputs: 0}},
  };
  return {schemaVersion: 1, operationId: randomUUID(), provider: 'codex', root: roots[0], version: 'unknown', source: 'clean',
    rootIdentity: {dev: 1, ino: 100}, startedAt: new Date(now).toISOString(), scanComplete: true, warnings: [], actions: [action],
    status: 'needs-review', rootBeforeBytes: 130, rootAfterBytes: null, confirmedReductionBytes: 0, attributionComplete: true};
}
function entries(a: Action) {
  const result = new Map<string, FileEntry | null>();
  for (const f of a.codexShared!.groups.flat()) result.set(f.path, {...f});
  for (const path of [...a.codexShared!.compressedLinks, ...['0.original', 'output', 'next'].map(n => join(dir, n))]) result.set(path, null);
  return result;
}
function recount(map: Map<string, FileEntry | null>) {
  for (const f of map.values()) if (f) f.nlink = [...map.values()].filter(v => v && v.dev === f.dev && v.ino === f.ino).length;
}

test('known homes accept Orca directory casing without broadening other path components', () => {
  const userHome = '/inert/user', support = join(userHome, 'Library/Application Support');
  for (const app of ['Orca', 'orca', 'ORCA']) {
    for (const suffix of ['codex-runtime-home/home', `codex-accounts/${randomUUID()}/home`]) {
      const root = join(support, app, suffix);
      assert.ok(knownCodexHome(root, userHome), root);
      assert.equal(knownCodexHome(root + '/other', userHome), false);
    }
  }
  for (const root of [join(support, 'orca-other/codex-runtime-home/home'),
    join(support, 'orca/codex-accounts/not-a-uuid/home'), join(support, 'orca/Codex-runtime-home/home'),
    join(userHome, 'library/Application Support/orca/codex-runtime-home/home')])
    assert.equal(knownCodexHome(root, userHome), false);
  const r = receipt();
  const lower = JSON.parse(JSON.stringify(r).replaceAll('/Orca/', '/orca/'));
  assert.equal(validateReceipt(lower), lower);
});

test('home discovery returns canonical lowercase Orca roots and still rejects unsafe directories', async t => {
  const userHome = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-homes-')));
  t.after(() => rm(userHome, {recursive: true, force: true}));
  const primary = join(userHome, '.codex'), app = join(userHome, 'Library/Application Support/orca');
  const runtime = join(app, 'codex-runtime-home/home'), accountHome = join(app, `codex-accounts/${randomUUID()}/home`);
  for (const root of [primary, runtime, accountHome]) await mkdir(root, {recursive: true, mode: 0o700});
  const discover = (root: string) => shared.discoverCodexHomes(root, userHome);
  assert.deepEqual(await discover(primary), [primary, ...[runtime, accountHome].sort()]);
  assert.deepEqual(await discover(runtime), [runtime, ...[primary, accountHome].sort()]);
  const configured = runtime.replace('/orca/', '/Orca/');
  if (await lstat(configured).catch(() => null))
    assert.deepEqual(await discover(configured), await discover(runtime));
  await chmod(runtime, 0o777);
  await assert.rejects(discover(primary), /permissions/);
  await chmod(runtime, 0o700);
  await rm(runtime, {recursive: true}); await symlink(primary, runtime);
  await assert.rejects(discover(primary), /symlink|linked/);
  await rm(runtime); await rm(app, {recursive: true});
  await symlink(primary, app);
  await assert.rejects(discover(primary), /symlink|linked/);
});

test('unjournaled staging is rebuildable only before any original or transaction link changes', () => {
  const a = receipt().actions[0]; a.codexShared!.started = true; a.afterBytes = 80;
  const map = entries(a), output = join(dir, 'output');
  map.set(output, {...a.files[0], path: output, ino: 3, nlink: 1, size: 7, mtimeMs: now, ctimeMs: now});
  for (const size of [0, 7, 80]) {
    map.get(output)!.size = size;
    assert.equal(sharedTransitionState(a, map, dir).unrecordedOutput, map.get(output));
  }
  for (const change of [
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.size = 81;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.dev++;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.ino = a.files[0].ino;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.nlink++;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.uid = (process.getuid?.() ?? 0) + 1;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.mode = 0o120600;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(output)!.mode = 0o100666;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(a.files[0].path)!.ctimeMs++;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(a.files[0].path)!.mtimeMs++;},
    (a: Action, m: Map<string, FileEntry | null>) => {m.set(a.files[0].path, null);},
    (a: Action, m: Map<string, FileEntry | null>) => {m.get(a.files[0].path)!.ino = 3; recount(m);},
    (a: Action, m: Map<string, FileEntry | null>) => {m.set(join(dir, '0.original'), {...a.files[0], path: join(dir, '0.original')}); recount(m);},
    (a: Action, m: Map<string, FileEntry | null>) => {m.set(join(dir, 'next'), {...m.get(output)!, path: join(dir, 'next')}); recount(m);},
    (a: Action) => {a.codexShared!.started = false;},
    (a: Action) => {a.recoveryState = 'applied';},
    (a: Action) => {a.codexShared!.outputIdentity = {dev: 1, ino: 3};},
  ]) {
    const bad = structuredClone(a), evidence = structuredClone(map); change(bad, evidence);
    assert.throws(() => sharedTransitionState(bad, evidence, dir));
  }
});

test('shared grouping accounts for every inode link and missing compressed sibling', () => {
  const r = receipt(true), a = r.actions[0], invs = roots.map(root => inventory(root, a.codexShared!.groups.flat().filter(f => f.path.startsWith(root + '/'))));
  assert.deepEqual(sharedHistoryGroups(a.files, invs), {groups: a.codexShared!.groups, compressedLinks: a.codexShared!.compressedLinks});
  assert.equal(a.beforeBytes - a.files[1].size, 100); // One physical original, despite two paths.
  for (const change of [
    (i: Inventory[]) => {i[1].files = [];},
    (i: Inventory[]) => {i[1].files[0].relative = 'archived_sessions/one.jsonl';},
    (i: Inventory[]) => {i[1].files[0].mtimeMs++;},
    (i: Inventory[]) => {i[1].files.push({...file(roots[1], true), ino: 99});},
    (i: Inventory[]) => {i[1].links.push({path: file(roots[1], true).path, target: '/elsewhere'});},
  ]) {
    const changed = structuredClone(invs); change(changed);
    assert.throws(() => sharedHistoryGroups(a.files, changed));
  }
  assert.ok(knownCodexHome(roots[0])); assert.ok(knownCodexHome(roots[1]));
  assert.equal(knownCodexHome(roots[1] + '/other'), false);
});

test('shared transitions reject missing evidence and accept every journaled slimming phase', () => {
  const a = receipt().actions[0], s = a.codexShared!, map = entries(a);
  assert.equal(sharedTransitionState(a, map, dir).complete, false);
  const missing = structuredClone(map); missing.delete(a.files[0].path); recount(missing);
  assert.throws(() => sharedTransitionState(a, missing, dir), /evidence is incomplete/);
  s.started = true; s.outputIdentity = {dev: 1, ino: 3}; a.afterBytes = 80;
  map.set(join(dir, 'output'), {...a.files[0], path: join(dir, 'output'), ino: 3, size: 80, nlink: 1});
  map.set(join(dir, '0.original'), {...a.files[0], path: join(dir, '0.original')}); recount(map);
  for (const f of s.groups[0]) {
    map.set(join(dir, 'next'), {...map.get(join(dir, 'output'))!, path: join(dir, 'next')}); recount(map);
    assert.equal(sharedTransitionState(a, map, dir).complete, false);
    map.set(f.path, {...map.get(join(dir, 'next'))!, path: f.path}); map.set(join(dir, 'next'), null); recount(map);
    sharedTransitionState(a, map, dir);
  }
  assert.equal(sharedTransitionState(a, map, dir).complete, true);
  const noBackup = structuredClone(map); noBackup.set(join(dir, '0.original'), null); recount(noBackup);
  assert.throws(() => sharedTransitionState(a, noBackup, dir), /backup is missing/);
  a.recoveryState = 'applied';
  for (const name of ['0.original', 'output']) {map.set(join(dir, name), null); recount(map); assert.ok(sharedTransitionState(a, map, dir).complete);}
  for (const changes of [{ino: 9}, {nlink: 9}, {size: 79}, {mtimeMs: now}, {mode: 0o100644}]) {
    const bad = structuredClone(map); Object.assign(bad.get(a.files[0].path)!, changes);
    assert.throws(() => sharedTransitionState(a, bad, dir));
  }
});

test('shared dedup transitions retain compressed paths through partial linking and unlinking', () => {
  const a = receipt(true).actions[0], s = a.codexShared!, map = entries(a);
  s.started = true; map.set(join(dir, '0.original'), {...a.files[0], path: join(dir, '0.original')}); recount(map);
  assert.equal(sharedTransitionState(a, map, dir).complete, false);
  const premature = structuredClone(map); premature.set(a.files[0].path, null); recount(premature);
  assert.throws(() => sharedTransitionState(a, premature, dir), /Compressed aliases must exist/);
  for (const path of s.compressedLinks) map.set(path, {...a.files[1], path}); recount(map);
  for (const f of s.groups[0]) {map.set(f.path, null); recount(map); sharedTransitionState(a, map, dir);}
  assert.ok(sharedTransitionState(a, map, dir).complete);
  map.set(join(dir, '0.original'), null); recount(map);
  assert.throws(() => sharedTransitionState(a, map, dir), /backup is missing/);
  a.recoveryState = 'applied';
  assert.ok(sharedTransitionState(a, map, dir).complete);
  map.set(a.files[1].path, null); recount(map);
  assert.throws(() => sharedTransitionState(a, map, dir));
});

test('shared receipts validate cross-home index identity, path closure and lifecycle', () => {
  const projection = {name: 'thread_history_1.sqlite', dev: 1, ino: 10, threadId: 'one',
    schemaHash: 'c'.repeat(64), beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64)};
  const r = receipt(), a = r.actions[0];
  a.codexProjection = [projection]; a.codexShared!.homes[0].codexProjection = [projection];
  a.codexShared!.homes[1].codexProjection = [{...projection, ino: 11}];
  assert.equal(validateReceipt(r), r);
  for (const change of [
    (a: Action) => {a.codexShared!.homes[0].codexProjection = [];},
    (a: Action) => {a.codexShared!.homes[1].codexProjection![0].threadId = 'other';},
    (a: Action) => {a.codexShared!.groups[0][1] = a.codexShared!.groups[0][0];},
    (a: Action) => {a.codexShared!.groups[0][1] = null as any;},
    (a: Action) => {a.files[0].uid = (process.getuid?.() ?? 0) + 1;},
    (a: Action) => {a.recoveryState = 'applied';},
    (a: Action) => {a.codexShared!.started = true;}, // Started actions must journal the expected size.
  ]) {
    const bad = structuredClone(r); change(bad.actions[0]); assert.throws(() => validateReceipt(bad), /operation receipt/);
  }
  for (const dedup of [false, true]) {
    const live = receipt(dedup), action = live.actions[0];
    action.codexShared!.started = true; action.afterBytes = action.beforeBytes - action.estimatedSavingsBytes!;
    assert.equal(validateReceipt(live), live);
    if (!dedup) {action.codexShared!.outputIdentity = {dev: 1, ino: 3}; assert.equal(validateReceipt(live), live);}
    action.status = 'completed'; action.recoveryState = 'applied'; live.confirmedReductionBytes = action.estimatedSavingsBytes!;
    assert.equal(validateReceipt(live), live);
    action.recoveryState = 'finalized'; assert.equal(validateReceipt(live), live);
    const invalid = structuredClone(live); invalid.actions[0].codexShared!.started = false;
    assert.throws(() => validateReceipt(invalid));
  }
  for (const links of [[], [file(roots[1], true).path, file(roots[0], true).path]]) {
    const bad = receipt(true); bad.actions[0].codexShared!.compressedLinks = links;
    assert.throws(() => validateReceipt(bad));
  }
  for (const kind of ['paths', 'inodes', 'output-inode'] as const) {
    const bad = receipt(), extra = structuredClone(bad.actions[0]); extra.id = randomUUID();
    if (kind !== 'paths') for (const f of new Set([...extra.files, ...extra.codexShared!.groups.flat()])) {
      f.path = f.path.replace('one.jsonl', 'two.jsonl'); f.relative = f.relative.replace('one.jsonl', 'two.jsonl');
      if (kind === 'output-inode') f.ino = 3;
    }
    if (kind === 'output-inode') {
      bad.actions[0].codexShared!.started = true; bad.actions[0].afterBytes = 80;
      bad.actions[0].codexShared!.outputIdentity = {dev: 1, ino: 3};
    }
    bad.actions.push(extra); assert.throws(() => validateReceipt(bad));
    bad.actions.reverse(); assert.throws(() => validateReceipt(bad));
  }
});

test('shared receipts restrict all aliases, destinations, projections and journal identities', () => {
  for (const dedup of [false, true]) {
    const r = receipt(dedup); assert.equal(validateReceipt(r), r);
    for (const change of [
      (a: Action) => {a.codexShared!.homes[1].root = '/arbitrary';},
      (a: Action) => {a.codexShared!.homes[1].codexProjection = undefined;},
      (a: Action) => {a.codexShared!.groups[0].pop();},
      (a: Action) => {a.codexShared!.groups[0][1].ino++;},
      (a: Action) => {a.codexShared!.groups[0][1].path = join(roots[1], 'config.toml');},
      (a: Action) => {a.codexShared!.compressedLinks.push(join(roots[1], 'config.toml'));},
      (a: Action) => {a.codexShared!.outputIdentity = {dev: 1, ino: 1};},
      (a: Action) => {a.codexShared!.started = 'yes' as any;},
      (a: Action) => {a.codexShared!.groups[0][1].mode = 0o100666;},
    ]) {
      const bad = structuredClone(r); change(bad.actions[0]); assert.throws(() => validateReceipt(bad));
    }
  }
});

test('failed final checkpoints remain recoverable after transaction files are discarded', () => {
  for (const dedup of [false, true]) {
    const r = receipt(dedup), a = r.actions[0], s = a.codexShared!, map = entries(a);
    s.started = true; a.status = 'failed'; a.recoveryState = 'applied';
    a.afterBytes = a.beforeBytes - a.estimatedSavingsBytes!;
    if (dedup) {
      for (const path of s.compressedLinks) map.set(path, {...a.files[1], path});
      for (const f of s.groups[0]) map.set(f.path, null);
    } else {
      s.outputIdentity = {dev: 1, ino: 3};
      for (const f of s.groups[0]) map.set(f.path, {...f, ino: 3, size: a.afterBytes});
    }
    recount(map);
    assert.equal(validateReceipt(r), r);
    assert.ok(sharedTransitionState(a, map, dir).complete);
    a.recoveryState = 'finalized';
    assert.throws(() => validateReceipt(r), /operation receipt/);
  }
});

test('shared age and activity protection cover other homes even with an explicit target', async () => {
  for (const mtime of [cutoff - 1, cutoff, now, NaN]) {
    const r = receipt(), a = r.actions[0]; a.codexShared!.groups[0][1].mtimeMs = mtime;
    assert.equal(ageProtectionReason(a, a.files[0].path, now) === null, mtime < cutoff);
  }
  const r = receipt(), calls: string[] = [];
  await protectActiveContent(r, async (_provider, root, paths) => {
    calls.push(root); assert.ok(paths!.includes(file(roots[1]).path));
    return root === roots[1] ? 'Idle open session in another home' : null;
  });
  assert.deepEqual(calls, roots); assert.equal(r.actions.length, 0);
});

test('shared file details expose all homes and compressed destinations without multiplying savings', () => {
  const r = receipt(true), tree = cleanupFileNodes([r]);
  assert.equal(tree[0].bytes, 100);
  const detail = tree[0].children![0].children![0].detail!;
  for (const path of [file(roots[1]).path, file(roots[1], true).path]) assert.ok(detail.includes(path));
});
