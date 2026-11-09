import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileEntry, Provider, ScanProgress } from './types.ts';
import { parseSession } from './providers/jsonl.ts';

type Row = Record<string, any>;
type Roots = Record<Provider, string>;
interface Creation { path: string; kind: 'file' | 'directory'; callId: string; startedAt: number; completedAt: number }
export interface SessionTempEvidence extends Creation {
  roots: Roots; fingerprint: string; source: string; sessionId: string;
  dev: number; ino: number; birthtimeMs: number;
}
const absolute = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v) && resolve(v) === v && !/[\\\x00-\x1f\x7f]/.test(v);
const inside = (root: string, path: string) => path.startsWith(root + '/');
const variables = ['TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CODE_TMPDIR'];
const standardTemp = (path: string) => /^\/(?:private\/)?(?:tmp|var\/tmp|var\/folders\/[^/]+\/[^/]+\/T)\//.test(path);
const protectedPart = /^(?:\..*|src|sources?|scratchpad|scratchpads|daemon|locks?|sockets?|config|node_modules|vendor|venv)$/i;
const sourceMarkers = ['.git', '.hg', '.svn', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'CMakeLists.txt', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
export const temporarySubdirectory = (path: string) => !!path && path.split('/').every(p => !!p && !protectedPart.test(p));
const temporaryLocation = (path: string) => temporarySubdirectory(path.slice(1));
export async function verifyTemporaryLocation(path: string) {
  if (!temporaryLocation(path)) throw new Error('Protected temporary path; retained');
  for (let dir = path; ; dir = dirname(dir)) {
    for (const marker of sourceMarkers) {
      try { await lstat(join(dir, marker)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Error('Temporary path belongs to a source project or repository; retained');
    }
    if (dir === dirname(dir)) break;
  }
}
export function temporaryOutput(path: string): boolean {
  return !!path && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(p => !!p && !protectedPart.test(p)) &&
    /\.(?:md|txt|log|csv|tsv|out|output)$/i.test(path) &&
    !/^(?:agents|claude|readme|license|notice|cmakelists|requirements|scratchpads?|daemon|locks?|sockets?|config)(?:\.|$)/i.test(basename(path));
}
export function tempPathAliases(path: string): string[] {
  const short = path.replace(/^\/private\/(tmp|var)(?=\/)/, '/$1');
  const aliases = new Set([path, short]);
  if (/^\/(?:tmp|var)\//.test(short)) aliases.add('/private' + short);
  const tail = short.replace(/^\/(?:tmp|var\/tmp|var\/folders\/[^/]+\/[^/]+\/T)\//, '');
  if (tail !== short) for (const variable of variables) { aliases.add(`$${variable}/${tail}`); aliases.add(`\${${variable}}/${tail}`); }
  return [...aliases];
}
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(b => b?.text ?? '').join('\n') : '';
}
function successOutput(value: unknown): string | null {
  if (typeof value === 'string') {
    try { return successOutput(JSON.parse(value)); } catch { /* Legacy shell output has a status envelope. */ }
    const match = /(?:^|\n)Process exited with code 0\n(?:Final output|Output):\n([\s\S]*)$/.exec(value);
    return match?.[1] ?? null;
  }
  const row = value as Row | null;
  return row && row.exit_code === 0 && typeof row.output === 'string' && !row.session_id ? row.output : null;
}
function words(value: string): string[] | null {
  const parts: string[] = [];
  const token = /\s*(?:"([^"`\n]*)"|'([^'\n]*)'|([^\s'"`;|&<>]+))/y;
  let at = 0;
  while (at < value.trimEnd().length) {
    token.lastIndex = at; const match = token.exec(value); if (!match) return null;
    parts.push(match[1] ?? match[2] ?? match[3]); at = token.lastIndex;
  }
  return parts;
}
// shortcut: only a bounded shell prefix is proof; other syntax needs shell parsing and data-flow analysis.
function mkdirDirectories(command: string): string[] {
  const paths: string[] = [], bindings = new Map<string, string>();
  const token = /[ \t]*((?:'[^'\n]*'|"[^"`\\\n]*"|[A-Za-z0-9_./$~{}:=+-])+)/y;
  const expand = (word: string) => (word.match(/'[^']*'|"[^"]*"|[^'"]+/g) ?? []).map(part =>
    part.startsWith("'") ? part.slice(1, -1) : part.replaceAll('"', '').replace(/\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\}/g, (ref, a, b) => bindings.get(a ?? b) ?? ref)
  ).join('');
  const temp = (path: string) => absolute(path) && standardTemp(path) && temporaryLocation(path) && !/[$`*?{}]/.test(path);
  let at = 0;
  while (at < command.length) {
    const raw: string[] = [];
    let separator: string;
    while (true) {
      const end = /^[ \t]*(\&\&|;|\n|$)/.exec(command.slice(at));
      if (end) { at += end[0].length; separator = end[1]; break; }
      token.lastIndex = at;
      const match = token.exec(command); if (!match) return paths;
      raw.push(match[1]); at = token.lastIndex;
    }
    if (!raw.length) return paths;
    const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(raw[0]);
    if (assignment && raw.length === 1) {
      const value = expand(assignment[2]);
      if (!temp(value) || /^(?:PATH|CDPATH|IFS|ENV|BASH_ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|LD_.*|DYLD_.*)$/.test(assignment[1])) return paths;
      bindings.set(assignment[1], value);
    } else {
      const args = raw.slice(1).map(expand);
      if (raw[0] === 'cd') {
        if (args.length !== 1 || !absolute(args[0]) || /[$`*?{}]/.test(args[0])) return paths;
      } else if (raw[0] === 'rm' || raw[0] === '/bin/rm') {
        if (!['-rf', '-fr'].includes(args.shift() ?? '') || !args.length || !args.every(temp)) return paths;
      } else if (raw[0] === 'mkdir' || raw[0] === '/bin/mkdir') {
        if (args[0] === '-p') args.shift();
        if (args[0] === '--') args.shift();
        if (!args.length || !args.every(temp)) return paths;
        paths.push(...args);
      } else return paths;
    }
    if (!separator) break;
  }
  return [...new Set(paths)];
}
/** Recognize bounded creation forms; never interpret or execute historical code. */
function createdDirectory(command: string, output: string): string | null {
  if (typeof output !== 'string' || command.length > 1024 * 1024) return null;
  const path = output.trim(); if (!absolute(path)) return null;
  let cmd = command.trim();
  const assigned = /^([A-Za-z_]\w*)=\$\((mktemp[^\n]*)\)\s*(?:;|\n)\s*(?:echo "\$\1"|printf '%s\\n' "\$\1")$/.exec(cmd);
  if (assigned) cmd = assigned[2];
  const args = words(cmd);
  if (args?.[0] === 'mktemp' || args?.[0] === '/usr/bin/mktemp') {
    const opts = args.slice(1); let dir = false, template: string | undefined, tagged = false;
    for (let i = 0; i < opts.length; i++) {
      if (opts[i] === '-d' || opts[i] === '--directory') dir = true;
      else if (opts[i] === '-t' && !template) { template = opts[++i]; tagged = true; }
      else if (!opts[i].startsWith('-') && !template) template = opts[i];
      else return null;
    }
    if (!dir) return null;
    if (!template) return /^tmp\.[a-zA-Z0-9]{6,}$/.test(basename(path)) ? path : null;
    if (/[`\n\r]|\$\(/.test(template)) return null;
    const variable = /^(?:\$(TMPDIR|TMP|TEMP|CLAUDE_CODE_TMPDIR)|\$\{(TMPDIR|TMP|TEMP|CLAUDE_CODE_TMPDIR)\})\//.exec(template);
    if (template.includes('$') && !variable) return null;
    const leaf = basename(template), suffix = /X{3,}$/.exec(leaf);
    const prefix = suffix ? leaf.slice(0, -suffix[0].length) : tagged ? leaf + '.' : null;
    if (prefix === null || !basename(path).startsWith(prefix)) return null;
    const random = basename(path).slice(prefix.length);
    if (!/^[a-zA-Z0-9_-]{3,}$/.test(random) || suffix && random.length !== suffix[0].length) return null;
    if (isAbsolute(template) && !tempPathAliases(dirname(template)).includes(dirname(path))) return null;
    if (!isAbsolute(template) && !variable && !tagged) return null;
    return path;
  }
  const py = /^python(?:3)?\s+-\s+<<\s*(['"]?)([A-Za-z_]\w*)\1\n([\s\S]*)\n\2$/.exec(cmd);
  if (!py) return null;
  // shortcut: only standalone allocation/print scripts are proof; arbitrary Python needs a real parser and data-flow analysis.
  const lines = py[3].split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const imported = new Set<string>();
  while (lines[0]?.startsWith('import ')) {
    const modules = lines.shift()!.slice(7).split(',').map(s => s.trim());
    if (modules.some(m => !['tempfile', 'pathlib', 'os'].includes(m))) return null;
    modules.forEach(m => imported.add(m));
  }
  const creation = /^([A-Za-z_]\w*)\s*=\s*(pathlib\.Path\()?tempfile\.mkdtemp\((?:prefix\s*=\s*(['"])([^'"/\\\n]*)\3)?\)(\))?\s*$/.exec(lines.shift() ?? '');
  if (!creation || !imported.has('tempfile') || ['print', 'tempfile', 'pathlib', 'os'].includes(creation[1]) ||
      !!creation[2] !== !!creation[5] || creation[2] && !imported.has('pathlib')) return null;
  if (imported.has('os') && lines[0] === `os.chmod(${creation[1]}, 0o700)`) lines.shift();
  if (lines.length !== 1 || lines[0] !== `print(${creation[1]})`) return null;
  const prefix = creation[4] ?? 'tmp';
  return basename(path).startsWith(prefix) && /^[a-z0-9_]{8}$/.test(basename(path).slice(prefix.length)) ? path : null;
}
export function sessionTempCollector(provider: Provider) {
  const creations: Creation[] = [], calls = new Map<string, {name: string; input: Row; time: number}>();
  const seen = new Set<string>(), finished = new Set<string>(), ambiguous = new Set<string>();
  const unique = (id: unknown, phase: 'call' | 'result') => {
    if (typeof id !== 'string' || !id) return false;
    const ids = phase === 'call' ? seen : finished;
    if (ids.has(id)) { ambiguous.add(id); calls.delete(id); for (let i = creations.length - 1; i >= 0; i--) if (creations[i].callId === id) creations.splice(i, 1); }
    ids.add(id);
    if (seen.size + finished.size > 100_000) throw new Error('Temporary creation history exceeds inspection limit');
    return !ambiguous.has(id);
  };
  const add = (path: string, kind: Creation['kind'], id: string, start: number, end: number) => {
    if (absolute(path) && id && Number.isFinite(start) && Number.isFinite(end) && start <= end)
      creations.push({path, kind, callId: id, startedAt: start, completedAt: end});
  };
  const shell = (cmd: unknown, output: string, id: string, start: number, end: number) => {
    if (typeof cmd !== 'string' || cmd.length > 1024 * 1024) return;
    const path = createdDirectory(cmd, output); if (path) add(path, 'directory', id, start, end);
    for (const directory of mkdirDirectories(cmd)) add(directory, 'directory', id, start, end);
  };
  return {creations, record(row: Row) {
    const time = Date.parse(row.timestamp), p = row.payload ?? {};
    if (provider === 'codex') {
      if (row.type === 'event_msg' && p.type === 'item_completed') {
        const item = p.item ?? {}, start = p.started_at_ms ?? time, end = p.completed_at_ms ?? time;
        if (!unique(item.id, 'result')) return;
        if (item.type === 'CommandExecution' && item.status === 'completed' && item.exit_code === 0 && Array.isArray(item.command) && item.command.length === 3 && ['-lc', '-c'].includes(item.command[1]))
          shell(item.command[2], item.aggregated_output ?? '', item.id, start, end);
        if (item.type === 'FileChange' && item.status === 'completed' && item.changes && typeof item.changes === 'object')
          for (const [path, change] of Object.entries(item.changes)) if ((change as Row)?.type === 'add') add(path, 'file', item.id, start, end);
      }
      if (row.type !== 'response_item') return;
      if (p.type === 'function_call' && ['exec_command', 'shell_command', 'shell'].includes(p.name)) {
        if (!unique(p.call_id, 'call')) return;
        try { calls.set(p.call_id, {name: p.name, input: JSON.parse(p.arguments), time}); } catch { /* Unknown argument shape is retained. */ }
      }
      if (p.type === 'function_call_output') {
        if (!unique(p.call_id, 'result')) return;
        const call = calls.get(p.call_id); calls.delete(p.call_id);
        const output = successOutput(p.output);
        if (call && output !== null) shell(call.input.cmd ?? call.input.command, output, p.call_id, call.time, time);
      }
    } else if (Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (row.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash' && unique(block.id, 'call')) calls.set(block.id, {name: block.name, input: block.input ?? {}, time});
        if (row.type === 'user' && block.type === 'tool_result') {
          if (!unique(block.tool_use_id, 'result')) continue;
          const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
          const output = textContent(block.content), result = row.toolUseResult;
          if (call && block.is_error === false && !result?.backgroundTaskId && !result?.interrupted && !output.startsWith('Command running in background'))
            shell(call.input.command, output, block.tool_use_id, call.time, time);
        }
      }
    }
  }};
}
interface History { provider: Provider; file: FileEntry }
async function historySnapshot(roots: Roots, signal?: AbortSignal) {
  const histories: History[] = [], stamps = new Map<string, unknown>(), warnings: string[] = [];
  const uid = process.getuid?.();
  for (const provider of ['claude', 'codex'] as const) {
    const root = roots[provider];
    const inspectDirectory = async (path: string) => {
      const s = await lstat(path);
      if (!s.isDirectory() || s.uid !== uid || s.mode & 0o022 || await realpath(path) !== path) throw new Error('Unsafe history directory');
      stamps.set(provider + ':' + path, [s.dev, s.ino, s.mode, s.uid, s.mtimeMs, s.ctimeMs]);
    };
    try {
      await inspectDirectory(root);
      const directories: string[] = [];
      for (const name of provider === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) {
        const path = join(root, name);
        try { await inspectDirectory(path); directories.push(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; stamps.set(provider + ':' + path, null); }
      }
      while (directories.length) {
        signal?.throwIfAborted();
        const directory = directories.pop()!;
        await inspectDirectory(directory);
        for await (const entry of await opendir(directory)) {
          signal?.throwIfAborted();
          const path = join(directory, entry.name), s = await lstat(path);
          if (s.isSymbolicLink()) throw new Error('Linked history');
          if (s.isDirectory()) { directories.push(path); continue; }
          if (!/\.jsonl(?:\..*)?$/.test(entry.name)) continue;
          if (!s.isFile() || !path.endsWith('.jsonl') || s.nlink !== 1 || s.uid !== uid || s.mode & 0o022) throw new Error('Unsupported, shared or unsafe history');
          const file: FileEntry = {path, relative: relative(root, path), size: s.size, allocatedBytes: s.blocks * 512,
            dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, nlink: s.nlink, mode: s.mode, uid: s.uid, category: 'sessions'};
          histories.push({provider, file});
          stamps.set(provider + ':' + path, [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.nlink, s.uid]);
        }
      }
    } catch (error) {
      // A missing provider root is empty; a disappearing subtree is an incomplete inventory.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !stamps.has(provider + ':' + root)) stamps.set(provider + ':' + root, null);
      else warnings.push(`${provider}: history inventory is incomplete, linked or unsafe; session temporary files retained`);
    }
  }
  signal?.throwIfAborted();
  histories.sort((a, b) => a.file.path.localeCompare(b.file.path));
  return {histories, warnings, fingerprint: createHash('sha256').update(JSON.stringify([...stamps].sort(([a], [b]) => a.localeCompare(b)))).digest('hex')};
}
// A basename match deliberately retains ambiguous variable/relative references too.
const referenceAliases = (path: string) => [...tempPathAliases(path), basename(path)];
function strings(value: unknown, visit: (text: string) => void, depth = 0) {
  if (typeof value === 'string') { visit(value); return; }
  if (depth > 30) throw new Error('History reference nesting is unsupported');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { visit(key); strings(child, visit, depth + 1); }
}
export async function discoverSessionTemps(roots: Roots, excludedRoots: string[], signal?: AbortSignal, onProgress?: (p: ScanProgress) => void) {
  const snapshot = await historySnapshot(roots, signal), warnings = snapshot.warnings;
  const found: {provider: Provider; evidence: SessionTempEvidence}[] = [];
  if (warnings.length) return {found, warnings};
  for (const [i, {provider, file}] of snapshot.histories.entries()) {
    signal?.throwIfAborted();
    onProgress?.({phase: 'sessions', completed: i, total: snapshot.histories.length, currentFile: file.path});
    const collector = sessionTempCollector(provider);
    const parsed = await parseSession(file, provider, false, signal, undefined, collector.record);
    signal?.throwIfAborted();
    if (!parsed.complete) { warnings.push(`${file.path}: incomplete history; session temporary files retained`); continue; }
    if (parsed.inherited) continue;
    for (const creation of collector.creations) {
      try {
        const path = await realpath(creation.path), s = await lstat(path);
        // Only macOS's system aliases may change the spelling; arbitrary symlink paths are not proof.
        if (path !== creation.path && !(process.platform === 'darwin' && path === '/private' + creation.path && /^\/(tmp|var)\//.test(creation.path))) continue;
        if (excludedRoots.some(root => path === root || inside(root, path) || inside(path, root))) continue;
        if (s.uid !== process.getuid?.() || s.mode & 0o022 || (creation.kind === 'directory' ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) continue;
        // Birth time binds a creation event to this object, not a later reuse of its pathname.
        if (!(s.birthtimeMs > 0) || s.birthtimeMs < creation.startedAt - 2000 || s.birthtimeMs > creation.completedAt + 2000) continue;
        if (creation.kind === 'file' && (!standardTemp(path) || !temporaryOutput(basename(path)))) continue;
        await verifyTemporaryLocation(creation.kind === 'directory' ? path : dirname(path));
        found.push({provider, evidence: {...creation, path, roots, fingerprint: snapshot.fingerprint, source: file.path, sessionId: parsed.id, dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs}});
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${creation.path}: cannot verify temporary creation; retained`); }
    }
  }
  if (warnings.some(w => w.includes('incomplete history'))) return {found: [], warnings};
  // A reference from any other rollout (including another provider or a fork) retains the target.
  const shared = new Set<SessionTempEvidence>();
  for (const {provider, file} of snapshot.histories) {
    const candidates = found.filter(f => f.evidence.source !== file.path).map(f => ({e: f.evidence, aliases: referenceAliases(f.evidence.path)}));
    if (!candidates.length) continue;
    const parsed = await parseSession(file, provider, false, signal, undefined, row => strings(row, text => {
      for (const {e, aliases} of candidates) if (aliases.some(path => text.includes(path))) shared.add(e);
    }));
    signal?.throwIfAborted();
    if (!parsed.complete) return {found: [], warnings: [...warnings, 'History references could not be fully checked; session temporary files retained']};
  }
  const after = await historySnapshot(roots, signal);
  if (after.warnings.length || after.fingerprint !== snapshot.fingerprint) return {found: [], warnings: [...warnings, 'History changed during discovery; session temporary files retained']};
  const unique = new Map<string, typeof found[number]>();
  for (const item of found) {
    if (shared.has(item.evidence)) { warnings.push(`${item.evidence.path}: referenced by another history file; retained`); continue; }
    unique.set(item.evidence.path, item);
  }
  const result = [...unique.values()];
  // Shared directories still protect every nested candidate discovered independently.
  return {found: result.filter(f => !found.some(other => other.evidence.kind === 'directory' && inside(other.evidence.path, f.evidence.path))), warnings};
}
export async function verifySessionTempEvidence(e: SessionTempEvidence, provider: Provider, reparse = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await verifyTemporaryLocation(e.kind === 'directory' ? e.path : dirname(e.path));
  const snapshot = await historySnapshot(e.roots, signal);
  if (snapshot.warnings.length || snapshot.fingerprint !== e.fingerprint) throw new Error('Session temporary-file history or references changed; scan again');
  const source = snapshot.histories.find(h => h.provider === provider && h.file.path === e.source);
  if (!source) throw new Error('Temporary creation source is missing');
  if (reparse) {
    const c = sessionTempCollector(provider), parsed = await parseSession(source.file, provider, false, signal, undefined, c.record);
    signal?.throwIfAborted();
    if (!parsed.complete || parsed.inherited || parsed.id !== e.sessionId || !c.creations.some(p => tempPathAliases(e.path).includes(p.path) && p.kind === e.kind && p.callId === e.callId && p.startedAt === e.startedAt && p.completedAt === e.completedAt)) throw new Error('Temporary creation proof is invalid');
    const aliases = referenceAliases(e.path);
    for (const history of snapshot.histories) if (history.file.path !== e.source) {
      let shared = false;
      const other = await parseSession(history.file, history.provider, false, signal, undefined, row => strings(row, text => { if (aliases.some(path => text.includes(path))) shared = true; }));
      signal?.throwIfAborted();
      if (!other.complete || shared) throw new Error('Temporary file references are shared or unverified');
    }
    const after = await historySnapshot(e.roots, signal);
    if (after.warnings.length || after.fingerprint !== snapshot.fingerprint) throw new Error('History changed during temporary evidence verification');
  }
  if (e.kind === 'directory') {
    const s = await lstat(e.path);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || s.mode & 0o022 || s.dev !== e.dev || s.ino !== e.ino || s.birthtimeMs !== e.birthtimeMs || await realpath(e.path) !== e.path) throw new Error('Temporary directory identity changed');
  }
}
export function validSessionTempEvidence(value: unknown, root: string, provider: Provider): value is SessionTempEvidence {
  const e = value as SessionTempEvidence | null;
  return !!e && typeof e === 'object' && !!e.roots && absolute(e.roots.claude) && absolute(e.roots.codex) &&
    absolute(e.path) && temporaryLocation(e.path) && absolute(e.source) && inside(e.roots[provider], e.source) && e.source.endsWith('.jsonl') &&
    (provider === 'claude' ? /^projects\// : /^(?:sessions|archived_sessions)\//).test(relative(e.roots[provider], e.source)) &&
    Object.values(e.roots).every(path => e.path !== path && !inside(path, e.path) && !inside(e.path, path)) &&
    typeof e.sessionId === 'string' && !!e.sessionId && typeof e.callId === 'string' && !!e.callId &&
    typeof e.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(e.fingerprint) &&
    [e.startedAt, e.completedAt, e.birthtimeMs].every(n => Number.isFinite(n) && n > 0) && e.startedAt <= e.completedAt &&
    e.birthtimeMs >= e.startedAt - 2000 && e.birthtimeMs <= e.completedAt + 2000 &&
    [e.dev, e.ino].every(n => Number.isSafeInteger(n) && n >= 0) &&
    (e.kind === 'directory' && root === e.path || e.kind === 'file' && standardTemp(e.path) && root === dirname(e.path) && temporaryOutput(basename(e.path)));
}
