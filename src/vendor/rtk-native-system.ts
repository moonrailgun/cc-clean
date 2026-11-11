// SPDX-License-Identifier: Apache-2.0
// RTK 0.49.0 / 653efb6ed02bd287d686c50e830dd1009356904f:
// cmds/python/pip_cmd.rs, cmds/system/{tree,wc_cmd,ast_grep_cmd}.rs,
// cmds/php/php_cmd.rs, cmds/go/go_cmd.rs. See third_party/rtk/NATIVE.md.
import { json, lines, object, string, truncate, type Filter } from './rtk-native-common.ts';

function pip(input: string, outdated = false): string {
  const data = json(input);
  if (!Array.isArray(data) || !data.every(v => object(v) && string(v.name) && string(v.version) && (v.latest_version == null || string(v.latest_version)))) return input;
  const packages = data as { name: string; version: string; latest_version?: string }[];
  if (outdated) {
    if (!packages.length) return 'pip outdated: All packages up to date';
    return [`pip outdated: ${packages.length} packages`, ...packages.slice(0, 20).map((p, i) => `${i + 1}. ${p.name} (${p.version} → ${p.latest_version ?? 'unknown'})`), ...(packages.length > 20 ? [`\n... +${packages.length - 20} more packages`] : []), '\n[hint] Run `pip install --upgrade <package>` to update'].join('\n');
  }
  if (!packages.length) return 'pip list: No packages installed';
  const groups = new Map<string, typeof packages>();
  for (const p of packages) { const c = (Array.from(p.name)[0] ?? '?').replace(/[A-Z]/, c => c.toLowerCase()); groups.set(c, [...(groups.get(c) ?? []), p]); }
  const out = [`pip list: ${packages.length} packages`];
  for (const [c, ps] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    out.push(`\n[${c.toUpperCase()}]`, ...ps.slice(0, 50).map(p => `  ${p.name} (${p.version})`));
    if (ps.length > 50) out.push(`  ... +${ps.length - 50} more`);
  }
  return out.join('\n');
}
function tree(input: string): string {
  if (!/^[\s│]*[├└]── /m.test(input) || !/^\d+ director(?:y|ies), \d+ files?\s*$/m.test(input)) return input;
  const out = lines(input).filter(s => !/^\d+ director(?:y|ies), \d+ files?\s*$/.test(s));
  while (out[0]?.trim() === '') out.shift();
  while (out.at(-1)?.trim() === '') out.pop();
  return out.join('\n') + '\n';
}
function phpLint(input: string): string {
  const ls = lines(input).filter(s => s.trim());
  if (!ls.length || !ls.every(s => /^(?:No syntax errors detected in |(?:PHP )?(?:Parse error|Fatal error)|Errors parsing )/.test(s.trim()))) return input;
  return ls.map(s => s.trim().replace(/^No syntax errors detected in /, 'ok ')).join('\n');
}
function goVet(input: string): string {
  const ls = lines(input).map(s => s.trim()).filter(Boolean);
  if (!ls.length || !ls.every(s => s.startsWith('#') || /\.go:\d+:/.test(s))) return input;
  const issues = ls.filter(s => !s.startsWith('#') && s.includes('.go:'));
  if (!issues.length) return input;
  return [`Go vet: ${issues.length} issues`, ...issues.slice(0, 20).map((s, i) => `${i + 1}. ${truncate(s, 120)}`), ...(issues.length > 20 ? [`\n... +${issues.length - 20} more issues`] : [])].join('\n');
}
function wc(input: string, mode: 'full' | 'single' | 'mixed'): string {
  // Unlike the upstream whitespace split, retain the complete filename after
  // the numeric columns. Mixed mode has no supplied column count, so ambiguous
  // whitespace-containing names remain raw rather than being partially kept.
  const parsed = lines(input).map(row => {
    const match = mode === 'full' ? /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)(?:[ \t](.*))?$/.exec(row)
      : mode === 'single' ? /^[ \t]*(\d+)(?:[ \t](.*))?$/.exec(row)
      : /^[ \t]*(\d+(?:[ \t]+\d+){1,3})(?:[ \t]+([^\s]+))?$/.exec(row);
    if (!match) return undefined;
    const nums = mode === 'full' ? match.slice(1, 4) : mode === 'single' ? [match[1]] : match[1].split(/[ \t]+/);
    const path = match[mode === 'full' ? 4 : 2];
    return { nums, path };
  });
  if (!input.trim() || parsed.some(row => !row)) return input;
  const rows = parsed as { nums: string[]; path?: string }[];
  if (rows.length > 1 && rows.some(row => row.path === undefined)) return input;
  const paths = rows.map(row => row.path).filter((path): path is string => path !== undefined && path !== 'total');
  let prefix = paths.length > 1 ? paths[0].slice(0, paths[0].lastIndexOf('/') + 1) : '';
  while (prefix && !paths.every(p => p.startsWith(prefix))) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
  const short = (path: string) => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (rows.length === 1) {
    const { nums } = rows[0];
    if (mode === 'single') return nums[0];
    if (mode === 'full') return `${nums[0]}L ${nums[1]}W ${nums[2]}B`;
    return nums.join(' ');
  }
  return rows.map(({ nums, path }) => {
    const total = path === 'total';
    if (mode === 'single') return total ? `Σ ${nums[0]}` : `${nums[0]} ${short(path!)}`;
    if (mode === 'full') return `${total ? 'Σ ' : ''}${nums[0]}L ${nums[1]}W ${nums[2]}B${total ? '' : ` ${short(path!)}`}`;
    return total ? `Σ ${nums.join(' ')}` : `${nums.join(' ')} ${short(path!)}`;
  }).join('\n');
}
function astGrep(input: string): string {
  const rows = lines(input).filter(s => s.trim());
  if (!rows.length || !rows.every(s => /^[^:]+:\d+:/.test(s))) return input;
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const file = row.slice(0, row.indexOf(':'));
    const group = groups.get(file);
    if (group) group.push(row);
    else groups.set(file, [row]);
  }
  const out: string[] = []; let shown = 0, skippedFiles = 0, skippedLines = 0;
  for (const [file, rs] of groups) {
    if (shown >= 50) { skippedFiles++; skippedLines += rs.length; continue; }
    const n = Math.min(10, 50 - shown, rs.length);
    out.push(...rs.slice(0, n)); shown += n;
    if (rs.length > n) out.push(`  … ${rs.length - n} more match line(s) in ${file}`);
  }
  if (skippedFiles) out.push(`… ${skippedLines} more match line(s) in ${skippedFiles} more file(s) not shown`);
  return out.join('\n') + '\n';
}
export const systemFilters: Record<string, Filter> = {
  'pip-list': input => pip(input), 'pip-outdated': input => pip(input, true), tree, 'php-lint': phpLint, 'go-vet': goVet,
  'wc-full': input => wc(input, 'full'), 'wc-single': input => wc(input, 'single'), 'wc-mixed': input => wc(input, 'mixed'), 'ast-grep': astGrep,
};
