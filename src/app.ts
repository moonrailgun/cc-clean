import type { Config } from './config.ts';
import type { Inventory, Provider, ScanProgress } from './types.ts';
import { physicalKey, scanRoot } from './scan.ts';
import { analyze } from './analyze.ts';
import { createPlan, estimateSavings, executePlan, type Plan } from './clean.ts';
import { getCodexVersion } from './codex-delete.ts';
import { scanSystemTemp, systemTempBases } from './system-temp.ts';
import { within } from './state.ts';
import { dirname } from 'node:path';
import { discoverSessionTemps } from './session-temp.ts';

export const CLAUDE_FILE_CLEANUP_NOTICE = 'Claude Code standalone-image deletion is not supported. Quick clean also checks known system temporary files; use Quick clean or Slim history to remove inline images or compact shell output.';

type CleanupOptions = { sessions?: string[]; files?: string[]; bulkSelection?: boolean; deleteImages?: boolean; manual?: boolean; includeFileCleanup?: boolean; tempOnly?: boolean; removeImages?: boolean; compactTools?: boolean; removeReasoning?: boolean; removeRequestArchives?: boolean; compactHooks?: boolean; compactToolDefinitions?: boolean; compactSkillListings?: boolean; removeOldSnapshots?: boolean };
export const includesSystemTemp = (options: CleanupOptions) => !options.manual && !options.files?.length && !options.sessions?.length &&
  (!!options.includeFileCleanup || !options.removeImages && !options.compactTools && !options.removeReasoning && !options.removeRequestArchives && !options.compactHooks && !options.compactToolDefinitions && !options.compactSkillListings && !options.removeOldSnapshots);

export async function report(config: Config, provider: Provider, deep: boolean, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  return analyze(await scanRoot(config.roots[provider], provider, signal, onProgress), { deep, signal, onProgress, stateDir: config.stateDir });
}
export function sessionStorageBytes(inventory: Inventory): number | null {
  if (!inventory.complete) return null;
  const files = new Map(inventory.files.filter(f => f.category === 'sessions').map(f => [physicalKey(f), f.size]));
  return [...files.values()].reduce((sum, bytes) => sum + bytes, 0);
}
export async function plan(config: Config, provider: Provider, options: CleanupOptions = {}, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  const inventory = await scanRoot(config.roots[provider], provider, signal, onProgress);
  if (options.tempOnly) return createPlan(inventory, {tempOnly: true, otherRoots: [config.roots[provider === 'claude' ? 'codex' : 'claude']]});
  const analysis = await analyze(inventory, { deep: true, signal, onProgress, stateDir: config.stateDir });
  if (options.sessions?.length && !analysis.scanComplete) throw new Error('Session analysis is incomplete; deletion scope cannot be verified. Inspect the analysis report');
  signal?.throwIfAborted();
  let version = 'unknown';
  if (provider === 'codex' && inventory.exists) { try { version = await getCodexVersion(); } catch { /* Native session deletion requires a verified CLI version. */ } }
  const result = await createPlan(inventory, {
    version, source: options.manual ? 'analyze' : 'clean', sessions: analysis.sessions,
    sessionIds: options.sessions, filePaths: options.files, bulkSelection: options.bulkSelection, deleteImages: options.deleteImages,
    slim: { removeImages: !!options.removeImages, compactTools: !!options.compactTools, removeReasoning: !!options.removeReasoning, removeRequestArchives: !!options.removeRequestArchives, compactHooks: !!options.compactHooks, compactToolDefinitions: !!options.compactToolDefinitions, compactSkillListings: !!options.compactSkillListings, removeOldSnapshots: !!options.removeOldSnapshots }, includeFileCleanup: options.includeFileCleanup,
    otherRoots: [config.roots[provider === 'claude' ? 'codex' : 'claude']],
  });
  result.totalSessionBytes = sessionStorageBytes(inventory);
  result.warnings = [...new Set([...result.warnings, ...analysis.warnings])];
  if (!analysis.scanComplete) result.warnings.push('Deep scan is incomplete; only independently validated files are eligible');
  if (provider === 'claude' && !options.sessions?.length && !options.removeImages && !options.compactTools && !options.removeReasoning && !options.removeRequestArchives && !options.compactHooks && !options.compactToolDefinitions && !options.compactSkillListings && !options.removeOldSnapshots) result.warnings.push(CLAUDE_FILE_CLEANUP_NOTICE);
  if (provider === 'claude' && options.sessions?.length) {
    const retained = new Map(inventory.files.filter(f => f.category === 'config' || f.relative === 'history.jsonl' || f.relative.startsWith('file-history/')).map(f => [physicalKey(f), f.size]));
    result.warnings.push(`Retaining project memory, configuration, file-history and history.jsonl (provider total: ${[...retained.values()].reduce((sum, bytes) => sum + bytes, 0)} B). Other sessions and resources with unknown ownership are also retained. This does not erase all history.`);
  }
  await estimateSavings(result, signal, onProgress);
  signal?.throwIfAborted();
  return result;
}
export async function cleanupPlans(config: Config, provider: Provider, options: CleanupOptions = {}, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void): Promise<Plan[]> {
  if (options.tempOnly && (options.manual || options.files?.length || options.sessions?.length || options.deleteImages || options.removeImages || options.compactTools || options.removeReasoning || options.removeRequestArchives || options.compactHooks || options.compactToolDefinitions || options.compactSkillListings || options.removeOldSnapshots))
    throw new Error('Temporary-file cleanup cannot be combined with explicit targets or history slimming');
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
