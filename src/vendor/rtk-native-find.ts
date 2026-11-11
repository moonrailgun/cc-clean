// SPDX-License-Identifier: Apache-2.0
// Derived from RTK 0.49.0, commit 653efb6ed02bd287d686c50e830dd1009356904f:
// src/cmds/system/find_cmd.rs (group_by_dir, display_ordered,
// build_capped_listing, filtered_hint, render), src/core/{runner,guard}.rs,
// and text/src/lib.rs (estimate_tokens). Copyright RTK contributors.
// Explicit supplied paths/context only; no filesystem, command, tracking or tee calls.

export interface FindRenderOptions {
  maxResults: number;
  maxExplicit?: boolean;
  filtered?: readonly string[];
  /** Existing recall text supplied by the caller; this helper never creates it. */
  overflowHint?: string;
  filteredHint?: string;
}

const validCap = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const sortPaths = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const terminated = (value: string): string => value && !value.endsWith('\n') ? `${value}\n` : value;
const withHint = (value: string, hint?: string): string => hint === undefined ? value : terminated(value) + hint;

// Rust's Unix Path components ignore repeated separators and non-leading ".",
// preserve "..", and keep the original spelling of the parent path slice.
// Node path.normalize would resolve ".." and therefore change the grouping.
function pathParts(path: string): { parent: string; filename?: string } {
  const components: { value: string; end: number }[] = [];
  if (path.startsWith('/')) components.push({ value: '/', end: 1 });
  for (const match of path.matchAll(/[^/]+/g)) {
    if (match[0] !== '.' || components.length === 0) {
      components.push({ value: match[0], end: match.index + match[0].length });
    }
  }
  const last = components.at(-1);
  const previous = components.at(-2);
  const parent = previous ? path.slice(0, previous.end) : '.';
  const filename = last && !['/', '.', '..'].includes(last.value) ? last.value : undefined;
  return { parent, filename };
}

export function groupFindByDir(files: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const { parent, filename } = pathParts(file);
    const names = groups.get(parent) ?? [];
    names.push(filename ?? file);
    groups.set(parent, names);
  }
  return groups;
}

export function displayFindOrdered(files: readonly string[]): string[] {
  const groups = groupFindByDir(files);
  return [...groups.keys()].sort(sortPaths).flatMap(dir =>
    groups.get(dir)!.map(filename => dir === '.' ? filename : `${dir}/${filename}`));
}

export function buildCappedFindListing(files: readonly string[], maxResults: number): string {
  if (!validCap(maxResults)) return files.map(file => `${file}\n`).join('');
  let listing = files.slice(0, maxResults).join('\n');
  if (files.length > maxResults) listing += `\n+${files.length - maxResults} more`;
  return `${listing}\n`;
}

export function formatFindFilteredHint(filtered: readonly string[], recallHint?: string): string | undefined {
  if (!filtered.length) return undefined;
  const count = filtered.length >= 1000 ? '1000+' : String(filtered.length);
  return withHint(`... (${count} filtered)`, recallHint);
}

function extension(path: string): string {
  const name = pathParts(path).filename;
  if (name === undefined) return 'none';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : 'none';
}

/** Pure render branch, including the source's terminated token-estimate guard. */
export function renderFind(suppliedFiles: readonly string[], options: FindRenderOptions): string {
  const { maxResults } = options;
  if (!validCap(maxResults)) return suppliedFiles.map(file => `${file}\n`).join('');
  const files = [...suppliedFiles].sort(sortPaths);
  const note = formatFindFilteredHint(options.filtered ?? [], options.filteredHint);
  if (!files.length) return terminated(note ?? '');

  const ordered = displayFindOrdered(files);
  const groups = groupFindByDir(files);
  let body = `${files.length}F ${groups.size}D:\n\n`;
  let displayed = 0;
  for (const dir of [...groups.keys()].sort(sortPaths)) {
    if (displayed >= maxResults) break;
    const chars = Array.from(dir);
    const label = chars.length > 50 ? `...${chars.slice(-47).join('')}` : dir;
    const names = groups.get(dir)!;
    const shown = names.slice(0, maxResults - displayed);
    body += `${label}/ ${shown.join(' ')}\n`;
    displayed += shown.length;
  }
  if (displayed < files.length) body += `+${files.length - displayed} more\n`;

  const extensions = new Map<string, number>();
  for (const file of files) {
    const ext = extension(file);
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
  }
  if (extensions.size > 1) {
    // Upstream ties follow HashMap order; use deterministic UTF-8 ordering here.
    const counts = [...extensions].sort((a, b) => b[1] - a[1] || sortPaths(a[0], b[0]));
    body += `\next: ${counts.slice(0, 5).map(([ext, count]) => `.${ext}(${count})`).join(' ')}\n`;
  }
  if (note !== undefined) body += `${note}\n`;

  const hint = displayed < files.length && !options.maxExplicit ? options.overflowHint : undefined;
  const listing = buildCappedFindListing(ordered, maxResults).replace(/\n+$/, '');
  let baseline = withHint(listing, hint);
  if (note !== undefined) baseline += `\n${note}`;
  const candidate = terminated(withHint(body.replace(/\n+$/, ''), hint));
  baseline = terminated(baseline);
  const estimate = (value: string): number => Math.ceil(Buffer.byteLength(value) / 4);
  return estimate(candidate) > estimate(baseline) ? baseline : candidate;
}
