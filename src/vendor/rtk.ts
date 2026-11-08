// Copyright 2026 RTK AI Labs. SPDX-License-Identifier: Apache-2.0
// Modified by cc-clean: TypeScript port of selected RTK CLI filters, with strict
// history guards and no command execution, telemetry or recall files.
// Upstream: 653efb6ed02bd287d686c50e830dd1009356904f. See third_party/rtk/UPSTREAM.md.

export type RtkFilter = 'grep' | 'find' | 'cargo-test' | 'pytest';
const CAP_WARNINGS = 10, CAP_LIST = 20;

// Port of pipe_cmd.rs::grep_wrapper; reject mixed/unrecognized lines instead of dropping them.
function grep(input: string): string {
  const byFile = new Map<string, [string, string][]>();
  let total = 0;
  for (const line of input.trimEnd().split('\n')) {
    const match = /^([^:\r\n]+):(\d+):(.*)$/.exec(line);
    if (!match) return input;
    const [, file, number, content] = match;
    const matches = byFile.get(file) ?? [];
    matches.push([number, content]); byFile.set(file, matches); total++;
  }
  if (!total) return input;
  let out = `${total} matches in ${byFile.size}F:\n\n`;
  for (const file of [...byFile.keys()].sort()) {
    const matches = byFile.get(file)!;
    out += `[file] ${file} (${matches.length}):\n`;
    for (const [number, content] of matches.slice(0, CAP_WARNINGS)) out += `  ${number.padStart(4)}: ${content.trim()}\n`;
    if (matches.length > CAP_WARNINGS) out += `  +${matches.length - CAP_WARNINGS}\n`;
    out += '\n';
  }
  return out;
}

// Port of pipe_cmd.rs::find_wrapper. The caller must establish a path-listing command.
function find(input: string): string {
  if (/^(?:find|fd|rg|grep|error|warning):/im.test(input)) return input;
  const paths = input.split('\n').filter(line => line.trim());
  if (!paths.length) return input;
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.lastIndexOf('/'), dir = slash < 0 ? '.' : path.slice(0, slash), name = path.slice(slash + 1);
    const files = byDir.get(dir) ?? [];
    files.push(name); byDir.set(dir, files);
  }
  let out = `${paths.length} files in ${byDir.size} dirs:\n\n`;
  const dirs = [...byDir.keys()].sort();
  for (const dir of dirs.slice(0, CAP_LIST)) {
    const files = byDir.get(dir)!;
    out += `${dir}/  (${files.length})\n`;
    for (const file of files.slice(0, CAP_WARNINGS)) out += `  ${file}\n`;
    if (files.length > CAP_WARNINGS) out += `  +${files.length - CAP_WARNINGS}\n`;
  }
  if (dirs.length > CAP_LIST) out += `\n+${dirs.length - CAP_LIST} more dirs\n`;
  return out;
}

// Port of cargo_cmd.rs::AggregatedTestResult and the successful-test filtering branch.
function cargoTest(input: string): string {
  let passed = 0, ignored = 0, filtered = 0, suites = 0, duration = 0, hasDuration = true;
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    const match = /^test result: (\w+)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out(?:;\s+finished in ([\d.]+)s)?$/.exec(trimmed);
    if (match) {
      if (match[1] !== 'ok' || Number(match[3]) || Number(match[5])) return input;
      passed += Number(match[2]); ignored += Number(match[4]); filtered += Number(match[6]); suites++;
      hasDuration &&= match[7] !== undefined; duration += Number(match[7] ?? 0);
    } else if (trimmed && !/^(?:Compiling |Downloading |Downloaded |Finished |Running |Doc-tests |running \d+ tests?$|test .+ \.\.\. (?:ok|ignored)$)/.test(trimmed)) return input;
  }
  if (!suites || ![passed, ignored, filtered].every(Number.isSafeInteger) || !Number.isFinite(duration)) return input;
  const counts = [`${passed} passed`];
  if (ignored) counts.push(`${ignored} ignored`);
  if (filtered) counts.push(`${filtered} filtered out`);
  return `cargo test: ${counts.join(', ')} (${suites} suite${suites === 1 ? '' : 's'}${hasDuration ? `, ${duration.toFixed(2)}s` : ''})`;
}

// Port of pytest_cmd.rs::build_pytest_summary's all-passed branch. Unlike the CLI
// filter, retain failures, warnings, skips, captured output and unknown lines in full.
function pytest(input: string): string {
  let summary: RegExpExecArray | null = null;
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    const match = /^(?:=+\s*)?(\d+) passed in (\d+(?:\.\d+)?(?:s| seconds))(?:\s*=+)?$/.exec(trimmed);
    if (match) { if (summary) return input; summary = match; }
    else if (trimmed && !/^(?:=+ test session starts =+|platform .+|rootdir: .+|configfile: .+|testpaths: .+|plugins: .+|collected \d+ items?|(?:\S+\.py(?:::\S+)?\s+)?[. ]+\[\s*\d+%\])$/.test(trimmed)) return input;
  }
  return summary && Number(summary[1]) > 0 ? `Pytest: ${summary[1]} passed in ${summary[2]}` : input;
}

export function filterRtkOutput(filter: RtkFilter, input: string): string {
  // History is an asset: unsupported terminal controls and diagnostics stay intact.
  if (!input || /[\x00-\x08\x0b-\x1f\x7f]/.test(input)) return input;
  const out = ({ grep, find, 'cargo-test': cargoTest, pytest })[filter](input);
  return Buffer.byteLength(out) < Buffer.byteLength(input) ? out : input;
}
