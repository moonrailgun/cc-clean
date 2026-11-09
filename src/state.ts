import { mkdir, lstat, open, rename, readdir, readlink, unlink } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, parse, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Provider } from './types.ts';
import type { Receipt } from './clean.ts';
import { scopedTempKind, tempExcluded, type SystemTempScope } from './system-temp.ts';
import { validSessionTempEvidence } from './session-temp.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r);
}

async function statePath(path: string): Promise<string> {
  if (path.split(sep).includes('..')) throw new Error('Application path contains an unresolved parent segment');
  const absolute = resolve(path);
  // macOS exposes its system temporary directories through these root-owned aliases.
  const alias = process.platform === 'darwin' ? /^\/(var|tmp)(?:\/|$)/.exec(absolute) : null;
  if (alias) {
    const prefix = `/${alias[1]}`, target = `/private${prefix}`, s = await lstat(prefix);
    if (s.isSymbolicLink() && s.uid === 0 && resolve('/', await readlink(prefix)) === target)
      return target + absolute.slice(prefix.length);
  }
  return absolute;
}
async function checkDir(path: string, create: boolean): Promise<boolean> {
  const absolute = await statePath(path);
  let cursor = parse(absolute).root;
  for (const part of relative(cursor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let s;
    try { s = await lstat(cursor); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (!create) return false;
      try { await mkdir(cursor, {mode: 0o700}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      s = await lstat(cursor);
    }
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Application directory is a symlink or not a directory');
  }
  return true;
}
export async function existingDir(path: string): Promise<boolean> { return checkDir(path, false); }
export async function privateDir(path: string): Promise<void> { await checkDir(path, true); }

function ordinary(s: Stats, maxBytes: number): boolean {
  return s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= maxBytes;
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}
export async function readOrdinaryFile(path: string, maxBytes = MAX_JSON_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid file read size limit');
  path = await statePath(path);
  if (!await existingDir(dirname(path))) throw Object.assign(new Error('File directory is missing'), {code: 'ENOENT'});
  const before = await lstat(path);
  if (!ordinary(before, maxBytes)) throw new Error('File is not an independent regular file or exceeds the read limit');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!ordinary(opened, maxBytes) || !sameFile(before, opened)) throw new Error('File changed before reading');
    const data = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < data.length) {
      const {bytesRead} = await file.read(data, length, data.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== opened.size || !sameFile(opened, await file.stat()) ||
      !await existingDir(dirname(path)) || !sameFile(opened, await lstat(path))) throw new Error('File changed while reading');
    return data.subarray(0, length);
  } finally { await file.close(); }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cannot serialize JSON');
  await atomicWrite(path, serialized + '\n');
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_JSON_BYTES) throw new Error('Data exceeds the record size limit');
  path = await statePath(path);
  await privateDir(dirname(path));
  try {
    if (!ordinary(await lstat(path), MAX_JSON_BYTES)) throw new Error('Target record is not an independent regular file');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(tmp, 'wx', 0o600);
  let renamed = false;
  try {
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    if (!await existingDir(dirname(path))) throw new Error('Application directory changed while writing');
    await rename(tmp, path); renamed = true;
    const dir = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    if (!renamed && await existingDir(dirname(path)))
      await unlink(tmp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bytes(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function text(value: unknown): value is string { return typeof value === 'string'; }
function timestamp(value: unknown): boolean {
  return text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function absolute(value: unknown): value is string {
  return text(value) && !value.includes('\0') && isAbsolute(value) && resolve(value) === value;
}
function requireReceipt(valid: unknown): asserts valid {
  if (!valid) throw new Error('Unrecognized or inconsistent operation receipt; processing stopped');
}

/** Structural validation only; recovery must still verify source and backup identities. */
export function validateReceipt(data: unknown, provider?: Provider): Receipt {
  requireReceipt(object(data));
  requireReceipt(data.schemaVersion === 1 && text(data.operationId) && uuid.test(data.operationId));
  requireReceipt((data.provider === 'claude' || data.provider === 'codex') && (!provider || data.provider === provider));
  requireReceipt(absolute(data.root) && data.root !== parse(data.root).root && text(data.version) && data.version.length > 0);
  requireReceipt(data.explicitTarget === undefined || (text(data.explicitTarget) &&
    (uuid.test(data.explicitTarget) || absolute(data.explicitTarget) && within(data.root, data.explicitTarget))));
  requireReceipt(data.rootIdentity === undefined || (object(data.rootIdentity) && bytes(data.rootIdentity.dev) && bytes(data.rootIdentity.ino)));
  requireReceipt(data.codexIndexFingerprint === undefined || (text(data.codexIndexFingerprint) && /^[0-9a-f]{64}$/.test(data.codexIndexFingerprint)));
  if (data.systemTemp !== undefined) {
    requireReceipt(object(data.systemTemp) && bytes(data.systemTemp.uid) && Array.isArray(data.systemTemp.excludedRoots) && data.systemTemp.excludedRoots.every(absolute));
    requireReceipt(data.systemTemp.session === undefined || validSessionTempEvidence(data.systemTemp.session, data.root, data.provider));
    requireReceipt(data.explicitTarget === undefined && data.codexIndexFingerprint === undefined && data.source === 'clean');
  }
  const tempScope = data.systemTemp as SystemTempScope | undefined;
  requireReceipt(['clean', 'analyze'].includes(data.source as string) && timestamp(data.startedAt) &&
    (data.executionStartedAt === undefined || timestamp(data.executionStartedAt)) &&
    (data.finishedAt === undefined || timestamp(data.finishedAt)) && typeof data.scanComplete === 'boolean');
  requireReceipt(Array.isArray(data.warnings) && data.warnings.every(text) && Array.isArray(data.actions));
  requireReceipt(['completed', 'partial', 'failed', 'interrupted', 'needs-review', 'dry-run'].includes(data.status as string));
  requireReceipt((data.rootBeforeBytes === null || bytes(data.rootBeforeBytes)) && (data.rootAfterBytes === null || bytes(data.rootAfterBytes)) &&
    Number.isSafeInteger(data.confirmedReductionBytes) && typeof data.attributionComplete === 'boolean');
  const ids = new Set<string>(), paths = new Set<string>();
  let total = 0;
  for (const action of data.actions) {
    requireReceipt(object(action) && text(action.id) && uuid.test(action.id) && !ids.has(action.id));
    ids.add(action.id);
    requireReceipt(['delete-files', 'compress-png', 'codex-delete', 'slim-history'].includes(action.kind as string) && text(action.targetId) && action.targetId.length > 0);
    requireReceipt(['planned', 'completed', 'skipped', 'failed'].includes(action.status as string) &&
      ['prepared', 'applied', 'finalized'].includes(action.recoveryState as string));
    requireReceipt(bytes(action.beforeBytes) && bytes(action.afterBytes) && (action.reason === undefined || text(action.reason)));
    requireReceipt(action.estimatedSavingsBytes === undefined || action.estimatedSavingsBytes === null ||
      (bytes(action.estimatedSavingsBytes) && action.estimatedSavingsBytes <= action.beforeBytes));
    requireReceipt(action.nativeStarted === undefined || typeof action.nativeStarted === 'boolean');
    requireReceipt(action.sessionIds === undefined || (Array.isArray(action.sessionIds) && action.sessionIds.length > 0 &&
      action.sessionIds.every((id: unknown) => text(id) && (data.provider === 'codex' ? uuid.test(id) : id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(id))) &&
      new Set(action.sessionIds).size === action.sessionIds.length));
    for (const key of ['beforeHash', 'afterHash']) requireReceipt(action[key] === undefined || (text(action[key]) && /^[0-9a-f]{64}$/.test(action[key])));
    requireReceipt(Array.isArray(action.files) && action.files.length > 0);
    if (tempScope) requireReceipt(data.rootIdentity && action.kind === 'delete-files' && action.files.length === 1 &&
      ['sessionIds', 'nativeStarted', 'slimOptions', 'slimCounts', 'slimSavingsBytes', 'codexProjection', 'beforeHash', 'afterHash'].every(key => action[key] === undefined));
    let fileBytes = 0;
    for (const file of action.files) {
      requireReceipt(object(file) && absolute(file.path) && within(data.root, file.path) && !paths.has(file.path));
      paths.add(file.path);
      requireReceipt(file.relative === relative(data.root, file.path) && bytes(file.size) && bytes(file.allocatedBytes) &&
        Number.isFinite(file.mtimeMs) && Number.isFinite(file.ctimeMs) && bytes(file.dev) && bytes(file.ino) && file.nlink === 1 && bytes(file.mode) && text(file.category));
      requireReceipt(file.uid === undefined || bytes(file.uid));
      if (tempScope) requireReceipt(file.uid === tempScope.uid && !(file.mode & 0o022) && (file.mode & 0o170000) === 0o100000 &&
        !tempExcluded(file.path, tempScope) && scopedTempKind(data.root, file.path, data.provider, tempScope) === file.category);
      if (tempScope?.session?.kind === 'file') requireReceipt(file.dev === tempScope.session.dev && file.ino === tempScope.session.ino);
      fileBytes += file.size; requireReceipt(Number.isSafeInteger(fileBytes));
    }
    requireReceipt(action.kind === 'codex-delete' || action.beforeBytes === fileBytes);
    if (action.kind === 'compress-png' || action.kind === 'slim-history') {
      requireReceipt(action.files.length === 1 && action.afterBytes <= action.beforeBytes);
      if (action.status === 'completed') requireReceipt(action.beforeHash && action.afterHash);
    }
    if (action.kind === 'slim-history') {
      const options = action.slimOptions;
      requireReceipt(object(options));
      requireReceipt(action.sessionIds === undefined && object(action.slimOptions) &&
        typeof action.slimOptions.removeImages === 'boolean' && typeof action.slimOptions.compactTools === 'boolean' &&
        ['removeReasoning', 'removeRequestArchives'].every(key => options[key] === undefined || typeof options[key] === 'boolean') &&
        (action.slimOptions.removeImages || action.slimOptions.compactTools || action.slimOptions.removeReasoning || action.slimOptions.removeRequestArchives));
      requireReceipt(object(action.slimCounts) && bytes(action.slimCounts.images) && bytes(action.slimCounts.toolOutputs) &&
        (action.slimOptions.removeImages || action.slimCounts.images === 0) && (action.slimOptions.compactTools || action.slimCounts.toolOutputs === 0) &&
        (action.slimCounts.reasoning === undefined || bytes(action.slimCounts.reasoning)) &&
        (action.slimOptions.removeReasoning || (action.slimCounts.reasoning ?? 0) === 0));
      for (const [key, option] of [['requestRecords', 'removeRequestArchives']])
        requireReceipt((action.slimCounts[key] === undefined || bytes(action.slimCounts[key])) &&
          (action.slimOptions[option] && data.provider === 'claude' || (action.slimCounts[key] ?? 0) === 0));
      requireReceipt(action.files.every(file => file.category === 'sessions'));
    }
    if (action.slimSavingsBytes !== undefined) {
      const savings = action.slimSavingsBytes, counts = action.slimCounts;
      requireReceipt(object(counts));
      requireReceipt(action.kind === 'slim-history' && object(action.slimCounts) &&
        bytes(action.slimCounts.images) && bytes(action.slimCounts.toolOutputs) &&
        object(savings) && bytes(savings.images) && bytes(savings.toolOutputs) &&
        ['reasoning', 'requestRecords'].every(key => (savings[key] === undefined || bytes(savings[key])) &&
          (((counts[key] as number | undefined) ?? 0) > 0 || (savings[key] ?? 0) === 0)) &&
        savings.images + savings.toolOutputs + ['reasoning', 'requestRecords'].reduce((sum, key) => sum + ((savings[key] as number | undefined) ?? 0), 0) === action.estimatedSavingsBytes &&
        (action.slimCounts.images > 0 || savings.images === 0) && (action.slimCounts.toolOutputs > 0 || savings.toolOutputs === 0));
    }
    if (data.provider === 'codex' && action.recoveryState !== 'finalized' && !tempScope) {
      if (action.files.some(file => file.category === 'sessions' || /^(?:sessions|archived_sessions)\//.test(file.relative)))
        requireReceipt(action.kind === 'slim-history' || action.kind === 'codex-delete');
      if (action.kind === 'slim-history') requireReceipt(Array.isArray(action.codexProjection));
    }
    if (action.codexProjection !== undefined) {
      requireReceipt(data.provider === 'codex' && (action.kind === 'slim-history') && Array.isArray(action.codexProjection));
      const names = new Set<string>(), threads = new Set<string>();
      for (const entry of action.codexProjection) {
        requireReceipt(object(entry) && text(entry.name) && /^thread_history_\d+\.sqlite$/.test(entry.name) && !names.has(entry.name));
        names.add(entry.name);
        requireReceipt(bytes(entry.dev) && bytes(entry.ino) && text(entry.threadId) && entry.threadId.length > 0);
        threads.add(entry.threadId);
        for (const key of ['schemaHash', 'beforeHash', 'afterHash']) requireReceipt(text(entry[key]) && /^[0-9a-f]{64}$/.test(entry[key]));
      }
      requireReceipt(threads.size <= 1);
    }
    if (action.kind === 'codex-delete') requireReceipt(data.provider === 'codex' && uuid.test(action.targetId) &&
      Array.isArray(action.sessionIds) && action.sessionIds.includes(action.targetId));
    if (action.status === 'completed') {
      requireReceipt(action.recoveryState !== 'prepared');
      if (action.kind === 'delete-files') requireReceipt(action.afterBytes === 0);
      total += action.beforeBytes - action.afterBytes; requireReceipt(Number.isSafeInteger(total));
    }
    if (data.status === 'dry-run') requireReceipt(action.status === 'planned' && action.recoveryState === 'prepared');
  }
  requireReceipt(data.confirmedReductionBytes === total);
  return data as unknown as Receipt;
}

export async function jsonFiles(dir: string): Promise<{path: string; data: unknown}[]> {
  if (!await existingDir(dir)) return [];
  const entries = [], ids = new Set<string>();
  for (const name of (await readdir(dir)).sort()) {
    if (!/\.json$/i.test(name)) continue;
    if (!uuid.test(name.slice(0, -5)) || !name.endsWith('.json')) throw new Error('Invalid operation record filename');
    const path = join(dir, name);
    let data: unknown;
    try { data = JSON.parse((await readOrdinaryFile(path)).toString('utf8')); }
    catch (e) { throw new Error('Invalid operation record or unsafe read', {cause: e}); }
    const receipt = validateReceipt(data);
    if (`${receipt.operationId}.json` !== name || ids.has(receipt.operationId)) throw new Error('Operation record identity does not match its filename');
    ids.add(receipt.operationId);
    entries.push({path, data});
  }
  return entries;
}
