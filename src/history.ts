import { join, isAbsolute, resolve } from 'node:path';
import type { Receipt } from './clean.ts';
import type { Provider } from './types.ts';
import { atomicWrite, readOrdinaryFile, validateReceipt } from './state.ts';

type CleanupType = 'delete-sessions' | 'delete-files' | 'compress-png' | 'slim-history' | 'deduplicate-history';
export interface CleanupLog {
  schemaVersion: 1; operationId: string; provider: Provider; root: string; source: Receipt['source'];
  startedAt: string; finishedAt: string; status: Exclude<Receipt['status'], 'dry-run'>;
  beforeBytes: number | null; afterBytes: number | null; savedBytes: number | null;
  cleanedRecords: number; cleanupTypes: {type: CleanupType; cleanedRecords: number}[]; needsReview: boolean;
  scope?: 'system-temp';
}
export function pendingReceipt(r: Receipt): boolean {
  return !r.attributionComplete || r.status === 'needs-review' || r.actions.some(a =>
    a.recoveryState !== 'finalized' || a.status === 'planned');
}
// An interrupted run never reaches its final scan, and a later scan would count unrelated writes.
// Verified per-item reductions stand in once attribution is complete.
export function afterBytes(r: Receipt): number | null {
  if (r.rootAfterBytes !== null || !r.attributionComplete || r.rootBeforeBytes === null) return r.rootAfterBytes;
  const derived = r.rootBeforeBytes - r.confirmedReductionBytes;
  return derived >= 0 ? derived : null;
}
function validLog(value: unknown): asserts value is CleanupLog {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const bytes = (v: unknown): v is number | null => v === null || count(v);
  const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  const require = (valid: unknown): void => { if (!valid) throw new Error('Invalid or inconsistent cleanup log'); };
  if (!object(value)) throw new Error('Invalid cleanup log');
  require(value.schemaVersion === 1 && typeof value.operationId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.operationId));
  require(value.provider === 'claude' || value.provider === 'codex');
  require(value.scope === undefined || value.scope === 'system-temp');
  require(typeof value.root === 'string' && !value.root.includes('\0') && isAbsolute(value.root) && resolve(value.root) === value.root);
  require(['clean', 'analyze'].includes(value.source as string) && time(value.startedAt) && time(value.finishedAt));
  require(['completed', 'partial', 'failed', 'interrupted', 'needs-review'].includes(value.status as string));
  if (!bytes(value.beforeBytes) || !bytes(value.afterBytes)) throw new Error('Invalid cleanup byte counts');
  require(value.savedBytes === (value.beforeBytes === null || value.afterBytes === null ? null : value.beforeBytes - value.afterBytes));
  require(typeof value.needsReview === 'boolean' && ((value.savedBytes !== null && value.status !== 'needs-review') || value.needsReview));
  if (!Array.isArray(value.cleanupTypes)) throw new Error('Invalid cleanup types');
  let total = 0;
  const types = new Set<string>();
  for (const entry of value.cleanupTypes) {
    if (!object(entry) || typeof entry.type !== 'string' || !count(entry.cleanedRecords)) throw new Error('Invalid cleanup type count');
    require(['delete-sessions', 'delete-files', 'compress-png', 'slim-history', 'deduplicate-history'].includes(entry.type) && !types.has(entry.type));
    types.add(entry.type); total += entry.cleanedRecords;
    require(Number.isSafeInteger(total));
  }
  require(count(value.cleanedRecords) && value.cleanedRecords === total);
}
export async function readCleanupLog(stateDir: string): Promise<CleanupLog[]> {
  let content: string;
  try { content = (await readOrdinaryFile(join(stateDir, 'cleanup.jsonl'))).toString('utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!content) return [];
  if (!content.endsWith('\n')) throw new Error('Incomplete cleanup log; inspect cleanup.jsonl before continuing');
  const ids = new Set<string>();
  return content.slice(0, -1).split('\n').map(line => {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { throw new Error('Invalid cleanup JSONL; inspect cleanup.jsonl before continuing'); }
    validLog(entry);
    if (ids.has(entry.operationId)) throw new Error('Duplicate cleanup operation ID');
    ids.add(entry.operationId); return entry;
  });
}

// Called under the executor's mutation lock; recovery updates the same line, never credits it twice.
export async function recordCleanup(stateDir: string, r: Receipt): Promise<void> {
  if (r.status === 'dry-run' || !r.executionStartedAt || !r.finishedAt) return;
  validateReceipt(r);
  const counts = new Map<CleanupType, number>();
  for (const action of r.actions) {
    if (action.status !== 'completed' || action.recoveryState !== 'finalized') continue;
    const type = action.sessionIds ? 'delete-sessions' : action.kind === 'compress-png' || action.kind === 'slim-history' || action.kind === 'deduplicate-history' ? action.kind : 'delete-files';
    counts.set(type, (counts.get(type) ?? 0) + (action.kind === 'deduplicate-history' ? 1 : action.sessionIds?.length ?? action.files.length));
  }
  const after = afterBytes(r);
  const entry: CleanupLog = {
    schemaVersion: 1, operationId: r.operationId, provider: r.provider, root: r.root, source: r.source,
    ...(r.systemTemp ? {scope: 'system-temp' as const} : {}),
    startedAt: r.executionStartedAt, finishedAt: r.finishedAt, status: r.status,
    beforeBytes: r.rootBeforeBytes, afterBytes: after,
    savedBytes: r.rootBeforeBytes === null || after === null ? null : r.rootBeforeBytes - after,
    cleanedRecords: [...counts.values()].reduce((sum, n) => sum + n, 0),
    cleanupTypes: [...counts].map(([type, cleanedRecords]) => ({type, cleanedRecords})),
    needsReview: pendingReceipt(r) || r.rootBeforeBytes === null || after === null,
  };
  validLog(entry);
  const entries = await readCleanupLog(stateDir), index = entries.findIndex(log => log.operationId === r.operationId);
  if (index < 0) entries.push(entry);
  else {
    if (entries[index].provider !== entry.provider || entries[index].root !== entry.root) throw new Error('Cleanup operation identity changed');
    if (JSON.stringify(entries[index]) === JSON.stringify(entry)) return;
    entries[index] = entry;
  }
  // Atomic replacement keeps each JSONL line complete even if the process stops during a write.
  await atomicWrite(join(stateDir, 'cleanup.jsonl'), entries.map(log => JSON.stringify(log) + '\n').join(''));
}
