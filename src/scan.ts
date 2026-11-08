import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { FileEntry, Inventory, Provider, ScanProgress } from './types.ts';

function category(path: string, provider: Provider): string {
  const top = path.split('/')[0];
  if (top === 'plugins' || top === 'packages' || top === 'skills') return 'plugins';
  if (/\.(?:sqlite|db)(?:-wal|-shm)?$/.test(path)) return 'databases';
  if ((provider === 'claude' && top === 'projects' || provider === 'codex' && ['sessions', 'archived_sessions'].includes(top)) && path.endsWith('.jsonl')) return 'sessions';
  if (/(?:^|\/)memory\//.test(path) || ['memories', 'config', 'rules'].includes(top)) return 'config';
  if (/\.(?:png|jpe?g|webp|gif|avif)$/i.test(path)) return 'images';
  if (top === '.tmp' || /^\.\.codex-global-state\.json\.tmp-/.test(top)) return 'temporary';
  if (top.includes('cache') || top === 'debug' || top === 'logs') return 'cache';
  if (top === 'projects' || top === 'file-history' || top === 'shell_snapshots') return 'attachments';
  if (/\.(?:json|toml|yaml|yml|md)$/.test(path)) return 'config';
  return 'other';
}

export function physicalKey(file: FileEntry): string { return `${file.dev}:${file.ino}`; }

export function directoryEntries(inventory: Inventory, prefix = '') {
  const entries = new Map<string, {name: string; path: string; directory: boolean; bytes: number; files: number}>();
  const seen = new Set<string>();
  for (const file of inventory.files) {
    const key = physicalKey(file), bytes = seen.has(key) ? 0 : file.size;
    seen.add(key);
    if (!file.relative.startsWith(prefix)) continue;
    const rest = file.relative.slice(prefix.length), name = rest.split('/')[0];
    const item = entries.get(name) ?? {name, path: prefix + name, directory: rest.includes('/'), bytes: 0, files: 0};
    item.bytes += bytes; item.files++; entries.set(name, item);
  }
  return [...entries.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

export async function scanRoot(root: string, provider: Provider, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void): Promise<Inventory> {
  const result: Inventory = { provider, root: resolve(root), exists: false, complete: true, files: [], links: [], totalBytes: 0, allocatedBytes: 0, errors: [] };
  onProgress?.({ phase: 'discovering', completed: 0, total: null });
  const fail = (path: string, error: unknown) => {
    result.complete = false;
    result.errors.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? 'scan failed'}`);
  };
  if (signal?.aborted) { result.complete = false; result.errors.push('Scan interrupted'); return result; }
  try {
    result.root = await realpath(result.root);
    if (!(await lstat(result.root)).isDirectory()) { fail(result.root, { code: 'ENOTDIR' }); return result; }
    result.exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(result.root, error);
    return result;
  }
  const seen = new Set<string>();
  const directories = [result.root];
  while (directories.length && !signal?.aborted) {
    const batch = directories.splice(0, 8);
    await Promise.all(batch.map(async directory => {
      try {
        // Recheck queued directories so a link replacement is never deliberately traversed.
        const before = await lstat(directory);
        if (!before.isDirectory() || await realpath(directory) !== directory) { fail(directory, { code: 'DIRECTORY_CHANGED' }); return; }
        const dir = await opendir(directory);
        for await (const entry of dir) {
          if (signal?.aborted) break;
          const path = join(directory, entry.name);
          try {
            const info = await lstat(path);
            if (info.isSymbolicLink()) { result.links.push({ path, target: await realpath(path).catch(async () => resolve(dirname(path), await readlink(path))) }); continue; }
            if (info.isDirectory()) { directories.push(path); continue; }
            if (!info.isFile()) continue;
            const rel = relative(result.root, path).split('\\').join('/');
            const file: FileEntry = { path, relative: rel, size: info.size, allocatedBytes: info.blocks * 512, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, nlink: info.nlink, mode: info.mode, category: category(rel, provider) };
            result.files.push(file);
            onProgress?.({ phase: 'discovering', completed: result.files.length, total: null, currentFile: rel });
            const key = physicalKey(file);
            if (seen.has(key)) continue;
            seen.add(key);
            result.totalBytes += file.size;
            result.allocatedBytes += file.allocatedBytes;
          } catch (error) { fail(path, error); }
        }
      } catch (error) { fail(directory, error); }
    }));
  }
  if (signal?.aborted) { result.complete = false; result.errors.push('Scan interrupted'); }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  result.links.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
