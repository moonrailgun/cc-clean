// SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0 (653efb6ed02bd287d686c50e830dd1009356904f).
// See third_party/rtk/NATIVE.md for provenance and historical-output boundaries.
export type Filter = (input: string) => string;
export type Obj = Record<string, unknown>;
export const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
export const string = (x: unknown): x is string => typeof x === 'string';
export const uint = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export function json(input: string): unknown { try { return JSON.parse(input); } catch { return undefined; } }
export const lines = (input: string): string[] => input.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
export const clean = (input: string): string => input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
export function truncate(input: string, length: number): string {
  const chars = Array.from(input);
  return chars.length <= length ? input : chars.slice(0, Math.max(0, length - 3)).join('') + '...';
}
export function counts(values: string[]): [string, number][] {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
export function compactPath(path: string): string {
  path = path.replace(/\\/g, '/');
  for (const part of ['/src/', '/lib/']) { const pos = path.lastIndexOf(part); if (pos >= 0) return path.slice(pos + 1); }
  return path.slice(path.lastIndexOf('/') + 1);
}
export function testSummary(passed: number, failed: number, skipped: number, failures: { name: string; error: string }[], duration?: number): string {
  const out = [`PASS (${passed}) FAIL (${failed})${skipped ? ` skipped (${skipped})` : ''}`];
  if (failures.length) {
    out.push('');
    for (const [i, f] of failures.slice(0, 5).entries()) {
      out.push(`${i + 1}. ${f.name}`);
      if (f.error) out.push(...lines(f.error).map(line => `   ${line}`));
    }
    if (failures.length > 5) out.push(`\n... +${failures.length - 5} more failures`);
  }
  if (duration !== undefined) out.push(`\nTime: ${Math.trunc(duration)}ms`);
  return out.join('\n');
}
