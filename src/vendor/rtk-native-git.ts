// Copyright 2026 RTK AI Labs. Licensed under Apache-2.0.
// Modified by cc-clean: pure historical-text TypeScript port with strict grammar,
// complete-record validation, no repository reads, commands, telemetry, or tee.
// RTK 0.49.0, 653efb6ed02bd287d686c50e830dd1009356904f, git_cmd/diff_cmd.rs.
// Source mapping and conservative passthrough boundaries: NATIVE-GIT.md.
import { clean, lines, type Filter } from './rtk-native-common.ts';

const nonempty = (input: string): string[] => lines(clean(input)).filter(line => line.trim());
const hex = '[0-9a-f]{7,64}';
const summary = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const failure = /(?:^|\n)(?:fatal:|error:|warning:|CONFLICT|Aborting)/i;
function branch(input: string): string {
  const rows = nonempty(input), local: string[] = [], remote = new Set<string>();
  let current: string | undefined;
  for (const row of rows) {
    const match = /^([* ]) ([^\s~^:?*\[\\]+)$/.exec(row);
    if (/^  remotes\/[^\s/]+\/HEAD -> [^\s]+$/.test(row)) continue;
    if (!match || match[2].includes('..') || match[2].includes('@{')) return input;
    if (match[1] === '*') { if (current !== undefined) return input; current = match[2]; }
    else if (match[2].startsWith('remotes/')) {
      const slash = match[2].indexOf('/', 8);
      if (slash < 0 || !match[2].slice(slash + 1)) return input;
      remote.add(match[2].slice(slash + 1));
    } else local.push(match[2]);
  }
  // Remote-only and detached/verbose listings need a different grammar.
  if (current === undefined) return input;
  const unique = [...remote].filter(value => value !== current && !local.includes(value));
  return [`* ${current}`, ...local.map(value => `  ${value}`), ...(unique.length ? [
    `  remote-only (${unique.length}):`, ...unique.slice(0,10).map(value => `    ${value}`),
    ...(unique.length > 10 ? [`    ... +${unique.length - 10} more`] : []),
  ] : [])].join('\n');
}
function stashList(input: string): string {
  const rows = nonempty(input), out: string[] = [];
  for (const row of rows) {
    const match = /^(stash@\{\d+\}): (?:WIP on |On )([^:]+): (.+)$/.exec(row);
    if (!match) return input;
    out.push(`${match[1]}: ${match[3]}`);
  }
  return out.length ? out.join('\n') : input;
}
function statRow(row: string): string | undefined {
  const index = row.lastIndexOf('|');
  if (index < 0) return;
  const path = row.slice(0,index).trim(), right = row.slice(index + 1).trim();
  if (!path) return;
  if (/^Bin \d+ -> \d+ bytes$/.test(right)) return `${path} (binary)`;
  const match = /^(\d+)(?:[ \t]+([+-]+))?$/.exec(right);
  return match ? `${path} ${match[1]}${match[2]?.includes('+') ? ' +' : ''}${match[2]?.includes('-') ? match[2].includes('+') ? '-' : ' -' : ''}` : undefined;
}
function stat(input: string): string {
  const rows = nonempty(input), files: string[] = [];
  let total: string | undefined;
  for (const row of rows) {
    const trimmed = row.trim(), file = statRow(trimmed);
    if (file && total === undefined) files.push(file);
    else if (summary.test(trimmed) && total === undefined) total = trimmed;
    else return input;
  }
  if (!files.length || !total) return input;
  return [...files.slice(0,20), ...(files.length > 20 ? [`... +${files.length - 20} more files`] : []),
    total.replace(/insertions?\(\+\)/g,'+').replace(/deletions?\(-\)/g,'-').replace(/files? changed/,'changed').replaceAll(',','')].join('\n');
}
function worktree(input: string): string {
  const rows = nonempty(input), out: string[] = [];
  for (const row of rows) {
    const match = /^(.*?) {2,}([0-9a-f]{7,64})[ \t]+(\[[^\]\n]+\]|\(detached HEAD\))(?:[ \t]+(locked|prunable))?$/.exec(row);
    if (!match || !match[1]) return input;
    out.push(`${match[1]} ${match[2]} ${match[3]}${match[4] ? ` ${match[4]}` : ''}`);
  }
  return out.length ? out.join('\n') : input;
}
function lsTree(input: string): string {
  if (!input.endsWith('\n') || input.includes('\r') || input.includes('\t') || failure.test(input)) return input;
  const paths = input.slice(0,-1).split('\n');
  if (paths.length < 2 || paths.some(path => !path || path.endsWith('/') || path.includes('\0'))) return input;
  const out: string[] = [];
  let dir: string | undefined, run: string[] = [];
  const flush = () => { if (dir !== undefined) out.push(`${dir} ${run.join(' ')}`); dir = undefined; run = []; };
  for (const path of paths) {
    if (path.startsWith('"') || path.includes(' ')) { flush(); out.push(path.startsWith('"') ? path : `"${path}"`); continue; }
    const slash = path.lastIndexOf('/'), next = slash < 0 ? './' : path.slice(0, slash + 1);
    if (dir !== next) { flush(); dir = next; }
    run.push(path.slice(slash + 1));
  }
  flush();
  const result = out.join('\n') + '\n';
  return Buffer.byteLength(result) < Buffer.byteLength(input) ? result : input;
}
function commit(input: string): string {
  const rows = nonempty(input);
  if (!rows.length) return input;
  const match = new RegExp(`^\\[[^\\]\\n]+ (${hex})\\] .+$`).exec(rows[0]);
  if (!match || !rows.slice(1).every(row => summary.test(row.trim()) || /^ (?:create|delete) mode \d{6} .+$/.test(row) || /^ (?:rename|copy) .+ \(\d+%\)$/.test(row))) return input;
  return `ok ${match[1].slice(0,7)}`;
}
function checkout(input: string): string {
  const rows = nonempty(input);
  if (rows.length !== 1) return input;
  const row = rows[0].trim();
  let match = /^(Switched to a new branch|Switched to branch|Already on) '([^']+)'$/.exec(row);
  if (match) return `ok ${match[2]}${match[1] === 'Switched to a new branch' ? ' (new)' : ''}`;
  match = new RegExp(`^HEAD is now at (${hex}) .+$`).exec(row);
  if (match) return `ok HEAD ${match[1]}`;
  return /^Updated \d+ paths? from (?:the index|[0-9a-f]+)$/.test(row) ? `ok ${row.toLowerCase()}` : input;
}
function transfer(input: string): string {
  const noise = /^(?:Enumerating objects: \d+, done\.|(?:Counting|Compressing|Writing) objects: \d+% \(\d+\/\d+\)(?:, [\d.]+ [KMGT]?i?B(?: \| [\d.]+ [KMGT]?i?B\/s)?)?, done\.|Delta compression using up to \d+ threads|Total \d+ \(delta \d+\), reused \d+ \(delta \d+\)(?:, pack-reused \d+(?: \(from \d+\))?)?)$/;
  const rows = lines(input), out = rows.filter(row => !noise.test(clean(row)));
  // Never emit an empty confirmation or discard unknown, remote, or error lines.
  return out.some(row => row.trim()) && out.length < rows.length ? out.join('\n') : input;
}
function pull(input: string): string {
  const rows = nonempty(input);
  if (rows.length === 1 && /^Already up[- ]to[- ]date\.$/.test(rows[0])) return 'ok (up-to-date)';
  let total: RegExpExecArray | null = null;
  if (!rows.length) return input;
  for (const row of rows) {
    const match = summary.exec(row.trim());
    if (match && !total) total = match;
    else if (total || !(/^Updating [0-9a-f]+\.\.[0-9a-f]+$/.test(row) || row === 'Fast-forward' || statRow(row))) return input;
  }
  return total ? `ok ${total[1]} files +${total[2] ?? 0} -${total[3] ?? 0}` : input;
}
function stashAction(input: string): string {
  const rows = nonempty(input);
  return rows.length === 1 && /^Saved working directory and index state (?:WIP on |On )[^:]+: .+$/.test(rows[0]) ? 'ok stashed' : input;
}

