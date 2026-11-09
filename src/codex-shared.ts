import { lstat, readdir, realpath, open, link, rename, unlink, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileEntry, Inventory } from './types.ts';
import type { Action } from './clean.ts';
import { physicalKey, scanRoot } from './scan.ts';
import { existingDir, privateDir, within } from './state.ts';
import { activityReason, type ActivityCheck } from './activity.ts';
import { slimHistory, MAX_HISTORY_BYTES } from './slim.ts';
import { decodeDuplicateHistory, previewProjection, prepareProjection, verifyProjectionBefore, verifyCodexRewriteLayout, type ProjectionReceipt } from './providers/codex-history.ts';

export interface SharedHistory {
  homes: {root: string; dev: number; ino: number; codexProjection?: ProjectionReceipt[]}[];
  groups: FileEntry[][];
  compressedLinks: string[];
  started?: boolean;
  outputIdentity?: {dev: number; ino: number};
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const unchanged = {removeImages: false, compactTools: false};
const exec = promisify(execFile);
const uid = () => process.getuid?.();
const history = /^(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/;
const account = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function knownCodexHome(root: string, userHome = homedir()): boolean {
  if (root === join(userHome, '.codex')) return true;
  const [app, ...parts] = relative(join(userHome, 'Library/Application Support'), root).split('/');
  return /^orca$/i.test(app) && (parts.join('/') === 'codex-runtime-home/home' ||
    parts.length === 3 && parts[0] === 'codex-accounts' && account.test(parts[1]) && parts[2] === 'home');
}
const maybeStat = async (path: string) => lstat(path).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
async function safeDirectory(path: string) {
  // existingDir checks every ancestor for links; realpath may only correct casing on macOS.
  if (!await existingDir(path)) throw new Error('Shared history directory is missing or linked');
  const s = await lstat(path);
  if (uid() === undefined || s.uid !== uid() || s.mode & 0o022) throw new Error('Shared history directory ownership or permissions are unsafe');
  return s;
}
export async function discoverCodexHomes(primary: string, userHome = homedir()): Promise<string[]> {
  if (!knownCodexHome(primary, userHome)) return [primary];
  const support = join(userHome, 'Library/Application Support'), roots = [join(userHome, '.codex')];
  if (await existingDir(support)) for (const app of await readdir(support)) if (/^orca$/i.test(app)) {
    const orca = join(support, app), accounts = join(orca, 'codex-accounts');
    await safeDirectory(orca);
    roots.push(join(orca, 'codex-runtime-home/home'));
    if (await maybeStat(accounts)) {
      await safeDirectory(accounts);
      for (const name of await readdir(accounts)) if (account.test(name)) roots.push(join(accounts, name, 'home'));
    }
  }
  const found = new Set<string>();
  for (const root of roots) if (await maybeStat(root)) {await safeDirectory(root); found.add(await realpath(root));}
  await safeDirectory(primary); primary = await realpath(primary);
  if (!found.has(primary)) throw new Error('Primary Codex home disappeared');
  return [primary, ...[...found].filter(r => r !== primary).sort()];
}
export async function sharedInventories(inv: Inventory, signal?: AbortSignal): Promise<Inventory[]> {
  const roots = await discoverCodexHomes(inv.root), result = [inv];
  for (const root of roots.slice(1)) result.push(await scanRoot(root, 'codex', signal));
  if (result.some(i => !i.complete)) throw new Error('Shared history requires complete scans of all Codex homes');
  return result;
}
// Pure metadata grouping: a second pathname is an alias only when every inode link is accounted for.
export function sharedHistoryGroups(files: FileEntry[], inventories: Inventory[]): Pick<SharedHistory, 'groups' | 'compressedLinks'> {
  const all = inventories.flatMap(i => i.files);
  const groups = files.map(file => {
    const group = all.filter(f => physicalKey(f) === physicalKey(file));
    if (group.length !== file.nlink || new Set(group.map(f => f.path)).size !== group.length || group.some(f =>
      f.relative !== file.relative || !history.test(f.relative) || ['size','dev','ino','nlink','mtimeMs','ctimeMs','mode'].some(k => f[k as keyof FileEntry] !== file[k as keyof FileEntry])))
      throw new Error('History has unknown hard links or mismatched copies; retained');
    return group;
  });
  const compressedLinks = files.length === 2 ? groups[0].map(f => f.path + '.zst').filter(path => !groups[1].some(f => f.path === path)) : [];
  if (compressedLinks.some(path => all.some(f => f.path === path) || inventories.some(i => i.links.some(l => l.path === path))))
    throw new Error('Compressed alias destination already exists');
  return {groups, compressedLinks};
}
export async function sharedHistoryScope(files: FileEntry[], inventories: Inventory[]): Promise<SharedHistory | undefined> {
  if (files.every(f => f.nlink === 1)) return undefined;
  if (inventories.length < 2 || inventories.some(i => !knownCodexHome(i.root))) throw new Error('Hard links outside known Codex homes are unsupported');
  const scope: SharedHistory = {...sharedHistoryGroups(files, inventories), homes: []};
  for (const inv of inventories) {
    const s = await safeDirectory(inv.root); scope.homes.push({root: inv.root, dev: s.dev, ino: s.ino});
  }
  await verifySharedOriginals(scope);
  return scope;
}
export const sharedFiles = (a: Action) => a.codexShared?.groups.flat() ?? a.files;
export const sharedPaths = (a: Action) => [...sharedFiles(a).map(f => f.path), ...a.codexShared?.compressedLinks ?? []];
async function verifyHomes(scope: SharedHistory) {
  const roots = await discoverCodexHomes(scope.homes[0].root);
  if (JSON.stringify(roots) !== JSON.stringify(scope.homes.map(h => h.root))) throw new Error('Codex home set changed; preview again');
  for (const home of scope.homes) {
    const s = await safeDirectory(home.root);
    if (s.dev !== home.dev || s.ino !== home.ino) throw new Error('Codex home identity changed');
  }
  for (const path of [...scope.groups.flat().map(f => f.path), ...scope.compressedLinks]) {
    const home = scope.homes.find(h => within(h.root, path));
    if (!home) throw new Error('Shared path is outside known homes');
    let cursor = dirname(path);
    while (cursor !== home.root) {await safeDirectory(cursor); cursor = dirname(cursor);}
  }
}
export async function readSharedFile(file: FileEntry): Promise<Buffer> {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const check = async () => {
    if (await realpath(file.path) !== file.path) throw new Error('Shared file parent changed');
    for (const s of [await handle.stat(), await lstat(file.path)]) if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid() || s.mode & 0o022 ||
      ['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'].some(k => s[k as keyof typeof s] !== file[k as keyof FileEntry])) throw new Error('Shared history changed');
  };
  try {
    await check();
    if (file.size > MAX_HISTORY_BYTES) throw new Error('Shared history exceeds 64 MiB');
    const data = Buffer.alloc(file.size + 1); let length = 0;
    while (length < data.length) {const r = await handle.read(data, length, data.length - length, length); if (!r.bytesRead) break; length += r.bytesRead;}
    await check(); if (length !== file.size) throw new Error('Shared history size changed');
    return data.subarray(0, length);
  } finally {await handle.close();}
}
async function verifySharedOriginals(scope: SharedHistory) {
  await verifyHomes(scope);
  for (const group of scope.groups) for (const f of group) {
    const s = await lstat(f.path);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid() || s.mode & 0o022 ||
      ['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'].some(k => s[k as keyof typeof s] !== f[k as keyof FileEntry])) throw new Error('Shared history changed since scan');
  }
  for (const path of scope.compressedLinks) if (await maybeStat(path)) throw new Error('Compressed alias destination appeared');
}
export async function previewSharedProjection(a: Action, input: Buffer, output: Buffer) {
  const scope = a.codexShared!;
  await verifySharedOriginals(scope);
  for (const home of scope.homes) home.codexProjection = await previewProjection(home.root, input, output, a.slimOptions ?? unchanged);
  a.codexProjection = scope.homes[0].codexProjection;
}
export async function sharedActivity(a: Action, check: ActivityCheck, dir?: string): Promise<string | null> {
  const paths = sharedPaths(a);
  if (dir) paths.push(...['0.original', 'output', 'next'].map(n => join(dir, n)));
  const present: string[] = [];
  for (const path of paths) if (await maybeStat(path)) present.push(path);
  for (const home of a.codexShared!.homes) {
    const result = await check('codex', home.root, present);
    const reason = activityReason(result, home.root, present);
    if (reason) return reason;
  }
  return null;
}

