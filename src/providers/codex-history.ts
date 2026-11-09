import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import type { FileEntry, Inventory } from '../types.ts';
import { assertCodexMeta, slimCodexItem, type SlimOptions } from '../slim.ts';
import { existingDir } from '../state.ts';
import { verifyCodexSqliteLocation } from './codex.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? {integer: v.toString()} : v)).digest('hex');
const historyPath = /^(?:sessions|archived_sessions)\/.*\.jsonl(?:\.zst)?$/;
const databaseName = /^thread_history_\d+\.sqlite$/;

export async function readCodexHeader(file: FileEntry, signal?: AbortSignal): Promise<Record<string, any>> {
  if (await realpath(file.path) !== file.path) throw new Error('Codex history path changed');
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const unchanged = async () => {
    for (const stat of [await handle.stat(), await lstat(file.path)]) {
      if (!stat.isFile() || stat.isSymbolicLink() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(k => stat[k as keyof typeof stat] !== file[k as keyof FileEntry]))
        throw new Error('Codex history changed during header inspection');
    }
  };
  try {
    await unchanged();
    const source = handle.createReadStream({autoClose: false, highWaterMark: 16 * 1024, signal});
    const decoder = file.path.endsWith('.zst') ? createZstdDecompress({chunkSize: 16 * 1024}) : undefined;
    const stream = decoder ? source.pipe(decoder) : source;
    if (decoder) source.on('error', error => decoder.destroy(error));
    let buffer = Buffer.alloc(0), found = false;
    try {
      for await (const chunk of stream.iterator({destroyOnReturn: false})) {
        signal?.throwIfAborted();
        const data = Buffer.from(chunk), newline = data.indexOf(10);
        buffer = Buffer.concat([buffer, newline < 0 ? data : data.subarray(0, newline)]);
        if (buffer.length > 1024 * 1024) throw new Error('Codex history header exceeds 1 MiB');
        if (newline >= 0) { found = true; break; }
      }
      if (!found && !buffer.length) throw new Error('Codex history header is empty');
      await unchanged();
      const row = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer));
      if (row.type !== 'session_meta' || typeof row.payload?.id !== 'string' || !row.payload.id)
        throw new Error('Codex history header has no recognized identity');
      return row;
    } finally { source.destroy(); decoder?.destroy(); }
  } finally { await handle.close(); }
}

// Read all headers to find inbound byte references, but retain only affected targets.
export async function verifyCodexRewriteLayout(inv: Inventory, signal?: AbortSignal): Promise<Map<string, string>> {
  if (!inv.complete) throw new Error('Codex rewrite requires a complete scan');
  if (inv.links.some(l => /^(?:(?:sessions|archived_sessions)(?:\/|$)|config\.toml$|thread_history_.*\.sqlite)/.test(relative(inv.root, l.path))))
    throw new Error('Linked Codex history or configuration prevents complete reference inspection');
  await verifyCodexSqliteLocation(inv);
  const blocked = new Map<string, string>(), owners = new Map<string, string[]>(), aliases = new Map<string, string[]>(), references = new Set<string>();
  for (const file of inv.files.filter(f => historyPath.test(f.relative))) {
    signal?.throwIfAborted();
    let row;
    try { row = await readCodexHeader(file, signal); }
    catch (error) { throw new Error(`${file.relative}: cannot inspect inbound history references: ${(error as Error).message}`); }
    const meta = row.payload;
    owners.set(meta.id, [...(owners.get(meta.id) ?? []), file.path]);
    for (const id of [meta.id, meta.session_id]) {
      if (id != null && (typeof id !== 'string' || !id)) throw new Error(`${file.relative}: unrecognized history identity`);
      if (id) aliases.set(id, [...(aliases.get(id) ?? []), file.path]);
    }
    for (const id of [meta.history_base?.thread_id, meta.forked_from_id, meta.forked_from]) {
      if (id != null && typeof id !== 'string') throw new Error(`${file.relative}: unrecognized shared history reference`);
      if (id) references.add(id);
    }
    if (meta.history_base != null && typeof meta.history_base?.thread_id !== 'string')
      throw new Error(`${file.relative}: shared history reference has no source identity`);
    try { assertCodexMeta(row); }
    catch (error) { blocked.set(file.path, (error as Error).message); }
    if (file.nlink !== 1) blocked.set(file.path, 'History has hard links; coordinated copies are required');
    if (file.path.endsWith('.zst')) blocked.set(file.path, 'Compressed history is inspected for references but is not rewritten');
  }
  for (const id of references) for (const path of aliases.get(id) ?? [])
    blocked.set(path, 'History is referenced by another rollout; dependent updates are required');
  for (const paths of owners.values()) {
    if (paths.length > 1)
      for (const path of paths) blocked.set(path, 'History is referenced by another rollout or has multiple copies; dependent updates are required');
  }
  return blocked;
}