type Entry = {name: string; notes: string[]; changes: string[]; added: number; removed: number; prefixes?: [string,string]; from?: string; paired: boolean; mode?: string; hunks: number};
type Budget = {old: number[]; next: number; marked: number};
const entry = (name: string): Entry => ({name, notes: [], changes: [], added: 0, removed: 0, paired: false, hunks: 0});
function hunkHeader(row: string): Budget | undefined {
  const ats = /^@+/.exec(row)?.[0].length ?? 0;
  if (ats < 2 || ats > 9) return;
  const tokens = row.slice(ats).split(' ').filter(Boolean);
  if (tokens[ats] !== '@'.repeat(ats)) return;
  const counts: number[] = [];
  for (let i = 0; i < ats; i++) {
    const range = new RegExp(`^${i === ats - 1 ? '\\+' : '-'}(\\d+)(?:,(\\d+))?$`).exec(tokens[i] ?? '');
    if (!range || !Number.isSafeInteger(Number(range[1])) || !Number.isSafeInteger(Number(range[2] ?? 1))) return;
    counts.push(Number(range[2] ?? 1));
  }
  return {old: counts.slice(0,-1), next: counts.at(-1)!, marked: 0};
}
function pathName(raw: string): string | undefined {
  let name = raw.replace(/\t(?:\d{4}-\d\d-\d\d[ \t].*|\(revision \d+\)|\(working copy\))$/, '');
  if (name.startsWith('"')) {
    // Preserve Git C quoting verbatim. It is already lossless and display-safe.
    if (!/^"(?:[^"\\]|\\(?:[0-7]{3}|[abfnrtv\\"]))+"$/.test(name)) return;
    return name;
  }
  return name && !/[\t\r\n]/.test(name) ? name : undefined;
}
function stripPrefix(name: string, prefix: string): string {
  return name.startsWith(prefix + '/') ? name.slice(prefix.length + 1)
    : name.startsWith('"' + prefix + '/') ? '"' + name.slice(prefix.length + 2) : name;
}
function pairName(left: string, right: string, prefixes?: [string,string]): string | undefined {
  let old = pathName(left), next = pathName(right);
  if (!old || !next) return;
  if (prefixes) { if (prefixes[0]) old = stripPrefix(old,prefixes[0]); if (prefixes[1]) next = stripPrefix(next,prefixes[1]); }
  else if (old !== next) { old = stripPrefix(old,'a'); next = stripPrefix(next,'b'); }
  return next === '/dev/null' ? old : next;
}
function gitHeader(rest: string): {name: string; prefixes: [string,string]} | undefined {
  // Search split positions; identical tails support spaces and mnemonic prefixes.
  // A fixed candidate ceiling prevents quadratic work on many-space paths.
  let spaces = 0;
  for (const char of rest) if (char === ' ' && ++spaces > 64) return;
  let found: {name: string; prefixes: [string,string]; score: number} | undefined;
  for (let i = rest.indexOf(' '); i >= 0; i = rest.indexOf(' ',i + 1)) {
    const x = pathName(rest.slice(0,i)), y = pathName(rest.slice(i + 1));
    if (!x || !y) continue;
    if (x === y) return {name: y, prefixes: ['','']};
    const a = x.startsWith('"') ? x.slice(1) : x, b = y.startsWith('"') ? y.slice(1) : y;
    const px = a.slice(0,a.indexOf('/')), py = b.slice(0,b.indexOf('/'));
    if (!px || !py || !a.includes('/') || !b.includes('/')) continue;
    const nx = stripPrefix(x,px), ny = stripPrefix(y,py);
    if (nx === ny && (!found || ny.length > found.score)) found = {name: ny, prefixes: [px,py], score: ny.length};
  }
  if (found) return found;
  const match = /^(a\/\S+|"a\/(?:[^"\\]|\\.)+") (b\/\S+|"b\/(?:[^"\\]|\\.)+")$/.exec(rest);
  return match ? {name: stripPrefix(match[2],'b'), prefixes: ['a','b']} : undefined;
}
// Budget accounting is ported from condense_unified_diff_strict. Producer prose
// that requires repository/mbox context stays raw; every accepted line is owned.
function strictDiff(input: string): string {
  const rows = lines(input), entries: Entry[] = [];
  let current: Entry | undefined, budget: Budget | undefined, emitted = -2;
  let roots: [string,string] | undefined;
  const flush = (): boolean => {
    if (!current) return true;
    if (current.from || current.mode || (!current.hunks && !current.notes.length)) return false;
    entries.push(current); current = undefined; return true;
  };
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i], row = clean(raw);
    if (budget) {
      if (row.startsWith('\\')) { if (emitted === i - 1) { current!.changes.push(raw); emitted = i; } continue; }
      const prefix = row.slice(0,budget.old.length);
      if (prefix.length !== budget.old.length || /[^ +\-]/.test(prefix)) return input;
      const inResult = !prefix.includes('-');
      for (let k = 0; k < budget.old.length; k++) if (prefix[k] === '-' || (prefix[k] === ' ' && inResult)) if (--budget.old[k] < 0) return input;
      if (inResult && --budget.next < 0) return input;
      if (prefix.includes('-') || prefix.includes('+')) {
        if (prefix.includes('-')) current!.removed++; else current!.added++;
        current!.changes.push(raw); emitted = i; budget.marked++;
      }
      if (!budget.next && budget.old.every(value => value === 0)) { if (!budget.marked) return input; budget = undefined; }
      continue;
    }
    if (row.startsWith('\\')) { if (emitted !== i - 1 || !current) return input; current.changes.push(raw); emitted = i; continue; }
    if (row.startsWith('diff --git ') || row.startsWith('diff --cc ') || row.startsWith('diff --combined ')) {
      if (!flush()) return input;
      if (row.startsWith('diff --git ')) {
        const info = gitHeader(row.slice(11)); if (!info) return input;
        current = entry(info.name); current.prefixes = info.prefixes;
      } else {
        const name = pathName(row.slice(row.startsWith('diff --cc ') ? 10 : 16)); if (!name) return input;
        current = entry(name); current.prefixes = ['a','b'];
      }
      roots = undefined; continue;
    }
    if (/^diff -(?:[A-Za-z]+|-[A-Za-z-]+)(?: -[A-Za-z]+)* \S+ \S+$/.test(row)) {
      if (!flush()) return input;
      roots = ['','']; continue;
    }
    if (row.startsWith('Index: ')) { if (!flush()) return input; current = entry(row.slice(7)); current.prefixes = ['','']; continue; }
    if (current && !current.hunks && /^=+$/.test(row)) continue;
    if (row.startsWith('--- ') && rows[i + 1]?.startsWith('+++ ') && rows[i + 2]?.startsWith('@@')) {
      if (current?.hunks || current?.notes.includes('binary')) { if (!flush()) return input; }
      const name = pairName(row.slice(4), rows[++i].slice(4), current?.prefixes ?? roots);
      if (!name) return input;
      if (!current) current = entry(name);
      if (!current.notes.some(note => /^(?:renamed|copied) from /.test(note))) current.name = name;
      current.paired = true; continue;
    }
    if (row.startsWith('@@')) {
      if (!current || !current.paired) return input;
      budget = hunkHeader(row); if (!budget || (!budget.next && budget.old.every(value => value === 0))) return input;
      current.hunks++; continue;
    }
    if (current && !current.hunks) {
      if (/^index [0-9a-f]+(?:,[0-9a-f]+)*\.\.[0-9a-f]+(?: \d{6})?$/.test(row) || /^(?:dis)?similarity index \d+%$/.test(row)) continue;
      if (row.startsWith('rename from ') || row.startsWith('copy from ')) { if (current.from) return input; current.from = row; continue; }
      if (row.startsWith('rename to ') || row.startsWith('copy to ')) {
        const kind = row.startsWith('rename') ? 'rename' : 'copy';
        if (!current.from?.startsWith(kind + ' from ')) return input;
        const name = pathName(row.slice(kind.length + 4)), from = pathName(current.from.slice(kind.length + 6));
        if (!name || !from) return input;
        current.name = name; current.notes.push(`${kind === 'rename' ? 'renamed' : 'copied'} from ${from}`); current.from = undefined; continue;
      }
      if (/^old mode \d{6}$/.test(row)) { if (current.mode) return input; current.mode = row; continue; }
      if (/^new mode \d{6}$/.test(row)) { if (!current.mode) return input; current.mode = undefined; current.notes.push('mode changed'); continue; }
      if (/^(?:new|deleted) file mode \d{6}$/.test(row)) { current.notes.push(row.startsWith('new') ? 'new file' : 'deleted'); continue; }
      if (/^Binary files .+ and .+ differ$/.test(row) || row === 'Cannot display: file marked as a binary type.') { current.notes.push('binary'); continue; }
      if (row.startsWith('svn:mime-type = ') && current.notes.includes('binary')) continue;
    }
    const only = /^Only in ([^:]+): ([^:]+)$/.exec(row);
    const binary = /^(Binary files|Files) (\S+) and (\S+) (differ|are identical)$/.exec(row);
    const unmerged = /^\* Unmerged path (.+)$/.exec(row);
    if (only || binary || unmerged) {
      if (!flush()) return input;
      const value = entry(only ? `${only[1].replace(/\/$/,'')}/${only[2]}` : binary ? binary[3] : unmerged![1]);
      value.notes.push(only ? 'only in one side' : binary ? binary[1] === 'Binary files' ? 'binary' : binary[4] === 'differ' ? 'differs' : 'identical' : 'unmerged');
      entries.push(value); continue;
    }
    // Unknown prose, binary payloads, mbox metadata and submodule summaries are
    // retained whole instead of guessing where their semantic boundaries end.
    return input;
  }
  if (budget || !flush() || !entries.length) return input;
  return entries.map(value => {
    const notes = value.notes.length ? ` (${value.notes.join(', ')})` : '';
    const count = value.changes.length || !notes ? ` (+${value.added} -${value.removed})` : '';
    return [`[file] ${value.name}${notes}${count}`, ...value.changes].join('\n');
  }).join('\n');
}
function show(input: string): string {
  if (failure.test(input)) return input;
  if (input.startsWith('diff --')) return strictDiff(input);
  if (!/^commit [0-9a-f]{7,64}(?: .*)?\r?\n/.test(input)) return input;
  const index = input.indexOf('\ndiff --');
  if (index < 0) return input;
  const patch = input.slice(index + 1), filtered = strictDiff(patch);
  return filtered === patch ? input : input.slice(0,index + 1) + filtered;
}

