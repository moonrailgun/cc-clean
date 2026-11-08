import type { Config } from './config.ts';
import type { Provider, ScanProgress } from './types.ts';
import { physicalKey, scanRoot } from './scan.ts';
import { analyze } from './analyze.ts';
import { createPlan, estimateSavings, executePlan, type Plan } from './clean.ts';
import { getCodexVersion } from './codex-delete.ts';

export async function report(config: Config, provider: Provider, deep: boolean, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  return analyze(await scanRoot(config.roots[provider], provider, signal, onProgress), { deep, signal, onProgress, stateDir: config.stateDir });
}
export async function plan(config: Config, provider: Provider, options: { sessions?: string[]; files?: string[]; deleteImages?: boolean; manual?: boolean; removeImages?: boolean; compactTools?: boolean } = {}, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  const inventory = await scanRoot(config.roots[provider], provider, signal, onProgress);
  const analysis = await analyze(inventory, { deep: true, signal, onProgress, stateDir: config.stateDir });
  if (options.sessions?.length && !analysis.scanComplete) throw new Error('Session analysis is incomplete; deletion scope cannot be verified. Inspect the analysis report');
  signal?.throwIfAborted();
  let version = 'unknown';
  if (provider === 'codex' && inventory.exists) { try { version = await getCodexVersion(); } catch { /* Unknown versions cannot use version-specific rules. */ } }
  const result = await createPlan(inventory, {
    version, source: options.manual ? 'analyze' : 'clean', sessions: analysis.sessions,
    sessionIds: options.sessions, filePaths: options.files, deleteImages: options.deleteImages,
    slim: { removeImages: !!options.removeImages, compactTools: !!options.compactTools },
    otherRoots: [config.roots[provider === 'claude' ? 'codex' : 'claude']],
  });
  result.warnings = [...new Set([...result.warnings, ...analysis.warnings])];
  if (!analysis.scanComplete) result.warnings.push('Deep scan is incomplete; only independently validated files are eligible');
  if (provider === 'claude' && !options.sessions?.length && !options.removeImages && !options.compactTools) result.warnings.push('Claude has no verified automatic temporary-file or standalone PNG rules; use Slim history for opt-in field removal');
  if (provider === 'claude' && options.sessions?.length) {
    const retained = new Map(inventory.files.filter(f => f.category === 'config' || f.relative === 'history.jsonl' || f.relative.startsWith('file-history/')).map(f => [physicalKey(f), f.size]));
    result.warnings.push(`Retaining project memory, configuration, file-history and history.jsonl (provider total: ${[...retained.values()].reduce((sum, bytes) => sum + bytes, 0)} B). Other sessions and resources with unknown ownership are also retained. This does not erase all history.`);
  }
  if (provider === 'codex' && version !== '0.167.0') result.warnings.push('Supported Codex version not confirmed; temporary-file rules disabled');
  await estimateSavings(result, signal, onProgress);
  signal?.throwIfAborted();
  return result;
}
export async function execute(config: Config, plans: Plan[], dryRun: boolean, signal?: AbortSignal, onProgress?: (message: string) => void) {
  const receipts = [];
  for (const item of plans) {
    if (signal?.aborted) break;
    receipts.push(await executePlan(item, { stateDir: config.stateDir, dryRun, signal, onProgress }));
  }
  return { schemaVersion: 1 as const, receipts };
}
