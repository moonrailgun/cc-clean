import type { Config } from './config.ts';
import type { Provider, ScanProgress } from './types.ts';
import { physicalKey, scanRoot } from './scan.ts';
import { analyze } from './analyze.ts';
import { createPlan, estimateSavings, executePlan, type Plan } from './clean.ts';
import { getCodexVersion } from './codex-delete.ts';
import { scanSystemTemp, systemTempBases } from './system-temp.ts';
import { within } from './state.ts';
import { dirname } from 'node:path';
import { discoverSessionTemps } from './session-temp.ts';

type CleanupOptions = { sessions?: string[]; files?: string[]; deleteImages?: boolean; manual?: boolean; includeFileCleanup?: boolean; removeImages?: boolean; compactTools?: boolean; removeReasoning?: boolean };
export const includesSystemTemp = (options: CleanupOptions) => !options.manual && !options.files?.length && !options.sessions?.length &&
  (!!options.includeFileCleanup || !options.removeImages && !options.compactTools && !options.removeReasoning);

export async function report(config: Config, provider: Provider, deep: boolean, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  return analyze(await scanRoot(config.roots[provider], provider, signal, onProgress), { deep, signal, onProgress, stateDir: config.stateDir });
}
export async function plan(config: Config, provider: Provider, options: CleanupOptions = {}, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  const inventory = await scanRoot(config.roots[provider], provider, signal, onProgress);
  const analysis = await analyze(inventory, { deep: true, signal, onProgress, stateDir: config.stateDir });
  if (options.sessions?.length && !analysis.scanComplete) throw new Error('Session analysis is incomplete; deletion scope cannot be verified. Inspect the analysis report');
  signal?.throwIfAborted();
  let version = 'unknown';
  if (provider === 'codex' && inventory.exists) { try { version = await getCodexVersion(); } catch { /* Unknown versions cannot use version-specific rules. */ } }
  const result = await createPlan(inventory, {
    version, source: options.manual ? 'analyze' : 'clean', sessions: analysis.sessions,
    sessionIds: options.sessions, filePaths: options.files, deleteImages: options.deleteImages,
    includeFileCleanup: options.includeFileCleanup,
    slim: { removeImages: !!options.removeImages, compactTools: !!options.compactTools, removeReasoning: !!options.removeReasoning },
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
export async function cleanupPlans(config: Config, provider: Provider, options: CleanupOptions = {}, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void): Promise<Plan[]> {
  const plans = [await plan(config, provider, options, signal, onProgress)];
  if (!includesSystemTemp(options)) return plans;
  const uid = process.getuid?.();
  if (uid === undefined) { plans[0].warnings.push('System temporary-file ownership checks are unavailable on this platform'); return plans; }
  const bases = await systemTempBases(provider);
  const excludedRoots = [...Object.values(config.roots), config.stateDir];
  const discovered = await discoverSessionTemps(config.roots, excludedRoots, signal, onProgress);
  plans[0].warnings.push(...discovered.warnings);
  for (const root of bases) {
    signal?.throwIfAborted();
    const scope = {uid, excludedRoots: [...excludedRoots, ...bases.filter(base => within(root, base)), ...discovered.found.map(f => f.evidence.path)]};
    const inventory = await scanSystemTemp(root, provider, scope, signal, onProgress);
    if (!inventory.files.length && !inventory.errors.length) continue;
    plans.push(await createPlan(inventory, {systemTemp: scope}));
  }
  for (const {provider: owner, evidence} of discovered.found) {
    if (owner !== provider) continue;
    signal?.throwIfAborted();
    const root = evidence.kind === 'directory' ? evidence.path : dirname(evidence.path);
    const scope = {uid, excludedRoots, session: evidence};
    const inventory = await scanSystemTemp(root, provider, scope, signal, onProgress);
    const item = await createPlan(inventory, {systemTemp: scope});
    if (item.actions.length || item.warnings.length) plans.push(item);
  }
  return plans;
}
// Consume creation evidence before history slimming can change its fingerprint.
export const cleanupExecutionOrder = (plans: Plan[]) => [...plans.filter(p => p.systemTemp?.session), ...plans.filter(p => !p.systemTemp?.session)];
export async function execute(config: Config, plans: Plan[], dryRun: boolean, signal?: AbortSignal, onProgress?: (message: string) => void) {
  const receipts = [];
  for (const item of cleanupExecutionOrder(plans)) {
    if (signal?.aborted) break;
    receipts.push(await executePlan(item, { stateDir: config.stateDir, dryRun, signal, onProgress }));
  }
  return { schemaVersion: 1 as const, receipts };
}