// Pure crash-state validation; never infer ownership from equal content alone.
export function sharedTransitionState(a: Action, entries: Map<string, FileEntry | null>, dir: string) {
  const scope = a.codexShared!, original = a.files[0], compressed = a.files[1];
  const backup = join(dir, '0.original'), output = join(dir, 'output'), next = join(dir, 'next');
  const plainPaths = new Set(scope.groups[0].map(f => f.path));
  const compressedPaths = new Set([...(scope.groups[1] ?? []).map(f => f.path), ...scope.compressedLinks]);
  const expectedPaths = new Set([...plainPaths, ...compressedPaths, backup, output, next]);
  if (entries.size !== expectedPaths.size || [...expectedPaths].some(path => !entries.has(path))) throw new Error('Shared transaction evidence is incomplete');
  const unrecordedOutput = !scope.outputIdentity ? entries.get(output) ?? null : null;
  if (unrecordedOutput && (a.kind !== 'slim-history' || !scope.started || a.recoveryState !== 'prepared' ||
    entries.get(backup) || entries.get(next) || unrecordedOutput.dev !== original.dev || unrecordedOutput.ino === original.ino ||
    unrecordedOutput.nlink !== 1 || !Number.isSafeInteger(unrecordedOutput.size) || unrecordedOutput.size < 0 || unrecordedOutput.size > a.afterBytes ||
    unrecordedOutput.mode & 0o7777 & ~(original.mode & 0o777) || scope.groups.flat().some(f => {
      const current = entries.get(f.path);
      return !current || (['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'] as const).some(k => current[k] !== f[k]);
    }))) throw new Error('Interrupted output requires unchanged originals and no replacement links');
  const counts = new Map<string, number>(); let remaining = 0, changed = 0;
  for (const [path, file] of entries) {
    if (!plainPaths.has(path) && !compressedPaths.has(path) && ![backup, output, next].includes(path)) throw new Error('Unknown shared transaction path');
    if (!file) {
      if (plainPaths.has(path) && a.kind !== 'deduplicate-history' || scope.groups[1]?.some(f => f.path === path)) throw new Error('Shared history disappeared');
      continue;
    }
    if (file.path !== path || !Number.isSafeInteger(file.nlink) || file.nlink < 1 || (file.mode & 0o170000) !== 0o100000 || file.mode & 0o022 ||
      file.uid !== undefined && file.uid !== uid()) throw new Error('Unsafe shared transaction metadata');
    let expected: FileEntry;
    if (file === unrecordedOutput) expected = file;
    else if ((plainPaths.has(path) || path === backup) && physicalKey(file) === physicalKey(original)) {expected = original; if (plainPaths.has(path)) remaining++;}
    else if (compressedPaths.has(path) && compressed && physicalKey(file) === physicalKey(compressed)) expected = compressed;
    else if ((plainPaths.has(path) || path === output || path === next) && a.kind === 'slim-history' && scope.outputIdentity &&
      file.dev === scope.outputIdentity.dev && file.ino === scope.outputIdentity.ino) {
      expected = {...original, size: a.afterBytes, mode: (original.mode & 0o777) | 0o100000};
      if (plainPaths.has(path)) changed++;
    } else throw new Error('Shared history inode changed; transaction retained for review');
    if (file.size !== expected.size || Math.abs(file.mtimeMs - expected.mtimeMs) > (expected === original || expected === compressed ? 0 : 0.01) || file.mode !== expected.mode)
      throw new Error('Shared history metadata changed; transaction retained for review');
    counts.set(physicalKey(file), (counts.get(physicalKey(file)) ?? 0) + 1);
  }
  for (const file of entries.values()) if (file && file.nlink !== counts.get(physicalKey(file))) throw new Error('Shared history gained an unaccounted link');
  const complete = a.kind === 'deduplicate-history' ? remaining === 0 && [...compressedPaths].every(p => entries.get(p)) : changed === plainPaths.size;
  if (remaining < plainPaths.size && !entries.get(backup) && !(complete && a.recoveryState !== 'prepared'))
    throw new Error('Original shared history backup is missing');
  if (a.kind === 'deduplicate-history' && remaining < plainPaths.size && [...compressedPaths].some(p => !entries.get(p)))
    throw new Error('Compressed aliases must exist before removing original paths');
  if (a.kind === 'slim-history' && scope.outputIdentity && !complete && !entries.get(output)) throw new Error('Shared staged output is missing');
  return {complete, remaining, unrecordedOutput};
}
async function inspectTransition(a: Action, dir: string) {
  await verifyHomes(a.codexShared!);
  await safeDirectory(dir);
  if ((await lstat(dir)).mode & 0o077 || (await lstat(dir)).dev !== a.files[0].dev) throw new Error('Shared transaction directory is unsafe');
  if ((await readdir(dir)).some(n => !['0.original','output','next'].includes(n))) throw new Error('Unknown shared transaction files');
  const entries = new Map<string, FileEntry | null>();
  for (const path of [...sharedPaths(a), ...['0.original','output','next'].map(n => join(dir, n))]) {
    const s = await maybeStat(path);
    if (s && (!s.isFile() || s.isSymbolicLink() || s.uid !== uid() || s.mode & 0o022)) throw new Error('Unsafe shared transaction file');
    entries.set(path, s ? {path, relative: '', size: s.size, allocatedBytes: s.blocks * 512, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs,
      dev: s.dev, ino: s.ino, nlink: s.nlink, mode: s.mode, uid: s.uid, category: 'sessions'} : null);
  }
  return {entries, ...sharedTransitionState(a, entries, dir)};
}
async function syncDir(path: string) {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try {await h.sync();} finally {await h.close();}
}
export async function verifyHistoryDependencies(a: Action, root: string, signal?: AbortSignal) {
  const scope = a.codexShared, inventories: Inventory[] = [];
  const roots = scope ? scope.homes.map(h => h.root) : await discoverCodexHomes(root);
  for (const home of roots) inventories.push(await scanRoot(home, 'codex', signal));
  const coordinated = scope?.groups.map(g => g.map(f => f.path)) ?? [];
  if (scope && a.kind === 'deduplicate-history') coordinated[1].push(...scope.compressedLinks);
  const blocked = await verifyCodexRewriteLayout(inventories[0], signal, a.kind === 'deduplicate-history', inventories.slice(1), coordinated);
  for (const path of sharedPaths(a)) {
    if (blocked.has(path)) throw new Error(blocked.get(path));
    for (const inv of inventories) if (inv.links.some(l => {const target = resolve(dirname(l.path), l.target); return target === path || within(target, path) || within(path, target);}))
      throw new Error('Shared history has a symbolic reference');
  }
}
async function prepareSharedProjection(a: Action, input: Buffer | null, output: Buffer, recovery: boolean) {
  const transactions: Awaited<ReturnType<typeof prepareProjection>>[] = [];
  try {
    for (const home of a.codexShared!.homes) {
      if (!home.codexProjection) throw new Error('Shared history index preview is missing');
      transactions.push(await prepareProjection(home.root, home.codexProjection, input, output, a.slimOptions ?? unchanged, recovery));
    }
    return {
      async commit() {try {for (const tx of transactions) await tx.commit();} finally {for (const tx of transactions) tx.rollback();}},
      rollback() {for (const tx of transactions) tx.rollback();},
    };
  } catch (error) {for (const tx of transactions) tx.rollback(); throw error;}
}
// Roll forward a journaled multi-home operation. Backups survive every partial file/index commit.
export async function applySharedHistory(a: Action, dir: string, check: ActivityCheck, save: () => Promise<void>, recovery = false) {
  const scope = a.codexShared!, original = a.files[0], backup = join(dir, '0.original'), outputPath = join(dir, 'output');
  const ensureInactive = async () => {const reason = await sharedActivity(a, check, dir); if (reason) throw new Error(reason);};
  const ensureAge = () => {if (sharedFiles(a).some(f => !Number.isFinite(f.mtimeMs) || Date.now() - f.mtimeMs <= 72 * 3600000)) throw new Error('72-hour protection: shared history retained');};
  // Re-read each live inode at destructive boundaries; our own links change ctime and nlink.
  const verify = async () => {
    ensureAge(); await ensureInactive();
    const state = await inspectTransition(a, dir), seen = new Set<string>();
    for (const file of state.entries.values()) {
      if (!file || file === state.unrecordedOutput || seen.has(physicalKey(file))) continue;
      seen.add(physicalKey(file));
      const expected = physicalKey(file) === physicalKey(original) ? a.beforeHash : a.afterHash;
      if (hash(await readSharedFile(file)) !== expected) throw new Error('Shared history differs from preview');
      if (process.platform === 'darwin') {
        const {stdout} = await exec('/usr/bin/xattr', [file.path], {timeout: 5000});
        if (stdout.trim()) throw new Error('History has extended attributes; retained');
      }
    }
    return state;
  };
  ensureAge(); await ensureInactive(); await verifyHomes(scope);
  if (!scope.started) {
    await verifySharedOriginals(scope);
    await privateDir(dir);
    if ((await lstat(dir)).dev !== original.dev || scope.groups.flat().some(f => f.dev !== original.dev)) throw new Error('Shared histories and transaction storage must use the same filesystem');
    if ((await readdir(dir)).length) throw new Error('Shared transaction directory is not empty');
    const space = await statfs(dir); if (space.bavail * space.bsize < a.beforeBytes * 2 + 1024 * 1024) throw new Error('Insufficient working space');
    await verify();
    a.afterBytes = a.kind === 'deduplicate-history' ? a.files[1].size : a.beforeBytes - a.estimatedSavingsBytes!;
    scope.started = true; await save();
  }
  let state = await verify();
  // A crash during staging cannot have changed originals or indexes; rebuild only with that evidence.
  if (state.unrecordedOutput) {
    for (const home of scope.homes) {
      if (!home.codexProjection) throw new Error('Shared history index preview is missing');
      await verifyProjectionBefore(home.root, home.codexProjection);
    }
    const current = (await verify()).unrecordedOutput;
    if (!current || physicalKey(current) !== physicalKey(state.unrecordedOutput)) throw new Error('Interrupted output changed');
    await unlink(outputPath); await syncDir(dir);
    state = await verify();
  }
  const old = [...state.entries.values()].find(f => f && physicalKey(f) === physicalKey(original));
  let input = old ? await readSharedFile(old) : null, output: Buffer;
  if (a.kind === 'deduplicate-history') {
    const bytes = await readSharedFile(state.entries.get(a.files[1].path)!);
    output = await decodeDuplicateHistory(bytes, original.size);
    if (hash(bytes) !== a.afterHash || hash(output) !== a.beforeHash || input && !input.equals(output)) throw new Error('Shared compressed history differs from preview');
    input = output;
  } else if (input) {
    const result = slimHistory(input, 'codex', a.slimOptions!);
    if (!result.output || result.output.length !== a.afterBytes || hash(result.output) !== a.afterHash) throw new Error('Shared transformation differs from preview');
    output = result.output;
    if (!scope.outputIdentity) {
      const out = await open(outputPath, 'wx', original.mode & 0o777);
      try {
        await out.writeFile(output); await out.chmod(original.mode & 0o777); await out.utimes(original.mtimeMs / 1000, original.mtimeMs / 1000); await out.sync();
        const s = await out.stat(); scope.outputIdentity = {dev: s.dev, ino: s.ino};
      } finally {await out.close();}
      await syncDir(dir); await save();
    }
  } else {
    if (!state.complete || a.recoveryState !== 'applied') throw new Error('Original shared history backup is missing');
    output = await readSharedFile(state.entries.get(original.path)!);
  }
  if (a.kind === 'slim-history' && hash(output) !== a.afterHash) throw new Error('Shared output differs from preview');
  await verify();
  const tx = await prepareSharedProjection(a, input, output, recovery);
  try {
    await verifyHistoryDependencies(a, scope.homes[0].root);
    state = await verify();
    if (!state.complete) {
      if (!state.entries.get(backup)) {
        const source = [...state.entries.values()].find(f => f && physicalKey(f) === physicalKey(original));
        if (!source) throw new Error('Original shared history is unavailable');
        await link(source.path, backup); await syncDir(dir);
      }
      if (a.kind === 'deduplicate-history') for (const path of scope.compressedLinks) {
        state = await verify();
        if (!state.entries.get(path)) {await link(a.files[1].path, path); await syncDir(dirname(path));}
      }
      for (const file of scope.groups[0]) {
        state = await verify();
        const current = state.entries.get(file.path);
        if (!current || physicalKey(current) !== physicalKey(original)) continue;
        if (a.kind === 'deduplicate-history') await unlink(file.path);
        else {
          const next = join(dir, 'next');
          if (!state.entries.get(next)) {await link(outputPath, next); await syncDir(dir);}
          await verify();
          await rename(next, file.path);
        }
        await syncDir(dirname(file.path)); await syncDir(dir);
      }
    }
    if (!(await verify()).complete) throw new Error('Shared update is incomplete');
    await tx.commit();
  } catch (error) {tx.rollback(); throw error;}
  a.status = 'completed'; a.recoveryState = 'applied'; await save();
  // Require every index to be at its committed after-state before discarding the original inode.
  const committed = await prepareSharedProjection(a, null, output, true);
  try {
    for (const name of ['next', '0.original', 'output']) {
      state = await verify();
      if (!state.complete) throw new Error('Shared update is incomplete');
      const path = join(dir, name); if (state.entries.get(path)) {await unlink(path); await syncDir(dir);}
    }
    await committed.commit();
  } catch (error) {committed.rollback(); throw error;}
  a.recoveryState = 'finalized'; delete a.reason;
  try {await save();} catch (error) {a.recoveryState = 'applied'; throw error;}
}