export function byteOffsetMap(input: Buffer, output: Buffer): Map<bigint, bigint> {
  const boundaries = (data: Buffer) => {
    const offsets = [0];
    for (let pos = data.indexOf(10); pos >= 0; pos = data.indexOf(10, pos + 1)) offsets.push(pos + 1);
    if (offsets.at(-1) !== data.length) offsets.push(data.length);
    return offsets;
  };
  const before = boundaries(input), after = boundaries(output);
  if (before.length !== after.length) throw new Error('History rewrite changed record boundaries');
  return new Map(before.map((pos, i) => [BigInt(pos), BigInt(after[i])]));
}

type Row = Record<string, SQLOutputValue>;
export type Projection = Record<string, Row[]>;
const keys: Record<string, string[]> = {
  thread_history_projection_state: ['thread_id'], thread_turns: ['thread_id', 'turn_id'],
  thread_items: ['thread_id', 'turn_id', 'item_id'], thread_realtime_items: ['thread_id', 'item_id'],
};
const offsets: Record<string, string[]> = {
  thread_history_projection_state: ['next_rollout_byte_offset'], thread_turns: ['rollout_byte_offset', 'rollout_end_byte_offset'],
};
function schema(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}
export function projectionSnapshot(db: DatabaseSync, id: string): Projection {
  const snapshot: Projection = {}, structures = schema(db);
  for (const entry of structures) {
    if (entry.type === 'trigger' && keys[String(entry.tbl_name)] && /\bUPDATE\b/i.test(String(entry.sql)))
      throw new Error('History index has an unrecognized update trigger');
    if (entry.type !== 'table') continue;
    const table = String(entry.name);
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(r => String(r.name));
    if (columns.some(c => /offset/i.test(c) && !(offsets[table] ?? []).includes(c)))
      throw new Error('History index contains unsupported offset columns');
    if (!keys[table]) {
      if (columns.includes('thread_id')) throw new Error('History index has an unrecognized thread projection table');
      continue;
    }
    const required = [...keys[table], ...(table === 'thread_history_projection_state' ? ['next_rollout_byte_offset', 'next_rollout_ordinal'] : []),
      ...(['thread_items', 'thread_realtime_items'].includes(table) ? ['item_json'] : [])];
    if (required.some(c => !columns.includes(c))) throw new Error('History index projection schema is incomplete');
    const statement = db.prepare(`SELECT * FROM ${table} WHERE thread_id=? ORDER BY ${keys[table].join(',')} LIMIT 100001`);
    statement.setReadBigInts(true);
    snapshot[table] = statement.all(id);
    if (snapshot[table].length > 100000) throw new Error('History index target exceeds 100000 rows');
  }
  if (Object.keys(keys).slice(0, 3).some(table => !snapshot[table])) throw new Error('History index lacks required projection tables');
  return snapshot;
}
export function rewriteProjection(snapshot: Projection, mapping: Map<bigint, bigint>, options: SlimOptions): Projection {
  const result = structuredClone(snapshot);
  for (const [table, rows] of Object.entries(result)) for (const row of rows) {
    for (const key of offsets[table] ?? []) {
      if (row[key] == null) continue;
      if (typeof row[key] !== 'bigint') throw new Error('History index offset is not an integer');
      const offset = mapping.get(row[key]);
      if (offset === undefined) throw new Error('History index offset is not a JSONL byte boundary');
      row[key] = offset;
    }
    if (row.item_json !== undefined) {
      if (typeof row.item_json !== 'string') throw new Error('History cache item is not JSON text');
      row.item_json = slimCodexItem(row.item_json, options);
    }
  }
  return result;
}
export const projectionHash = digest;
export interface ProjectionReceipt {
  name: string; dev: number; ino: number; threadId: string; schemaHash: string; beforeHash: string; afterHash: string;
}
export function projectionState(actual: string, expected: Pick<ProjectionReceipt, 'beforeHash' | 'afterHash'>): 'before' | 'after' {
  if (actual === expected.afterHash) return 'after';
  if (actual === expected.beforeHash) return 'before';
  throw new Error('History index changed since preview; original backup retained for review');
}
async function databaseNames(root: string) { return (await readdir(root)).filter(n => databaseName.test(n)).sort(); }
async function openDatabase(root: string, name: string, write: boolean) {
  if (!databaseName.test(name) || !await existingDir(root) || await realpath(root) !== root) throw new Error('History database path changed');
  const path = join(root, name), before = await lstat(path);
  const verify = async () => {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino)
      throw new Error('History database identity changed or is linked');
    let wal = false, shm = false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const stat = await lstat(path + suffix).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('History database sidecar is linked');
      if (suffix === '-wal') wal = Boolean(stat);
      if (suffix === '-shm') shm = Boolean(stat);
    }
    if (wal && !shm) throw new Error('History database WAL has no shared-memory sidecar; cannot inspect without creating files');
  };
  await verify();
  const db = new DatabaseSync(path, {readOnly: !write, allowExtension: false, timeout: 1000});
  try {
    db.exec(write ? 'PRAGMA synchronous=FULL; BEGIN IMMEDIATE' : 'PRAGMA query_only=ON; BEGIN');
    await verify();
    return {db, verify, identity: {dev: before.dev, ino: before.ino}};
  } catch (error) { db.close(); throw error; }
}
export async function previewProjection(root: string, input: Buffer, output: Buffer, options: SlimOptions): Promise<ProjectionReceipt[]> {
  const threadId = JSON.parse(input.subarray(0, input.indexOf(10) < 0 ? input.length : input.indexOf(10)).toString()).payload.id;
  const receipts: ProjectionReceipt[] = [], mapping = byteOffsetMap(input, output);
  for (const name of await databaseNames(root)) {
    const {db, verify, identity} = await openDatabase(root, name, false);
    try {
      const before = projectionSnapshot(db, threadId), after = rewriteProjection(before, mapping, options);
      receipts.push({name, ...identity, threadId, schemaHash: digest(schema(db)), beforeHash: digest(before), afterHash: digest(after)});
      await verify();
    } finally { db.close(); }
  }
  return receipts;
}
export function applyProjection(db: DatabaseSync, before: Projection, after: Projection) {
  for (const [table, rows] of Object.entries(after)) for (let i = 0; i < rows.length; i++) {
    const row = rows[i], old = before[table][i];
    const changed = Object.keys(row).filter(k => row[k] !== old[k]);
    if (!changed.length) continue;
    // Only known byte positions and cache JSON can be written; unknown fields stay intact.
    if (changed.some(k => !(offsets[table] ?? []).includes(k) && k !== 'item_json')) throw new Error('Unexpected history index mutation');
    const statement = db.prepare(`UPDATE ${table} SET ${changed.map(k => `${k}=?`).join(',')} WHERE ${keys[table].map(k => `${k}=?`).join(' AND ')}`);
    const result = statement.run(...[...changed.map(k => row[k]), ...keys[table].map(k => old[k])] as SQLInputValue[]);
    if (Number(result.changes) !== 1) throw new Error('History index row identity changed');
  }
}

