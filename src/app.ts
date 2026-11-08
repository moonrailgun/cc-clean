import type { Config } from './config.ts';
import type { Provider, ScanProgress } from './types.ts';
import { physicalKey, scanRoot } from './scan.ts';
import { analyze } from './analyze.ts';

export async function report(config: Config, provider: Provider, deep: boolean, signal?: AbortSignal, onProgress?: (progress: ScanProgress) => void) {
  return analyze(await scanRoot(config.roots[provider], provider, signal, onProgress), { deep, signal, onProgress, stateDir: config.stateDir });
}
