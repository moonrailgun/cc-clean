import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Analysis, FileEntry, Inventory, Session, Usage, ScanProgress } from './types.ts';
import { physicalKey } from './scan.ts';
import { existingDir, privateDir, readOrdinaryFile } from './state.ts';
import { readCodexIndex } from './providers/codex.ts';
import { mergeUsage, PARSER_VERSION, parseSession, unknownUsage, type ParsedSession } from './providers/jsonl.ts';

const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRY_BYTES = 512 * 1024;
const CACHE_ENTRIES = 512;
function fingerprint(file: FileEntry, deep: boolean): string {
  return createHash('sha256').update(JSON.stringify([PARSER_VERSION, deep, file.path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs])).digest('hex');
}
async function cachedParse(file: FileEntry, inventory: Inventory, deep: boolean, cache: string | undefined, signal?: AbortSignal, onBytes?: (processed: number) => void): Promise<ParsedSession> {
  const path = cache && join(cache, fingerprint(file, deep) + '.json');
  if (path) {
    try {
      if (await existingDir(dirname(path))) {
        const data = JSON.parse((await readOrdinaryFile(path, CACHE_ENTRY_BYTES)).toString('utf8'));
        if (data.version === PARSER_VERSION && data.value?.complete === true && Array.isArray(data.value.observedProjects) && Array.isArray(data.value.images) && Array.isArray(data.value.fields) && Array.isArray(data.value.recordTypes) && data.value.usage && data.value.byDate && data.value.byModel) {
          const current = await lstat(file.path);
          if (current.isFile() && current.dev === file.dev && current.ino === file.ino && current.size === file.size && current.mtimeMs === file.mtimeMs && current.ctimeMs === file.ctimeMs && await realpath(file.path) === file.path) {
            if (!signal?.aborted) onBytes?.(file.size);
            return data.value as ParsedSession;
          }
        }
      }
    } catch {}
  }
  const value = await parseSession(file, inventory.provider, deep, signal, onBytes);
  if (path && value.complete && !signal?.aborted) {
    const content = JSON.stringify({ version: PARSER_VERSION, value });
    if (Buffer.byteLength(content) <= CACHE_ENTRY_BYTES) {
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await privateDir(dirname(path));
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        if (!await existingDir(dirname(path))) throw new Error('Cache directory changed');
        await rename(temporary, path);
      } catch { try { if (await existingDir(dirname(path))) await unlink(temporary); } catch {} }
    }
  }
  return value;
}
async function trimCache(cache: string, signal?: AbortSignal): Promise<void> {
  try {
    if (!await existingDir(cache)) return;
    const entries = [];
    for (const name of await readdir(cache)) {
      if (signal?.aborted) return;
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(cache, name), info = await lstat(path);
      if (info.isFile()) entries.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    let bytes = 0;
    for (let i = 0; i < entries.length; i++) {
      if (signal?.aborted) return;
      bytes += entries[i].size;
      if (i >= CACHE_ENTRIES || bytes > CACHE_BYTES) {
        if (!await existingDir(cache)) return;
        await unlink(entries[i].path).catch(() => {});
      }
    }
  } catch {}
}
function addUsageGroups(target: Record<string, Usage>, source: Record<string, Usage>, verified: boolean) {
  for (const [name, value] of Object.entries(source)) {
    const group = target[name] ??= { ...unknownUsage(), verified: true };
    mergeUsage(group, { ...value, verified });
  }
}

export async function analyze(inventory: Inventory, options: { deep?: boolean; signal?: AbortSignal; stateDir?: string; onProgress?: (progress: ScanProgress) => void } = {}): Promise<Analysis> {
  const deep = options.deep ?? false;
  const cache = options.stateDir && join(options.stateDir, 'providers', inventory.provider, 'cache');
  const result: Analysis = { schemaVersion: 1, provider: inventory.provider, root: inventory.root, totalBytes: inventory.totalBytes, scanComplete: inventory.complete, scannedAt: new Date().toISOString(), fileCount: inventory.files.length, categories: [], directories: [], projects: [], sessions: [], sharedBytes: 0, unattributedBytes: 0, usage: { ...unknownUsage(), parsedFiles: 0, totalFiles: 0, byDate: Object.create(null), byModel: Object.create(null) }, opportunities: { pngBytes: 0, pngCount: 0, embeddedImageBytes: 0, duplicateImageBytes: 0, fields: [], recordTypes: [] }, warnings: [...inventory.errors] };
  const files = new Map<string, FileEntry>();
  const categories = new Map<string, {name: string; bytes: number; files: number}>();
  const directories = new Map<string, {name: string; bytes: number; files: number}>();
  for (const file of inventory.files) {
    const key = physicalKey(file);
    if (files.has(key)) continue;
    files.set(key, file);
    for (const [groups, name] of [[categories, file.nlink > 1 ? 'shared-hardlinks' : file.category], [directories, file.relative.includes('/') ? file.relative.split('/')[0] : '(root)']] as const) {
      const group = groups.get(name) ?? { name, bytes: 0, files: 0 };
      group.bytes += file.size; group.files++; groups.set(name, group);
    }
    if (file.category === 'images' && /\.png$/i.test(file.path)) { result.opportunities.pngBytes += file.size; result.opportunities.pngCount++; }
  }
  const sessionFiles = [...files.values()].filter(file => file.category === 'sessions');
  result.usage.totalFiles = sessionFiles.length;
  let completed = 0, processedBytes = 0;
  const totalBytes = sessionFiles.reduce((sum, file) => sum + file.size, 0);
  const progress = (phase: ScanProgress['phase'], currentFile?: string) => options.onProgress?.({
    phase, completed, total: sessionFiles.length, currentFile,
    ...(deep ? { processedBytes, totalBytes } : {}),
  });
  progress('sessions');
  const parsed: {file: FileEntry; value: ParsedSession}[] = [];
  for (let i = 0; i < sessionFiles.length && !options.signal?.aborted; i += 2) {
    parsed.push(...await Promise.all(sessionFiles.slice(i, i + 2).map(async file => {
      let bytes = 0;
      const value = await cachedParse(file, inventory, deep, cache, options.signal, processed => {
        const next = Math.min(file.size, processed);
        processedBytes += next - bytes; bytes = next;
        progress('sessions', file.relative);
      });
      if (!options.signal?.aborted) { completed++; progress('sessions', file.relative); }
      return { file, value };
    })));
  }
  if (!options.signal?.aborted) progress('finalizing');
  const byId = new Map<string, Session>();
  const byPath = new Map<string, Session>();
  const fields = new Map<string, {path: string; bytes: number; count: number}>();
  const types = new Map<string, {type: string; bytes: number; count: number}>();
  const images = new Map<string, {bytes: number; count: number; firstBytes: number}>();
  const duplicateIds = new Set<string>();
  for (const { file, value } of parsed) {
    const existing = byId.get(value.id);
    if (existing) {
      duplicateIds.add(value.id);
      existing.files.push(file); existing.complete = false; existing.usage.verified = false;
      existing.warnings.push('Multiple distinct files claim the same session ID; usage excluded from totals');
      byPath.set(file.path, existing);
      result.scanComplete = false;
      continue;
    }
    const session: Session = { id: value.id, provider: inventory.provider, project: value.project, parentId: value.parentId, files: [file], bytes: 0, updatedAt: value.updatedAt ?? new Date(file.mtimeMs).toISOString(), createdAt: value.createdAt, model: value.model, version: value.version, archived: file.relative.startsWith('archived_sessions/'), complete: value.complete, observedProjects: value.observedProjects, usage: value.usage, warnings: [...value.warnings] };
    byId.set(session.id, session); byPath.set(file.path, session);
    result.scanComplete &&= session.complete;
    result.warnings.push(...value.warnings.map(warning => `${file.relative}: ${warning}`));
    for (const item of value.fields) { const prior = fields.get(item.path) ?? { ...item, bytes: 0, count: 0 }; prior.bytes += item.bytes; prior.count += item.count; fields.set(item.path, prior); }
    for (const item of value.recordTypes) { const prior = types.get(item.type) ?? { ...item, bytes: 0, count: 0 }; prior.bytes += item.bytes; prior.count += item.count; types.set(item.type, prior); }
    for (const item of value.images) { const prior = images.get(item.digest) ?? { bytes: 0, count: 0, firstBytes: item.bytes / item.count }; prior.bytes += item.bytes; prior.count += item.count; images.set(item.digest, prior); }
  }
  if (inventory.provider === 'claude') {
    for (const file of files.values()) {
      if (file.category === 'sessions') continue;
      const match = file.relative.match(/^projects\/[^/]+\/([^/]+)\/tool-results\//);
      const owner = match && byId.get(match[1]);
      if (owner && file.nlink === 1) { owner.files.push(file); byPath.set(file.path, owner); }
    }
  } else if (inventory.exists && !options.signal?.aborted) {
    if (!options.signal?.aborted) progress('index');
    const index = await readCodexIndex(inventory, options.signal);
    if (!options.signal?.aborted) progress('finalizing');
    result.warnings.push(...index.warnings);
    for (const row of index.threads) {
      const session = byId.get(row.id) ?? (row.path && byPath.get(row.path));
      if (session) {
        if (session.id !== row.id) { session.complete = false; session.warnings.push('Index/session ID mismatch'); }
        if (session.parentId && row.parentId && session.parentId !== row.parentId) { session.complete = false; session.warnings.push('Conflicting parent relationships'); }
        session.parentId ??= row.parentId;
        if (row.project && !session.observedProjects?.includes(row.project)) session.observedProjects?.push(row.project);
        session.project = row.project ?? session.project;
        session.createdAt ??= row.createdAt;
        if (row.updatedAt && row.updatedAt > session.updatedAt) session.updatedAt = row.updatedAt;
        session.archived ||= row.archived;
      } else {
        byId.set(row.id, { id: row.id, provider: 'codex', project: row.project ?? null, parentId: row.parentId, files: [], bytes: 0, updatedAt: row.updatedAt ?? '', createdAt: row.createdAt, archived: row.archived, complete: false, indexOnly: true, observedProjects: row.project ? [row.project] : [], usage: unknownUsage(), warnings: ['Index-only session: rollout file missing or outside scanned root'] });
      }
    }
    for (const row of index.threads) if (row.attachedParentId) {
      for (const id of [row.id, row.attachedParentId]) {
        const session = byId.get(id);
        if (session) { session.complete = false; session.warnings.push('Attached relationship cleanup is unsupported'); }
      }
    }
    if (!index.complete) for (const session of byId.values()) {
      session.complete = false;
      session.warnings.push('Index coverage unavailable; relationship metadata is incomplete');
    }
    // File usage remains useful when the optional index is absent; the warning makes the missing coverage explicit.
    result.scanComplete &&= index.complete;
  }
  const visited = new Set<string>();
  for (const session of byId.values()) {
    const branch = new Map<string, Session>();
    let current: Session | undefined = session;
    while (current && !visited.has(current.id) && !branch.has(current.id)) {
      branch.set(current.id, current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (current && branch.has(current.id)) {
      result.warnings.push(`Session relationship cycle detected at ${current.id}`);
      for (const member of branch.values()) { member.complete = false; member.warnings.push('Session relationship cycle; deletion scope cannot be validated'); }
    }
    for (const id of branch.keys()) visited.add(id);
  }
  result.sessions = [...byId.values()];
  const owned = new Map<string, Session>();
  for (const session of result.sessions) for (const file of session.files) {
    const key = physicalKey(file);
    if (file.nlink > 1 || owned.has(key)) continue;
    session.bytes += file.size; owned.set(key, session);
  }
  const projects = new Map<string, Analysis['projects'][number]>();
  for (const session of result.sessions) {
    result.scanComplete &&= session.complete;
    if (!session.project) continue;
    const project = projects.get(session.project) ?? { path: session.project, bytes: 0, sessions: 0, updatedAt: '', usage: { ...unknownUsage(), verified: deep && inventory.complete } };
    project.usage.verified &&= session.complete && !session.indexOnly;
    project.bytes += session.bytes; project.sessions++; if (session.updatedAt > project.updatedAt) project.updatedAt = session.updatedAt; projects.set(project.path, project);
  }
  for (const [key, file] of files) {
    if (file.nlink > 1 || file.category === 'databases') result.sharedBytes += file.size;
    else if (!owned.get(key)?.project) result.unattributedBytes += file.size;
  }
  result.usage.verified = deep && parsed.length === sessionFiles.length && inventory.complete;
  for (const { file, value } of parsed) {
    if (!deep) continue;
    result.usage.parsedFiles++;
    const projectPath = byId.get(value.id)?.project;
    const project = projectPath && projects.get(projectPath);
    if (duplicateIds.has(value.id) || value.inherited) {
      result.usage.verified = false;
      if (project) project.usage.verified = false;
      continue;
    }
    mergeUsage(result.usage, value.usage);
    if (project) mergeUsage(project.usage, value.usage);
    addUsageGroups(result.usage.byDate, value.byDate, value.usage.verified);
    addUsageGroups(result.usage.byModel, value.byModel, value.usage.verified);
  }
  if (!deep) result.warnings.push('Metadata-only analysis: usage and embedded-image/field coverage are unknown; use a deep view to parse records');
  if (options.signal?.aborted) { result.scanComplete = false; result.usage.verified = false; result.warnings.push('Analysis interrupted'); }
  result.usage.verified &&= result.usage.inputTokens !== null && !result.sessions.some(session => session.indexOnly);
  for (const item of images.values()) { result.opportunities.embeddedImageBytes += item.bytes; result.opportunities.duplicateImageBytes += item.bytes - item.firstBytes; }
  result.categories = [...categories.values()].sort((a, b) => b.bytes - a.bytes);
  result.directories = [...directories.values()].sort((a, b) => b.bytes - a.bytes);
  result.projects = [...projects.values()].sort((a, b) => b.bytes - a.bytes);
  for (const project of result.projects) project.usage.verified &&= project.usage.inputTokens !== null;
  result.sessions.sort((a, b) => b.bytes - a.bytes);
  result.opportunities.fields = [...fields.values()].sort((a, b) => b.bytes - a.bytes);
  result.opportunities.recordTypes = [...types.values()].sort((a, b) => b.bytes - a.bytes);
  if (cache && !options.signal?.aborted) await trimCache(cache, options.signal);
  return result;
}
