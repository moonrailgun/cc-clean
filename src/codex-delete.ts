import { execFile, spawn } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timeoutMs = 15_000;

async function rejectManagedConfiguration(): Promise<void> {
  // Managed layers override runtime -c values. Without a complete TOML parser,
  // their presence cannot establish that sqlite_home and log_dir stay pinned.
  for (const path of ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml']) {
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Cannot verify managed Codex configuration; native deletion blocked');
    }
    throw new Error('Unverified managed Codex configuration; native deletion blocked');
  }
  if (process.platform === 'darwin') {
    // Use the same CoreFoundation forced-preference query as Codex 0.167.0.
    // Read only two presence flags; never copy, decode, or print their values.
    const script = 'ObjC.import("CoreFoundation"); var domain = $("com.openai.codex"); '
      + 'JSON.stringify(["config_toml_base64", "requirements_toml_base64"].map(function(key) {'
      + ' return Boolean($.CFPreferencesAppValueIsForced($(key), domain)); }));';
    const flags = await new Promise<string>((resolveFlags, reject) => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
        { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 }, (error, stdout) => {
          if (error) reject(new Error('Cannot verify managed Codex configuration; native deletion blocked'));
          else resolveFlags(stdout.trim());
        });
    });
    if (flags !== '[false,false]') throw new Error('Unverified managed Codex configuration; native deletion blocked');
  }
}

async function verifyNativeWritePaths(root: string): Promise<void> {
  let entries = 0;
  const inspect = async (path: string, recurse: boolean, depth = 0): Promise<void> => {
    if (++entries > 100_000 || depth > 64) throw new Error('Codex native write-path inspection exceeded its limits');
    const info = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Cannot verify Codex native write paths');
    });
    if (!info) return;
    // Native arg0 startup creates these executable aliases, then removes stale
    // alias directories without following the links. Directory/lock links fail.
    if (info.isSymbolicLink() && /^tmp\/arg0-(?:macos|linux)\/codex-arg0[^/]+\/(?:apply_patch|applypatch|codex-linux-sandbox)$/.test(relative(root, path))) return;
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1 && !/^(?:sessions|archived_sessions)\/.*\.jsonl(?:\.zst)?$/.test(relative(root, path)))) {
      throw new Error('Codex native write paths contain links or special files');
    }
    if (recurse && info.isDirectory()) {
      for await (const child of await opendir(path)) await inspect(join(path, child.name), true, depth + 1);
    }
  };
  // Ordinary plugin/skill links outside these native mutation paths are allowed.
  await inspect(join(root, 'skills'), false);
  for (const path of ['skills/.system', 'tmp', '.tmp', 'log', 'logs', 'thread-writer-locks',
    'sessions', 'archived_sessions', 'installation_id', 'session_index.jsonl',
    'session_index.jsonl.lock']) await inspect(join(root, path), true);
  for await (const child of await opendir(root)) {
    if (/\.sqlite(?:-(?:wal|shm|journal))?$/.test(child.name)) await inspect(join(root, child.name), true);
  }
}

function runCodex(args: string[], root?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let timedOut = false, failed = false, missing = false, bytes = 0;
    let output = '';
    const child = spawn('codex', args, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: root ? { ...process.env, CODEX_HOME: root, CODEX_SQLITE_HOME: root } : process.env,
      detached: process.platform !== 'win32', windowsHide: true,
    });
    child.on('error', (error: NodeJS.ErrnoException) => { failed = true; missing = error.code === 'ENOENT'; });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !failed && !timedOut) return resolveOutput(output);
      stop();
      // Native output may contain configuration, paths, prompts, or credentials.
      reject(new Error(timedOut ? 'Codex command timed out; deletion needs review and must not be retried automatically'
        : missing ? 'Codex command not found'
          : 'Codex command did not complete successfully; deletion needs review'));
    });
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may already have exited. */ }
    };
    const consume = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { failed = true; stop(); return; }
      if (stdout) output += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
    // Kill the process group as well: a child retaining stdout must not defeat the bound.
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  });
}

export async function getCodexVersion(): Promise<string> {
  const output = await runCodex(['--version']);
  const match = /^codex-cli (\S+)$/.exec(output.trim());
  if (!match) throw new Error('Cannot determine Codex version');
  return match[1];
}

async function verifyNativeRoot(root: string) {
  // Native startup can connect an executor selected by the inherited environment.
  // Reject that mode instead of changing the caller's remote or managed policy.
  if (Object.keys(process.env).some(key => key === 'CODEX_EXEC_SERVER_URL'
    || key.startsWith('CODEX_EXEC_SERVER_NOISE_'))) {
    throw new Error('Remote Codex execution configuration detected; local session deletion blocked');
  }
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) {
    throw new Error('Codex source must be a resolved absolute directory');
  }
  const before = await lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Codex source is not a regular directory');
  await rejectManagedConfiguration();
  await verifyNativeWritePaths(root);
  const after = await lstat(root);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Codex source directory changed');
  }
  return {dev: after.dev, ino: after.ino};
}

function nativeArgs(root: string): string[] {
  return [
    '--no-daemon',
    '-c', `sqlite_home=${JSON.stringify(root)}`,
    '-c', `log_dir=${JSON.stringify(join(root, 'log'))}`,
    '-c', 'features.local_thread_store_compression=false',
    '-c', 'features.background_paginated_rollout_migration=false',
  ];
}

export function assertCodexDeleteCapabilities(help: string, features: string): void {
  if (!/Usage:.*\bdelete\b.*<SESSION>/.test(help) || !/--force\b/.test(help) || !/--config\b/.test(help))
    throw new Error('Installed Codex lacks required native deletion capabilities (session UUID, force or config overrides)');
  for (const name of ['local_thread_store_compression', 'background_paginated_rollout_migration']) {
    const states = features.split('\n').filter(line => line.trim().split(/\s+/)[0] === name);
    if (states.length !== 1 || !/\sfalse\s*$/.test(states[0]))
      throw new Error(`Installed Codex lacks required deletion capabilities: cannot verify ${name} is disabled`);
  }
}

export async function verifyCodexDeleteCapabilities(root: string): Promise<void> {
  const before = await verifyNativeRoot(root);
  const help = await runCodex([...nativeArgs(root), 'delete', '--help'], root);
  const between = await verifyNativeRoot(root);
  if (before.dev !== between.dev || before.ino !== between.ino) throw new Error('Codex source directory changed');
  const features = await runCodex([...nativeArgs(root), 'features', 'list'], root);
  assertCodexDeleteCapabilities(help, features);
  const after = await verifyNativeRoot(root);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Codex source directory changed');
}

export async function deleteCodexSession(root: string, id: string): Promise<void> {
  if (!uuid.test(id)) throw new Error('Codex deletion requires a full UUID');
  await verifyCodexDeleteCapabilities(root);
  await runCodex([...nativeArgs(root), 'delete', id, '--force'], root);
}