export const gitNativeFilters: Record<string, Filter> = {
  'git-branch': branch, 'git-stash-list': stashList,
  'git-stash-show': input => input.startsWith('diff --') ? strictDiff(input) : stat(input),
  'git-stash-action': stashAction, 'git-worktree-list': worktree, 'git-ls-tree': lsTree,
  'git-show': show, 'git-commit': commit, 'git-checkout': checkout,
  'git-push': transfer, 'git-fetch': transfer, 'git-pull': pull, 'diff-stdin': strictDiff,
};

export function matchGitNativeFilter(argv: string[]): string | undefined {
  const [exe, command, ...args] = argv;
  if (exe === 'diff') return argv.length === 1 || command === '-' && !args.length ? 'diff-stdin' : undefined;
  if (exe !== 'git') return;
  const opts = args.filter(value => value.startsWith('-'));
  if (command === 'branch') return args.every(value => ['-a','--all','--list','--no-color'].includes(value)) ? 'git-branch' : undefined;
  if (command === 'stash') {
    if (args[0] === 'list') return args.slice(1).every(value => /^-\d+$/.test(value) || !value.startsWith('-')) ? 'git-stash-list' : undefined;
    if (args[0] === 'show') return args.slice(1).every(value => ['-p','--patch','--stat','--no-color','-u','--include-untracked'].includes(value) || !value.startsWith('-')) ? 'git-stash-show' : undefined;
    return !args.length || ['push','save'].includes(args[0]) ? 'git-stash-action' : undefined;
  }
  if (command === 'worktree') return args[0] === 'list' && !args.slice(1).length ? 'git-worktree-list' : undefined;
  if (command === 'ls-tree') {
    if (!args.some(value => value === '--name-only' || value === '--name-status')) return;
    return opts.every(value => /^-[rtd]+$/.test(value) || ['--name-only','--name-status','--full-name','--full-tree','--abbrev','--'].includes(value) || /^--abbrev=\d+$/.test(value)) ? 'git-ls-tree' : undefined;
  }
  if (command === 'show') return !args.some(value => value.includes(':')) && opts.every(value => ['--no-color','--patch','-p','--'].includes(value) || /^-U\d+$/.test(value) || /^--unified=\d+$/.test(value)) ? 'git-show' : undefined;
  if (command === 'commit') return opts.some(value => ['--dry-run','--porcelain','--short','--branch','--long'].includes(value)) ? undefined : 'git-commit';
  if (['checkout','switch','restore'].includes(command)) return 'git-checkout';
  if (['push','fetch','pull'].includes(command)) return opts.some(value => value === '--porcelain' || value.startsWith('--recurse-submodules=')) ? undefined : `git-${command}`;
}
