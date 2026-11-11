// SPDX-License-Identifier: Apache-2.0
// Derived from RTK 0.49.0 (653efb6ed02bd287d686c50e830dd1009356904f),
// src/cmds/system/search.rs. Explicit parse-aided output only; no engine or tee calls.
import { lines, uint } from './rtk-native-common.ts';

export interface SearchEntry { lineNumber: number; isMatch: boolean; content: string }
export interface SearchMatch extends SearchEntry { file: string }
export interface SearchDisplayOptions { showFile: boolean; showLine: boolean; maxResults: number }
export interface SearchRenderOptions extends SearchDisplayOptions {
  maxPerFile: number;
  maxLineLength: number;
  pattern: string;
  context?: boolean;
  contextOnly?: boolean;
}

export function parseSearchMatchLine(line: string): SearchMatch | undefined {
  if (line.includes('\n')) return undefined;
  const match = /^([^\0]+)\0([0-9]+)([:-])(.*)$/s.exec(line);
  if (!match || !uint(Number(match[2]))) return undefined;
  return { file: match[1], lineNumber: Number(match[2]), isMatch: match[3] === ':', content: match[4] };
}

function displayMatch(entry: SearchMatch, showFile: boolean, showLine: boolean): string {
  const sep = entry.isMatch ? ':' : '-';
  return `${showFile ? entry.file + sep : ''}${showLine ? entry.lineNumber + sep : ''}${entry.content}\n`;
}

export function formatSearchMatchLine(line: string, showFile: boolean, showLine: boolean): string | undefined {
  const entry = parseSearchMatchLine(line);
  return entry && displayMatch(entry, showFile, showLine);
}

export function formatSearchMatchBlock(path: string, entries: readonly SearchEntry[]): string {
  return entries.map(entry => displayMatch({ ...entry, file: path }, true, true)).join('');
}

// Render a captured stream with the upstream streaming filter's one-time cap notice.
export function renderSearchStream(input: string, options: SearchDisplayOptions): string {
  if (!uint(options.maxResults)) return input;
  let shown = 0, capReported = false, output = '';
  for (const line of input ? lines(input) : []) {
    const formatted = formatSearchMatchLine(line, options.showFile, options.showLine);
    if (formatted === undefined) {
      if (line !== '--' || shown < options.maxResults) output += line + '\n';
    } else if (shown >= options.maxResults) {
      if (!capReported) output += `[rtk] output capped at ${options.maxResults} results\n`;
      capReported = true;
    } else {
      shown++;
      output += formatted;
    }
  }
  return output;
}

export function foldSearchPathPrefix(input: string): string | undefined {
  if (/[\0\r\x1b]/.test(input)) return undefined;
  const paths = input ? lines(input) : [];
  if (paths.length < 2 || paths.some(path => !path)) return undefined;
  const dirs = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/') : [];
  const first = dirs(paths[0]);
  let common = first.length;
  for (const path of paths.slice(1)) {
    const parts = dirs(path);
    let shared = 0;
    while (shared < common && shared < parts.length && parts[shared] === first[shared]) shared++;
    common = shared;
    if (!common) return undefined;
  }
  const prefix = first.slice(0, common).join('/') + '/';
  if (prefix.length <= 1) return undefined;
  return `${prefix} (${paths.length} files)\n` + paths.map(path => path.slice(prefix.length) + '\n').join('');
}

export function cleanSearchLine(line: string, maxLength: number, pattern: string, contextRegex?: RegExp): string {
  // Upstream subtracts 3 below; invalid tiny limits must not underflow or discard a line.
  if (!uint(maxLength) || maxLength < 3) return line;
  const trimmed = line.trim();
  const matched = contextRegex && new RegExp(contextRegex.source, contextRegex.flags.replace(/[gy]/g, '')).exec(trimmed)?.[0];
  if (matched !== undefined && Buffer.byteLength(matched) <= maxLength) return matched;
  if (Buffer.byteLength(trimmed) <= maxLength) return trimmed;
  const lower = trimmed.toLowerCase(), position = lower.indexOf(pattern.toLowerCase());
  const chars = Array.from(trimmed);
  if (position < 0) return chars.slice(0, maxLength - 3).join('') + '...';
  const charPosition = Array.from(lower.slice(0, position)).length;
  let start = Math.max(0, charPosition - Math.floor(maxLength / 3));
  const end = Math.min(start + maxLength, chars.length);
  if (end === chars.length) start = Math.max(0, end - maxLength);
  const slice = chars.slice(start, end).join('');
  return start > 0 ? '...' + slice + (end < chars.length ? '...' : '') : slice + '...';
}

export function compactSearchPath(path: string): string {
  if (Buffer.byteLength(path) <= 50) return path;
  const parts = path.split('/');
  return parts.length <= 3 ? path : `${parts[0]}/.../${parts.at(-2)}/${parts.at(-1)}`;
}

// showFile/showLine come from the caller: historical text cannot infer filesystem or argv state.
export function renderSearchOutput(input: string, options: SearchRenderOptions): string {
  const { showFile, showLine, maxResults, maxPerFile, maxLineLength, pattern } = options;
  if (![maxResults, maxPerFile, maxLineLength].every(uint) || maxLineLength < 3) return input;
  const rows = input ? lines(input) : [];
  const parsed = rows.map(parseSearchMatchLine);
  if (rows.some((line, i) => line.trim() && line.trim() !== '--' && !parsed[i])) return input;
  if (!input.trim()) return '';
  const contextRegex = options.contextOnly ? new RegExp(`.{0,20}${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`, 'iu') : undefined;
  const byFile = new Map<string, SearchEntry[]>();
  let plain = '', totalMatches = 0;
  for (const [i, entry] of parsed.entries()) {
    if (!entry) {
      if (rows[i] === '--') plain += '--\n';
      continue;
    }
    plain += displayMatch(entry, showFile, showLine);
    totalMatches += Number(entry.isMatch);
    const entries = byFile.get(entry.file) ?? [];
    entries.push({ ...entry, content: cleanSearchLine(entry.content, maxLineLength, pattern, contextRegex) });
    byFile.set(entry.file, entries);
  }
  let body = '', shown = 0, skippedFiles = 0;
  const files = [...byFile].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const [file, entries] of files) {
    if (shown >= maxResults) { skippedFiles++; continue; }
    const display = compactSearchPath(file);
    let fileShown = 0, previousLine = 0;
    for (const entry of entries.slice(0, maxPerFile)) {
      if (shown >= maxResults) break;
      if (options.context && previousLine > 0 && entry.lineNumber > previousLine + 1) body += '--\n';
      previousLine = entry.lineNumber;
      body += displayMatch({ ...entry, file: display }, showFile, showLine);
      shown++;
      fileShown++;
    }
    if (entries.length > fileShown) body += `  +${entries.length - fileShown} more in ${display}\n`;
  }
  if (skippedFiles) body += `+${skippedFiles} more files\n`;
  const capped = shown < totalMatches || skippedFiles > 0;
  const output = capped ? `${totalMatches} matches in ${byFile.size} files:\n\n${body}` : body;
  return capped && Buffer.byteLength(output) < Buffer.byteLength(plain) ? output : plain;
}
