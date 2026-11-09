import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Inventory, Provider, ScanProgress } from './types.ts';

export interface SystemTempScope { uid: number; excludedRoots: string[] }
export const systemTempLabels = {
  'task-output': 'Remove temporary task outputs',
  'cwd-record': 'Remove temporary cwd records',
  'hook-output': 'Remove temporary hook outputs',
  installer: 'Remove leftover installers',
} as const;
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const hookFile = new RegExp(`^hook_outputs/${uuid}/${uuid}\\.txt$`, 'i');
const hookDir = new RegExp(`^hook_outputs/${uuid}$`, 'i');
const childOf = (root: string, path: string) => { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith('../') && !isAbsolute(r); };
export const tempExcluded = (path: string, scope: SystemTempScope) => scope.excludedRoots.some(root => path === root || childOf(root, path));
export function scopedTempKind(root: string, path: string, provider: Provider, scope: SystemTempScope): keyof typeof systemTempLabels | null {
  return systemTempKind(relative(root, path), provider, scope.uid);
}

/** Exact known layouts only; a provider-like directory name is not a deletion rule. */
export function systemTempKind(path: string, provider: Provider, uid: number): keyof typeof systemTempLabels | null {
  if (!Number.isSafeInteger(uid) || uid < 0 || path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f\x7f]/.test(path)) return null;
  if (provider === 'claude') {
    if (/^claude-[0-9a-f]{4}-cwd$/.test(path) || new RegExp(`^claude-${uid}/cwd-[0-9a-f]+$`).test(path)) return 'cwd-record';
    if (new RegExp(`^(?:claude-${uid}|claude)/[^/]+/tasks/[a-zA-Z0-9_-]+\\.output$`).test(path)) return 'task-output';
  } else {
    if (hookFile.test(path)) return 'hook-output';
    if (/^codex-app-installer-[a-zA-Z0-9_-]+\/Codex\.dmg$/.test(path)) return 'installer';
  }
  return null;
}
function tempDirectory(path: string, provider: Provider, uid: number) {
  const parts = path.split('/');
  if (provider === 'claude') return [ `claude-${uid}`, 'claude' ].includes(parts[0]) &&
    (parts.length <= 2 || parts.length === 3 && parts[2] === 'tasks');
  return path === 'hook_outputs' || hookDir.test(path) || /^codex-app-installer-[a-zA-Z0-9_-]+$/.test(path);
}
function safeDirectory(s: Stats, uid: number, base = false) {
  return s.isDirectory() && !s.isSymbolicLink() && (base ? (s.uid === uid || s.uid === 0) && (!(s.mode & 0o022) || !!(s.mode & 0o1000)) : s.uid === uid && !(s.mode & 0o022));
}
export async function systemTempBases(provider: Provider, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const bases = ['/tmp', '/var/tmp', tmpdir(), env.TMPDIR, env.TMP, env.TEMP, ...(provider === 'claude' ? [env.CLAUDE_CODE_TMPDIR] : [])];
  const result = new Set<string>();
  for (const base of bases) {
    if (!base) continue;
    if (!isAbsolute(base)) throw new Error('Temporary directory must be an absolute path');
    try { const root = await realpath(base); if (root === '/') throw new Error('Filesystem root cannot be a temporary directory'); result.add(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return [...result].sort();
}
export async function verifySystemTempParents(root: string, path: string, provider: Provider, scope: SystemTempScope) {
  if (scope.uid !== process.getuid?.() || !childOf(root, path) || tempExcluded(path, scope) || !scopedTempKind(root, path, provider, scope)) throw new Error('Temporary file is outside the allowed scope');
  if (await realpath(root) !== root || !safeDirectory(await lstat(root), scope.uid, true)) throw new Error('Temporary base directory is unsafe');
  let cursor = root;
  for (const part of relative(root, dirname(path)).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    if (!safeDirectory(await lstat(cursor), scope.uid) || await realpath(cursor) !== cursor) throw new Error('Temporary parent directory changed or has unsafe ownership or permissions');
  }
}

/** Metadata-only scan, descending only into the bounded layouts above. */
export async function scanSystemTemp(root: string, provider: Provider, scope: SystemTempScope, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void): Promise<Inventory> {
  const inv: Inventory = { provider, root, exists: false, complete: true, files: [], links: [], totalBytes: 0, allocatedBytes: 0, errors: [] };
  if (tempExcluded(root, scope)) return inv;
  const fail = (path: string, error: unknown) => { inv.complete = false; inv.errors.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); };
  try {
    if (scope.uid !== process.getuid?.() || root === '/' || await realpath(root) !== root || !safeDirectory(await lstat(root), scope.uid, true)) throw new Error('Unsafe temporary base or owner');
    inv.exists = true;
    const directories = [root];
    while (directories.length) {
      signal?.throwIfAborted();
      const directory = directories.pop()!;
      if (!safeDirectory(await lstat(directory), scope.uid, directory === root) || await realpath(directory) !== directory) throw new Error('Temporary directory changed');
      const dir = await opendir(directory);
      for await (const entry of dir) {
        signal?.throwIfAborted();
        const path = join(directory, entry.name), rel = relative(root, path);
        if (tempExcluded(path, scope)) continue;
        const kind = scopedTempKind(root, path, provider, scope), descend = tempDirectory(rel, provider, scope.uid);
        if (!kind && !descend && !entry.isSymbolicLink()) continue;
        try {
          const s = await lstat(path);
          if (s.isSymbolicLink()) { inv.links.push({ path, target: await realpath(path).catch(async () => resolve(dirname(path), await readlink(path))) }); continue; }
          if (descend && s.isDirectory()) {
            if (safeDirectory(s, scope.uid)) directories.push(path);
            else inv.errors.push(`${rel}: unsafe temporary directory ownership or permissions; retained`);
          } else if (kind && s.isFile()) {
            if (s.uid !== scope.uid || s.nlink !== 1 || s.mode & 0o022) { inv.errors.push(`${rel}: temporary file is shared or has unsafe ownership or permissions; retained`); continue; }
            inv.files.push({path, relative: rel, size: s.size, allocatedBytes: s.blocks * 512, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, dev: s.dev, ino: s.ino, nlink: s.nlink, mode: s.mode, uid: s.uid, category: kind});
            inv.totalBytes += s.size; inv.allocatedBytes += s.blocks * 512;
            onProgress?.({phase: 'discovering', completed: inv.files.length, total: null, currentFile: path});
          }
        } catch (error) { fail(path, error); }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(root, error); else if (inv.exists) fail(root, error); }
  signal?.throwIfAborted();
  inv.files.sort((a, b) => a.path.localeCompare(b.path));
  inv.links.sort((a, b) => a.path.localeCompare(b.path));
  return inv;
}
