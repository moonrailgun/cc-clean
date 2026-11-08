import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readOrdinaryFile } from './state.ts';
import type { Provider } from './types.ts';

export interface Config { stateDir: string; roots: Record<Provider,string> }
export async function loadConfig(home = homedir(), env = process.env): Promise<Config> {
  const stateDir=join(home,'.config','cc-clean');
  let overrides: Record<string, unknown> = {};
  try {
    const data=JSON.parse((await readOrdinaryFile(join(stateDir,'config.json'),65536)).toString('utf8'));
    if (!data || typeof data!=='object' || Array.isArray(data) || Object.keys(data).some(k=>k!=='roots')) throw new Error('Configuration only supports the roots key');
    overrides=data.roots ?? {};
    if (!overrides || typeof overrides!=='object' || Array.isArray(overrides) || Object.keys(overrides).some(k=>!['claude','codex'].includes(k))) throw new Error('roots only supports claude and codex');
  } catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  const roots={} as Record<Provider,string>;
  for (const provider of ['claude','codex'] as const) {
    const path=overrides[provider] ?? env[provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME'] ?? join(home,`.${provider}`);
    if (typeof path!=='string'||!isAbsolute(path)) throw new Error(`${provider} root must be an absolute path`);
    try {roots[provider]=await realpath(path);} catch(e) {if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; roots[provider]=resolve(path);}
  }
  return {stateDir,roots};
}
