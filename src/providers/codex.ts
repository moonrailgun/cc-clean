import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Inventory } from '../types.ts';

export interface IndexThread { id: string; path?: string; project?: string; parentId?: string; attachedParentId?: string; createdAt?: string; updatedAt?: string; archived: boolean; }
function time(value: unknown): string | undefined {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  const ms = typeof numeric === 'number' ? numeric * (numeric < 1e12 ? 1000 : 1) : typeof numeric === 'string' ? Date.parse(numeric) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export async function readCodexIndex(inventory: Inventory, signal?: AbortSignal): Promise<{ threads: IndexThread[]; warnings: string[]; complete: boolean; fingerprint: string | null }> {
  const result = { threads: [] as IndexThread[], warnings: [] as string[], complete: true, fingerprint: null as string | null };
  if (signal?.aborted) return { ...result, complete: false, warnings: ['Codex index read interrupted'] };
  let sqliteHome = process.env.CODEX_SQLITE_HOME;
  const config = inventory.files.find(file => file.relative === 'config.toml');
  if (config) {
    let handle;
    try {
      if (config.size > 64 * 1024) throw new Error('config exceeds bounded inspection limit');
      handle = await open(config.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (info.dev !== config.dev || info.ino !== config.ino || info.size !== config.size) throw new Error('config changed');
      for (const line of (await handle.readFile('utf8')).split('\n')) {
        if (/^\s*\[/.test(line)) break;
        if (/^\s*sqlite_home\s*=/.test(line)) {
          const match = line.match(/^\s*sqlite_home\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
          if (!match) throw new Error('unrecognized sqlite_home config');
          sqliteHome = match[1];
        }
      }
    } catch {
      result.complete = false;
      result.warnings.push('Codex SQLite location could not be confirmed from config');
    } finally { await handle?.close().catch(() => {}); }
  }
  if (sqliteHome && resolve(inventory.root, sqliteHome) !== inventory.root) {
    result.complete = false;
    result.warnings.push('External Codex SQLite location is unsupported; index coverage is incomplete');
  }
  const candidates = inventory.files.filter(file => /^state_\d+\.sqlite$/.test(file.relative)).sort((a, b) => Number(b.relative.match(/\d+/)?.[0]) - Number(a.relative.match(/\d+/)?.[0]));
  const file = candidates[0];
  if (!file) {
    if (inventory.files.some(file => file.category === 'sessions')) { result.complete = false; result.warnings.push('Codex index unavailable; metadata comes from files only'); }
    return result;
  }
  let database;
  try {
    const info = await lstat(file.path);
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== file.dev || info.ino !== file.ino || await realpath(file.path) !== file.path) throw new Error('index path changed');
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = await lstat(file.path + suffix).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink())) throw new Error('unsafe index sidecar');
    }
    // A read-only WAL connection may otherwise create a missing shared-memory file.
    if (await lstat(file.path + '-wal').catch(() => null) && !await lstat(file.path + '-shm').catch(() => null)) throw new Error('WAL shared-memory sidecar missing; skipped to avoid creating source files');
    database = new DatabaseSync(file.path, { readOnly: true, allowExtension: false, timeout: 1000 });
    database.exec('PRAGMA query_only=ON; BEGIN');
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map(row => String(row.name)));
    if (!columns.has('id') || !columns.has('rollout_path')) throw new Error('unknown threads schema');
    const selected = ['id', 'rollout_path', 'cwd', 'created_at', 'updated_at', 'archived', 'parent_thread_id', 'attached_thread_parent_id'].filter(name => columns.has(name));
    const byId = new Map<string, IndexThread>();
    for (const row of database.prepare(`SELECT ${selected.join(',')} FROM threads LIMIT 100001`).iterate()) {
      if (byId.size % 256 === 0) await setImmediate();
      if (signal?.aborted) throw new Error('index read interrupted');
      if (byId.size >= 100000) throw new Error('index row limit reached; metadata is partial');
      const id = String(row.id);
      if (byId.has(id)) throw new Error('duplicate thread identity in index');
      const path = typeof row.rollout_path === 'string' ? resolve(inventory.root, row.rollout_path) : undefined;
      const project = typeof row.cwd === 'string' && isAbsolute(row.cwd) ? row.cwd : undefined;
      byId.set(id, { id, path, project, parentId: typeof row.parent_thread_id === 'string' ? row.parent_thread_id : undefined, attachedParentId: typeof row.attached_thread_parent_id === 'string' ? row.attached_thread_parent_id : undefined, createdAt: time(row.created_at), updatedAt: time(row.updated_at), archived: Boolean(row.archived) });
    }
    const edgeColumns = new Set(database.prepare('PRAGMA table_info(thread_spawn_edges)').all().map(row => String(row.name)));
    const graph: string[][] = [];
    if (edgeColumns.has('parent_thread_id') && edgeColumns.has('child_thread_id')) {
      let edges = 0;
      for (const row of database.prepare(`SELECT parent_thread_id,child_thread_id${edgeColumns.has('status') ? ',status' : ''} FROM thread_spawn_edges LIMIT 100001`).iterate()) {
        if (edges % 256 === 0) await setImmediate();
        if (signal?.aborted) throw new Error('index read interrupted');
        if (++edges > 100000) throw new Error('index edge limit reached; relationship metadata is partial');
        const childId = String(row.child_thread_id);
        graph.push([String(row.parent_thread_id), childId, String(row.status ?? '')]);
        const child = byId.get(childId) ?? { id: childId, archived: false };
        if (typeof row.parent_thread_id === 'string') {
          if (child.parentId && child.parentId !== row.parent_thread_id) { result.complete = false; result.warnings.push(`Conflicting parent relationships for ${child.id}`); }
          child.parentId ??= row.parent_thread_id;
          byId.set(childId, child);
        }
      }
    } else { result.complete = false; result.warnings.push('Codex spawn relationship schema unavailable; deletion scope cannot be validated'); }
    if ([...byId.values()].some(thread => thread.attachedParentId)) result.warnings.push('Attached Codex relationships require unsupported cleanup; affected sessions cannot be deleted');
    result.threads = [...byId.values()];
    database.exec('COMMIT');
    if (result.complete) result.fingerprint = createHash('sha256').update(JSON.stringify({
      threads: result.threads.map(thread => [thread.id, thread.path ?? null, thread.archived, thread.parentId ?? null, thread.attachedParentId ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      edges: graph.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })).digest('hex');
  } catch (error) {
    result.complete = false;
    result.warnings.push(`Codex index unavailable: ${error instanceof Error ? error.message : 'read failed'}`);
  } finally { database?.close(); }
  return result;
}
