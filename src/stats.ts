import { join } from 'node:path';
import type { Provider } from './types.ts';
import { jsonFiles, validateReceipt } from './state.ts';
import type { Receipt } from './clean.ts';
import { readCleanupLog, pendingReceipt, type CleanupLog } from './history.ts';

function add(a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new Error('Storage totals exceed the safe integer range');
  return total;
}
export interface ProviderStats {
  savedBytes: number; cleanedRecords: number; pending: number;
  operations: CleanupLog[]; pendingOperations: Receipt[];
}
export async function readStats(stateDir: string) {
  const history = await readCleanupLog(stateDir);
  const providers = {} as Record<Provider, ProviderStats>;
  const ids = new Set<string>();
  for (const provider of ['claude', 'codex'] as const) {
    const pendingOperations: Receipt[] = [];
    for (const {data} of await jsonFiles(join(stateDir, 'providers', provider, 'operations'))) {
      const r = validateReceipt(data, provider);
      if (ids.has(r.operationId)) throw new Error('Duplicate operation ID; statistics stopped');
      ids.add(r.operationId);
      const log = history.find(entry => entry.operationId === r.operationId);
      if (log && (log.provider !== provider || log.root !== r.root)) throw new Error('Cleanup operation identity changed');
      if (r.status !== 'dry-run' && pendingReceipt(r)) pendingOperations.push(r);
    }
    const operations = history.filter(r => r.provider === provider).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const pendingIds = new Set([...pendingOperations.map(r => r.operationId), ...operations.filter(r => r.needsReview).map(r => r.operationId)]);
    const verified = operations.filter(r => !pendingIds.has(r.operationId));
    providers[provider] = {
      savedBytes: verified.reduce((sum, r) => add(sum, r.savedBytes!), 0),
      cleanedRecords: verified.reduce((sum, r) => add(sum, r.cleanedRecords), 0),
      pending: pendingIds.size, operations, pendingOperations,
    };
  }
  return {schemaVersion: 2 as const, providers,
    savedBytes: add(providers.claude.savedBytes, providers.codex.savedBytes),
    cleanedRecords: add(providers.claude.cleanedRecords, providers.codex.cleanedRecords)};
}