// Hold SQLite write locks across the JSONL rename. Recovery finishes a rolled-back
// transaction from the original JSONL backup; conflicting indexes retain that backup.
export async function prepareProjection(root: string, receipts: ProjectionReceipt[], input: Buffer | null, output: Buffer | null,
  options: SlimOptions, recovery = false) {
  if (JSON.stringify(await databaseNames(root)) !== JSON.stringify(receipts.map(r => r.name))) throw new Error('History database set changed since preview');
  if (input && receipts.some(r => r.threadId !== JSON.parse(input.subarray(0, input.indexOf(10) < 0 ? input.length : input.indexOf(10)).toString()).payload.id))
    throw new Error('History index receipt belongs to another rollout');
  const opened: Awaited<ReturnType<typeof openDatabase>>[] = [];
  const close = () => { for (const {db} of opened.splice(0)) db.close(); };
  try {
    for (const expected of receipts) {
      const connection = await openDatabase(root, expected.name, true); opened.push(connection);
      const {db, identity} = connection;
      if (identity.dev !== expected.dev || identity.ino !== expected.ino || digest(schema(db)) !== expected.schemaHash)
        throw new Error('History database identity or schema changed');
      const before = projectionSnapshot(db, expected.threadId), actual = digest(before);
      if (recovery && projectionState(actual, expected) === 'after') continue;
      if (actual !== expected.beforeHash) throw new Error('History index changed since preview');
      if (!input || !output) throw new Error('Original history backup is required to recover its index');
      const after = rewriteProjection(before, byteOffsetMap(input, output), options);
      if (digest(after) !== expected.afterHash) throw new Error('History index transformation differs from preview');
      applyProjection(db, before, after);
      if (digest(projectionSnapshot(db, expected.threadId)) !== expected.afterHash) throw new Error('History index update could not be verified');
    }
    return {
      async commit() {
        try {
          if (JSON.stringify(await databaseNames(root)) !== JSON.stringify(receipts.map(r => r.name))) throw new Error('History database set changed during rewrite');
          for (const {db, verify} of opened) { await verify(); db.exec('COMMIT'); }
        } finally { close(); }
      },
      rollback: close,
    };
  } catch (error) { close(); throw error; }
}
export async function verifyProjectionBefore(root: string, receipts: ProjectionReceipt[]) {
  if (JSON.stringify(await databaseNames(root)) !== JSON.stringify(receipts.map(r => r.name))) throw new Error('History database set changed');
  for (const expected of receipts) {
    const {db, verify, identity} = await openDatabase(root, expected.name, false);
    try {
      if (identity.dev !== expected.dev || identity.ino !== expected.ino || digest(schema(db)) !== expected.schemaHash ||
          digest(projectionSnapshot(db, expected.threadId)) !== expected.beforeHash) throw new Error('History index changed before interrupted rewrite');
      await verify();
    } finally { db.close(); }
  }
}
