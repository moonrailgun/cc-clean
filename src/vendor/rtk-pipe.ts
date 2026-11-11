// Copyright (c) RTK contributors. SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0, commit 653efb6ed02bd287d686c50e830dd1009356904f.
// Licensed under the Apache License, Version 2.0. See third_party/rtk/LICENSE.
// Source mapping and history-only safety changes: third_party/rtk/PIPE.md.

type Filter = (input: string) => string;
type ObjectValue = Record<string, unknown>;
const linesOf = (input: string): string[] => input.replace(/\r\n/g, '\n').split('\n');
const nonempty = (input: string): string[] => linesOf(input).filter(line => line.trim());
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const keys = (value: ObjectValue, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const optional = (value: unknown, valid: (value: unknown) => boolean): boolean => value === undefined || value === null || valid(value);
const string = (value: unknown): value is string => typeof value === 'string';
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const truncate = (value: string, width: number): string => {
  const chars = Array.from(value);
  return chars.length <= width ? value : chars.slice(0, Math.max(0, width - 3)).join('') + '...';
};
function json(input: string): unknown {
  try { return JSON.parse(input); } catch { return undefined; }
}
function group<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const values = result.get(key) ?? [];
    values.push(item);
    result.set(key, values);
  }
  return result;
}
const byCount = <T>(groups: Map<string, T[]>): [string, T[]][] => [...groups].sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]));
function compactPath(path: string, roots = ['src', 'lib', 'tests'], lastSegments = 1): string {
  path = path.replace(/\\/g, '/');
  for (const root of roots) {
    const position = path.lastIndexOf(`/${root}/`);
    if (position !== -1) return path.slice(position + 1);
  }
  return path.split('/').slice(-lastSegments).join('/');
}
const sqlPath = (path: string): string => /^(models|tests|macros|seeds|snapshots|analyses)\//.test(path) ? path : compactPath(path, ['models', 'tests', 'macros', 'seeds', 'snapshots', 'analyses'], 2);
const phpPath = (path: string): string => compactPath(path, [], 2);
const capped = (items: string[], limit: number, noun = 'lines'): string[] => items.length <= limit ? items : [...items.slice(0, limit), `... +${items.length - limit} more ${noun}`];

function cargoTest(input: string): string {
  const summaries: RegExpMatchArray[] = [];
  const failures: string[] = [];
  let block: string[] = [];
  let inFailures = false;
  const flush = () => { if (block.length) failures.push(block.join('\n')); block = []; };
  for (const line of linesOf(input)) {
    const summary = line.match(/^test result: (\w+)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out(?:;\s+finished in ([\d.]+)s)?\s*$/);
    if (summary) {
      if (!summary.slice(2, 7).every(value => uint(Number(value))) ||
          !(summary[1] === 'ok' && Number(summary[3]) === 0 || summary[1] === 'FAILED' && Number(summary[3]) > 0) ||
          summary[7] !== undefined && !/^\d+(?:\.\d+)?$/.test(summary[7])) return input;
      flush(); inFailures = false; summaries.push(summary); continue;
    }
    if (line === 'failures:') { flush(); inFailures = true; continue; }
    if (inFailures) { if (!line.trim()) flush(); else block.push(line); continue; }
    if (!line.trim() || /^\s*(?:Compiling|Downloading|Downloaded|Finished|Running|Doc-tests)\b/.test(line) || /^running \d+ tests?$/.test(line) || /^test .+ \.\.\. (?:ok|ignored|FAILED)(?:, .*)?$/.test(line)) continue;
    return input;
  }
  flush();
  if (!summaries.length) return input;
  if (!failures.length && summaries.every(match => match[1] === 'ok' && Number(match[3]) === 0)) {
    const sum = (index: number) => summaries.reduce((total, match) => total + Number(match[index]), 0);
    let result = `cargo test: ${sum(2)} passed`;
    if (sum(4)) result += `, ${sum(4)} ignored`;
    if (sum(6)) result += `, ${sum(6)} filtered out`;
    result += ` (${summaries.length} ${summaries.length === 1 ? 'suite' : 'suites'}`;
    if (summaries.every(match => match[7] && Number.isFinite(Number(match[7])))) result += `, ${sum(7).toFixed(2)}s`;
    return result + ')';
  }
  const result: string[] = [];
  if (failures.length) result.push(`FAILURES (${failures.length}):`, ...capped(failures.map((failure, index) => `${index + 1}. ${truncate(failure, 200)}`), 10, 'failures'), '');
  result.push(...summaries.map(match => match[0]));
  return result.join('\n');
}

function pytest(input: string): string {
  const lines = linesOf(input);
  const summaryRe = /^(?:=+\s*)?(\d+ [^,\r\n=]+?(?:, \d+ [^,\r\n=]+?)*) in (\d+(?:\.\d+)?)(?:s| seconds)(?: \((?:\d+ days?, )?\d+:\d{2}:\d{2}\))?(?:\s*=+)?$/;
  const summaryIndex = lines.findLastIndex(line => summaryRe.test(line.trim()));
  if (summaryIndex < 0) return input;
  const summary = lines[summaryIndex]!.trim().match(summaryRe)!;
  const counts: Record<string, number> = {passed: 0, failed: 0, skipped: 0, xfailed: 0, xpassed: 0, errors: 0};
  for (const part of summary[1]!.split(',')) {
    const match = part.trim().match(/^(\d+) (passed|failed|skipped|xfailed|xpassed|errors?|warnings?)$/);
    if (!match || /^warning/.test(match[2]!)) return input;
    counts[match[2]!.replace(/^error$/, 'errors')] = Number(match[1]);
  }
  const blocks: {name: string; lines: string[]}[] = [];
  const outcomes: string[] = [];
  let current: {name: string; lines: string[]} | undefined;
  let section = 'header';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || index === summaryIndex) continue;
    if (summaryRe.test(trimmed)) continue;
    if (/^=+.*(?:FAILURES|ERRORS)/.test(trimmed)) { section = 'failures'; continue; }
    if (/^=+.*short test summary info/.test(trimmed)) { section = 'summary'; current = undefined; continue; }
    if (/^=+.*warnings summary/.test(trimmed)) return input;
    const heading = trimmed.match(/^_{2,}\s*(.*?)\s*_{2,}$/);
    if (heading && section === 'failures') { current = {name: heading[1]!, lines: []}; blocks.push(current); continue; }
    if (/^(?:XFAIL|XPASS)\b/.test(trimmed)) { outcomes.push(trimmed); continue; }
    if (/^(?:FAILED|ERROR)\b/.test(trimmed) && section === 'summary') {
      if (!blocks.some(block => trimmed.includes(block.name))) blocks.push({name: trimmed, lines: []});
      continue;
    }
    if (section === 'failures' && current) { current.lines.push(line); continue; }
    if (/^[.sFxXEf]+\s+\[\s*\d+%\]$/.test(trimmed) || /^=+.*test session starts/.test(trimmed) || /^(?:platform |rootdir:|configfile:|plugins:|asyncio:|cachedir:|metadata:|collecting |collected \d+ items?)/.test(trimmed) || /^\S+\.py(?:::.*?)?\s+(?:[.sFxXEf]+|PASSED|FAILED|SKIPPED|XFAIL|XPASS)(?:\s+\[\s*\d+%\])?$/.test(trimmed) || /^=+$/.test(trimmed)) continue;
    return input;
  }
  let result = `Pytest: ${counts.passed} passed`;
  if (counts.failed || counts.skipped || counts.xfailed || counts.xpassed || counts.errors) {
    result += `, ${counts.failed} failed`;
    for (const kind of ['skipped', 'xfailed', 'xpassed']) if (counts[kind]) result += `, ${counts[kind]} ${kind}`;
    if (counts.errors) result += `, ${counts.errors} error${counts.errors === 1 ? '' : 's'}`;
  }
  result += ` in ${summary[2]}s`;
  if (outcomes.length) result += '\n\nExpected-failure outcomes:\n' + capped(outcomes.map(line => truncate(line, 120)), 10, 'outcomes').join('\n');
  for (const block of blocks.slice(0, 10)) {
    result += `\n\n[${/^ERROR/.test(block.name) ? 'ERROR' : 'FAIL'}] ${truncate(block.name, 100)}`;
    const end = block.lines.findIndex(line => /^-{2,} Captured/.test(line.trim()));
    const detail = end < 0 ? block.lines : block.lines.slice(0, end);
    const locations = detail.filter(line => /\.py:\d+/.test(line));
    const selected: string[] = [];
    if (locations.length > 1 && locations[0]!.split(':')[0] !== locations.at(-1)!.split(':')[0]) selected.push(locations[0]!);
    if (locations.length) selected.push(locations.at(-1)!);
    const errors = detail.filter(line => /^E\s/.test(line) && !/^E\s*=/.test(line));
    selected.push(...(errors.length > 4 ? [...errors.slice(0, 2), `... +${errors.length - 4} more error lines`, ...errors.slice(-2)] : errors));
    const contextBudget = Math.max(0, 3 - selected.length);
    selected.push(...detail.filter(line => !selected.includes(line) && /^(?:>|E\s)|assert|Error|\.py:\d+/.test(line.trim())).slice(0, contextBudget));
    // Keep an unknown traceback rather than turning a failure into a title alone.
    const details = selected.length ? selected : capped(detail, 10);
    if (details.length) result += '\n' + details.map(line => '  ' + truncate(line.trimEnd(), 200)).join('\n');
  }
  if (blocks.length > 10) result += `\n... +${blocks.length - 10} more failures`;
  return result;
}

interface GoEvent {Action: string; Package?: string; Test?: string; Output?: string; Time?: string; Elapsed?: number; ImportPath?: string; FailedBuild?: string}
function goEvent(value: unknown): value is GoEvent {
  if (!object(value) || !keys(value, ['Action', 'Package', 'Test', 'Output', 'Time', 'Elapsed', 'ImportPath', 'FailedBuild']) || !string(value.Action)) return false;
  if (!['start', 'run', 'pause', 'cont', 'pass', 'bench', 'fail', 'output', 'skip', 'build-output', 'build-fail'].includes(value.Action)) return false;
  if (!['Package', 'Test', 'Output', 'Time', 'ImportPath', 'FailedBuild'].every(key => optional(value[key], string)) || !optional(value.Elapsed, value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
  if (value.Action === 'build-output') return string(value.ImportPath) && string(value.Output);
  if (value.Action === 'build-fail') return string(value.ImportPath);
  if (value.Action === 'output' && !string(value.Output)) return false;
  return ['Package', 'Test', 'Output', 'Time', 'Elapsed'].some(key => value[key] !== undefined && value[key] !== null);
}
interface GoPackage {pass: number; fail: number; skip: number; build: string[]; failedBuild: boolean; packageFailed: boolean; output: string[]; tests: Map<string, string[]>; failed: string[]; fuzz?: string}
function goTest(input: string): string {
  const records = input.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const events = records.map(record => goEvent(json(record)) ? json(record) as GoEvent : undefined);
  const builds = new Set(events.filter(event => event?.Action === 'fail' && event.FailedBuild).map(event => event!.FailedBuild!));
  const packages = new Map<string, GoPackage>();
  const residual: string[] = [];
  let consumed = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event || ((event.Action === 'build-output' || event.Action === 'build-fail') && !builds.has(event.ImportPath!))) { residual.push(records[index]!); continue; }
    consumed++;
    if (event.Action.startsWith('build-')) continue;
    const name = event.Package ?? 'unknown';
    const pkg = packages.get(name) ?? {pass:0,fail:0,skip:0,build:[],failedBuild:false,packageFailed:false,output:[],tests:new Map<string,string[]>(),failed:[]};
    packages.set(name, pkg);
    if (event.Action === 'pass' && event.Test) pkg.pass++;
    if (event.Action === 'skip' && event.Test) pkg.skip++;
    if (event.Action === 'output' && event.Output) {
      const output = linesOf(event.Output).filter(line => line.trim());
      if (event.Test) pkg.tests.set(event.Test, [...(pkg.tests.get(event.Test) ?? []), ...output]);
      else pkg.output.push(...output);
      const fuzz = output.findLast(line => line.trimStart().startsWith('fuzz: elapsed:'));
      if (fuzz) pkg.fuzz = fuzz.trim();
    }
    if (event.Action === 'fail') {
      if (event.Test) { pkg.fail++; pkg.failed.push(event.Test); }
      else if (event.FailedBuild) {
        pkg.failedBuild = true;
        pkg.build = events.filter(item => item?.Action === 'build-output' && item.ImportPath === event.FailedBuild).flatMap(item => linesOf(item!.Output!)).filter(line => line.trim() && !line.startsWith('#'));
      } else pkg.packageFailed = true;
    }
  }
  if (!consumed || !packages.size) return input;
  const total = [...packages.values()].reduce((sum, pkg) => ({pass:sum.pass+pkg.pass,fail:sum.fail+pkg.fail+(pkg.failedBuild || (pkg.packageFailed && !pkg.fail) ? 1 : 0),skip:sum.skip+pkg.skip,fuzz:sum.fuzz+(pkg.fuzz ? 1 : 0)}), {pass:0,fail:0,skip:0,fuzz:0});
  let result: string;
  if (total.fail) result = `Go test: ${total.pass} passed, ${total.fail} failed${total.skip ? `, ${total.skip} skipped` : ''} in ${packages.size} packages`;
  else if (total.fuzz) result = `Go test: ${total.pass} passed, ${total.fuzz} fuzz in ${packages.size} packages`;
  else if (!total.pass && !total.skip) result = 'Go test: No tests found';
  else result = `Go test: ${total.pass} passed${total.skip ? `, ${total.skip} skipped` : ''} in ${packages.size} packages`;
  for (const [name, pkg] of [...packages].sort((a, b) => compare(a[0], b[0]))) {
    const short = name.slice(name.lastIndexOf('/') + 1);
    if (pkg.failedBuild) result += `\n\n${short} [build failed]\n` + capped(pkg.build.map(line => '  ' + truncate(line.trim(), 120)), 20, 'errors').join('\n');
    else if (pkg.packageFailed && !pkg.fail) result += `\n\n${short} [FAIL]\n` + capped(pkg.output.map(line => '  ' + truncate(line.trim(), 120)), 20).join('\n');
    if (pkg.fail) {
      result += `\n\n${short} (${pkg.pass} passed, ${pkg.fail} failed)`;
      for (const name of pkg.failed) {
        result += `\n  [FAIL] ${name}`;
        const output = (pkg.tests.get(name) ?? []).filter(line => !/^\s*(?:=== RUN|--- FAIL|--- PASS)/.test(line));
        let retainNext = false;
        const details = output.filter(line => {
          const location = /\.go:\d+/.test(line);
          const retain = retainNext || location || /panic|error:|expected|got|want|actual|assert|mismatch|unexpected|fatal|^\s*at\b/i.test(line);
          retainNext = location;
          return retain;
        });
        result += '\n' + capped((details.length ? details : output.slice(0, 1)).map(line => '     ' + truncate(line.trim(), 100)), 5).join('\n');
      }
    }
    if (pkg.fuzz) result += `\n${short}\n  ${pkg.fuzz}`;
  }
  if (residual.length) result += '\n\n' + residual.join('');
  return result;
}

function goBuild(input: string): string {
  const errors: string[] = [];
  for (const line of nonempty(input)) {
    const trimmed = line.trim();
    if (/^(?:# |go: (?:downloading|finding|extracting)\b)/.test(trimmed)) continue;
    if (/\.go:\d+|(?:go\.mod|go\.work|go\.sum):|^(?:undefined:|cannot use |cannot find package|no required module provides package|missing go.sum entry|found packages|go: (?:go.mod file not found|cannot load module|build failed|error|updates to go.mod needed|inconsistent vendoring)|error:|pattern |no Go files in )|import cycle not allowed|build constraints exclude all Go files|function main is undeclared/i.test(trimmed)) errors.push(trimmed);
    else return input;
  }
  if (!errors.length) return input;
  return [`Go build: ${errors.length} errors`, ...capped(errors.map((line, index) => `${index + 1}. ${truncate(line, 120)}`), 20, 'errors')].join('\n');
}

interface CTestCase {number: number; name: string; status: string; reason?: string; duration: number; index: number; total?: number}
function ctest(input: string): string {
  const source = linesOf(input);
  const lines: string[] = [];
  const prefix = /^\s*(?:\d+\/\d+\s+)?Test\s+#\d+:/;
  for (let index = 0; index < source.length; index++) {
    let line = source[index]!;
    if (prefix.test(line)) {
      while (!/[\d.]+\s+sec\s*$/.test(line) && index + 1 < source.length && !/^\s*(?:Start \d+:|\d+% tests passed|Total Test time)/.test(source[index + 1]!) && !prefix.test(source[index + 1]!)) line += '\n' + source[++index]!;
    }
    lines.push(line);
  }
  const cases = new Map<string, CTestCase>();
  const framing = new Set<number>();
  let runTotal: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^\s*(?:\d+\/(\d+)\s+)?Test\s+#(\d+):\s+(.+?)\s+\.{2,}\s*(?:\*{3})?\s*(.+?)\s+([\d.]+)\s+sec\s*$/s);
    if (!match || !Number.isFinite(Number(match[5]))) continue;
    const total = match[1] ? Number(match[1]) : undefined;
    if (runTotal === undefined && total !== undefined) runTotal = total;
    if (total !== undefined && runTotal !== total) continue;
    const [status = '', ...reason] = match[4]!.trim().split(/\s{2,}/);
    const item: CTestCase = {number:Number(match[2]),name:match[3]!,status,duration:Number(match[5]),index,total};
    if (reason.length) item.reason = reason.join(' ').replace(/\s+/g, ' ').replace(/ \]/g, ']');
    cases.set(`${item.number}\0${item.name}`, item);
    framing.add(index);
  }
  const tests = [...cases.values()];
  const isPassed = (item: CTestCase) => item.status.toLowerCase() === 'passed';
  const isDisabled = (item: CTestCase) => /not run \(disabled\)/i.test(item.status);
  const isSkipped = (item: CTestCase) => /^skipped$/i.test(item.status);
  const failed = tests.filter(item => !isPassed(item) && !isDisabled(item) && !isSkipped(item));
  let lastStart = -1;
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index]!.match(/^\s*Start\s+(\d+):\s*(.*?)\s*$/);
    if (start && tests.some(item => item.number === Number(start[1]) && item.name === start[2])) { framing.add(index); lastStart = index; }
  }
  let summary: {failed: number; total: number} | undefined;
  let time: number | undefined;
  let trailerIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = line.match(/^\s*\d+%\s+tests passed,\s+(\d+)\s+tests failed out of\s+(\d+)\s*$/);
    if (match && index > lastStart && (runTotal === undefined || Number(match[2]) <= runTotal) && Number(match[1]) >= failed.length) { summary = {failed:Number(match[1]),total:Number(match[2])}; framing.add(index); }
    const duration = line.match(/^\s*Total Test time \(real\)\s+=\s+([\d.]+)\s+sec\s*$/);
    if (duration && Number.isFinite(Number(duration[1]))) { time = Number(duration[1]); framing.add(index); }
    if (line.trim() === 'The following tests FAILED:') { trailerIndex = index; framing.add(index); }
  }
  if (!tests.length && !summary) {
    const empty = lines.findIndex(line => line.trim() === 'No tests were found!!!');
    if (empty >= 0 && lines.slice(0, empty).every(line => !line.trim() || /^\s*(?:Test project |Internal ctest changing into directory:)/.test(line))) return ['ctest: no tests found', ...lines.slice(empty + 1)].join('\n').trimEnd();
    return input;
  }
  const skipped = tests.filter(isSkipped);
  const disabled = tests.filter(isDisabled).length;
  const total = summary?.total ?? tests.length;
  const failCount = summary?.failed ?? failed.length;
  const passed = summary ? Math.max(0, total - failCount - skipped.length) : tests.filter(isPassed).length;
  let result = `ctest: ${passed}/${total} passed${failCount ? `, ${failCount} failed` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}${disabled ? `, ${disabled} disabled` : ''}${time === undefined ? '' : ` (${time.toFixed(2)} sec)`}`;
  const covered = new Set(framing);
  if (failed.length) {
    result += '\nfailed:';
    for (const item of failed.slice(0, 15)) {
      result += `\n  #${item.number} ${item.name} (${item.status}, ${item.duration.toFixed(2)} sec)`;
      if (item.reason) result += '\n    ' + item.reason;
      const details: string[] = [];
      let boundary = item.index - 1;
      while (boundary >= 0 && !framing.has(boundary)) boundary--;
      if (boundary >= 0 && /^\s*Start\s/.test(lines[boundary]!)) for (let i = boundary + 1; i < item.index; i++) { details.push(lines[i]!.trimEnd()); covered.add(i); }
      for (let i = item.index + 1; i < lines.length && !framing.has(i); i++) { details.push(lines[i]!.trimEnd()); covered.add(i); }
      while (details[0] === '') details.shift();
      while (details.at(-1) === '') details.pop();
      const shown = details.length > 10 ? [...details.slice(0, 2), `... +${details.length - 10} more lines`, ...details.slice(-8)] : details;
      for (const detail of shown) result += '\n    ' + detail;
    }
    if (failed.length > 15) result += `\n  ... +${failed.length - 15} more failed`;
  }
  if (trailerIndex >= 0 && failCount) {
    const unparsed: string[] = [];
    for (let i = trailerIndex + 1; i < lines.length; i++) {
      const entry = lines[i]!;
      if (!entry.startsWith('\t')) continue;
      covered.add(i);
      const number = Number(entry.trim().match(/^(\d+)/)?.[1]);
      if (!failed.some(item => item.number === number)) unparsed.push(entry.trim());
    }
    if (unparsed.length) result += '\nfailed (unparsed, raw):\n' + capped(unparsed, 20, 'failed').map(line => '    ' + line).join('\n');
  }
  if (skipped.length) result += '\nskipped:\n' + capped(skipped.map(item => '  ' + item.name), 20, 'skipped').join('\n');
  if (!failCount) {
    const slow = tests.filter(isPassed).sort((a, b) => b.duration - a.duration || compare(a.name, b.name)).slice(0, 3);
    if (slow.length) result += '\nslowest:\n' + slow.map(item => `  ${item.name} ${item.duration.toFixed(2)} sec`).join('\n');
  }
  const extras = lines.filter((line, index) => !covered.has(index) && line.trim() && !/^\s*(?:Test project |Internal ctest changing into directory:|Label Time Summary:|\S+\s+=\s+[\d.]+ sec\*proc)/.test(line));
  // Successful CTest runs may print arbitrary test output; keep it explicitly.
  if (extras.length) result += '\n\n' + extras.join('\n');
  return result;
}

interface Diagnostic {file: string; line: string; code: string; message: string; context: string[]}
function renderDiagnostics(label: string, diagnostics: Diagnostic[], global: string[] = []): string {
  const groups = byCount(group(diagnostics, item => item.file));
  const count = diagnostics.length;
  const result = [...global, `${label}: ${count} errors${groups.length ? ` in ${groups.length} files` : ''}`];
  const codes = byCount(group(diagnostics.filter(item => item.code), item => item.code));
  if (codes.length > 1) result.push('Top codes: ' + codes.slice(0, 5).map(([code, items]) => `${code} (${items.length}x)`).join(', '), '');
  for (const [file, items] of groups) {
    result.push(`${file} (${items.length} errors)`);
    for (const item of items) {
      const code = item.code ? label === 'mypy' ? `[${item.code}] ` : `${item.code}: ` : '';
      result.push(`  L${item.line}: ${code}${truncate(item.message, 120)}`, ...item.context.map(line => '    ' + truncate(line.trim(), 120)));
    }
  }
  return result.join('\n');
}
function tsc(input: string): string {
  const errors: Diagnostic[] = [];
  const globals: {code: string; message: string; context: string[]}[] = [];
  let context: string[] | undefined;
  let clean = false;
  for (const line of nonempty(input)) {
    const match = line.match(/^(.+?)(?:\((\d+),(\d+)\):|:(\d+):(\d+) -)\s*(?:error|warning) (TS\d+): (.*)$/);
    if (match) { const item = {file:match[1]!,line:match[2] ?? match[4]!,code:match[6]!,message:match[7]!,context:[] as string[]}; errors.push(item); context = item.context; continue; }
    const global = line.match(/^(?:error|warning) (TS\d+): (.*)$/);
    if (global) { const item = {code:global[1]!,message:global[2]!,context:[] as string[]}; globals.push(item); context = item.context; continue; }
    if (/^(?:\[[^\]]+\]\s*)?Found 0 errors(?:\.|\b)/.test(line.trim())) { clean = true; continue; }
    if (/^(?:Found \d+ errors?\b|Errors\s+Files|\d+\s+\S+\.tsx?:\d+$|\[[^\]]+\]\s*(?:Starting compilation|File change detected|Found \d+ errors?))/.test(line.trim())) continue;
    if (context && /^\s/.test(line)) { context.push(line); continue; }
    return input;
  }
  if (!errors.length && !globals.length) return clean ? 'TypeScript: No errors found' : input;
  const count = errors.length + globals.length;
  const files = new Set(errors.map(item => item.file)).size;
  const result = [`TypeScript: ${count} errors${files ? ` in ${files} files` : ''}`];
  const codes = byCount(group([...errors, ...globals], item => item.code));
  if (codes.length > 1) result.push('Top codes: ' + codes.slice(0, 5).map(([code, items]) => `${code} (${items.length}x)`).join(', '), '');
  if (globals.length) result.push(`global (${globals.length} errors)`, ...globals.flatMap(item => [`  ${item.code}: ${truncate(item.message, 120)}`, ...item.context.map(line => '    ' + truncate(line.trim(), 120))]));
  for (const [file, items] of byCount(group(errors, item => item.file))) result.push(`${file} (${items.length} errors)`, ...items.flatMap(item => [`  L${item.line}: ${item.code}: ${truncate(item.message, 120)}`, ...item.context.map(line => '    ' + truncate(line.trim(), 120))]));
  return result.join('\n');
}

function vitest(input: string): string {
  let passed = 0, failed = 0, skipped = 0;
  let duration: number | undefined;
  const failures: {name: string; message: string}[] = [];
  if (input.trimStart().startsWith('{')) {
    const root = json(input);
    if (!object(root) || !keys(root, ['testResults','numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests','numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites','startTime','success','snapshot']) || !['numTotalTests','numPassedTests','numFailedTests'].every(key => uint(root[key])) || !optional(root.numPendingTests, uint) || !optional(root.numTodoTests, uint) || !Array.isArray(root.testResults)) return input;
    if (root.snapshot !== undefined) {
      const snapshot = root.snapshot;
      const counters = ['added','filesAdded','filesRemoved','filesUnmatched','filesUpdated','matched','total','unchecked','unmatched','updated'];
      if (!object(snapshot) || !keys(snapshot, [...counters,'didUpdate','failure','filesRemovedList','uncheckedKeysByFile']) || !counters.every(key => optional(snapshot[key],uint)) || !optional(snapshot.didUpdate, value => typeof value === 'boolean') || !optional(snapshot.failure, value => value === false) || !optional(snapshot.filesRemovedList, value => Array.isArray(value) && value.length === 0) || !optional(snapshot.uncheckedKeysByFile, value => Array.isArray(value) && value.length === 0) || ['filesRemoved','filesUnmatched','unchecked','unmatched'].some(key => Number(snapshot[key] ?? 0) !== 0)) return input;
    }
    for (const key of ['numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites','startTime']) if (!optional(root[key], uint)) return input;
    if (!optional(root.success, value => typeof value === 'boolean')) return input;
    let assertions = 0, observedPass = 0, observedFail = 0, observedSkip = 0;
    for (const suite of root.testResults) {
      if (!object(suite) || !keys(suite, ['name','assertionResults','status','message','startTime','endTime']) || !string(suite.name) || !Array.isArray(suite.assertionResults) || !optional(suite.status, string) || !optional(suite.message, string) || !optional(suite.startTime, uint) || !optional(suite.endTime, uint)) return input;
      if (suite.message) return input;
      for (const assertion of suite.assertionResults) {
        if (!object(assertion) || !keys(assertion, ['fullName','status','failureMessages','ancestorTitles','title','duration','location','meta']) || !string(assertion.fullName) || !string(assertion.status) || !strings(assertion.failureMessages) || !optional(assertion.ancestorTitles, strings) || !optional(assertion.title, string) || !optional(assertion.duration, value => typeof value === 'number' && Number.isFinite(value) && value >= 0) || assertion.location != null || assertion.meta != null) return input;
        assertions++;
        if (assertion.status === 'passed') observedPass++;
        else if (assertion.status === 'failed') { observedFail++; failures.push({name:assertion.fullName,message:assertion.failureMessages.join('\n')}); }
        else if (['pending','skipped','todo','disabled'].includes(assertion.status)) observedSkip++;
        else return input;
        if (assertion.status !== 'failed' && assertion.failureMessages.length) return input;
      }
    }
    passed = root.numPassedTests as number; failed = root.numFailedTests as number; skipped = (root.numPendingTests as number | undefined) ?? 0;
    const todo = (root.numTodoTests as number | undefined) ?? 0;
    if (root.numTotalTests !== assertions || passed !== observedPass || failed !== observedFail || skipped + todo !== observedSkip || passed + failed + skipped + todo !== assertions || (root.success === true && failed > 0)) return input;
    skipped += todo;
  } else {
    const lines = nonempty(input);
    const summary = lines.find(line => /^\s*Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.test(line));
    if (!summary) return input;
    const counts = summary.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/)!;
    failed = Number(counts[1] ?? 0); passed = Number(counts[2]); skipped = Number(counts[3] ?? 0);
    let current: {name: string; message: string} | undefined;
    for (const line of lines) {
      if (/\bFAIL\b|\[x\]/.test(line)) { current = {name:line.trim(),message:''}; failures.push(current); continue; }
      if (current && /^\s{2}/.test(line) && !/^\s*(?:Test Files|Tests|Duration|Start at)\b/.test(line)) { current.message += (current.message ? '\n' : '') + line.trimEnd(); continue; }
      const time = line.match(/^\s*Duration\s+([\d.]+)(ms|s)/);
      if (time) { duration = Math.trunc(Number(time[1]) * (time[2] === 's' ? 1000 : 1)); continue; }
      if (line === summary || /^\s*(?:RUN\s+v|DEV\s+v|Test Files\s|Start at\s|[✓✔×❯]\s.*\(\d+ tests?\)|[-─━]{3,}|⎯{3,})/.test(line)) continue;
      return input;
    }
  }
  let result = `PASS (${passed}) FAIL (${failed})${skipped ? ` skipped (${skipped})` : ''}`;
  for (const [index, failure] of failures.slice(0, 5).entries()) result += `\n\n${index + 1}. ${failure.name}\n` + failure.message.split('\n').map(line => '   ' + line).join('\n');
  if (failures.length > 5) result += `\n... +${failures.length - 5} more failures`;
  if (duration !== undefined) result += `\nTime: ${duration}ms`;
  return result;
}

function grep(input: string): string {
  const matches: {file: string; line: string; content: string}[] = [];
  for (const line of nonempty(input)) {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!match) return input;
    matches.push({file:match[1]!,line:match[2]!,content:match[3]!});
  }
  if (!matches.length) return input;
  const files = [...group(matches, item => item.file)].sort((a, b) => compare(a[0], b[0]));
  let result = `${matches.length} matches in ${files.length}F:\n\n`;
  for (const [file, items] of files) {
    result += `[file] ${file} (${items.length}):\n`;
    for (const item of items.slice(0, 10)) result += `  ${item.line.padStart(4)}: ${item.content.trim()}\n`;
    if (items.length > 10) result += `  +${items.length - 10}\n`;
    result += '\n';
  }
  return result;
}
function find(input: string): string {
  const paths = nonempty(input);
  // A plain word is ambiguous with a tool diagnostic; require path evidence.
  if (!paths.length || paths.some(path => /[:\0\t]/.test(path) || path.trim() !== path || (!path.includes('/') && !/^[^.\s][^\s]*\.[^\s]+$/.test(path)))) return input;
  const dirs = [...group(paths, path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')].sort((a, b) => compare(a[0], b[0]));
  let result = `${paths.length} files in ${dirs.length} dirs:\n\n`;
  for (const [dir, files] of dirs.slice(0, 20)) {
    result += `${dir}/  (${files.length})\n`;
    for (const file of files.slice(0, 10)) result += `  ${file.slice(file.lastIndexOf('/') + 1)}\n`;
    if (files.length > 10) result += `  +${files.length - 10}\n`;
  }
  if (dirs.length > 20) result += `\n+${dirs.length - 20} more dirs\n`;
  return result;
}

function gitLog(input: string): string {
  if (!input.includes('---END---')) return input;
  const blocks = input.split('---END---').map(block => block.trim()).filter(Boolean);
  if (!blocks.length || blocks.some(block => !/^[a-f\d]{4,64} .+ \([^\n]*\) <[^\n]*>$/i.test(block.split('\n')[0]!))) return input;
  return blocks.slice(0, 50).map(block => {
    const [header = '', ...body] = block.split('\n');
    const useful = body.map(line => line.trim()).filter(line => line && !/^(?:Signed-off-by:|Co-authored-by:)/.test(line));
    return [truncate(header, 80), ...useful.slice(0, 3).map(line => '  ' + truncate(line, 80)), ...(useful.length > 3 ? [`  [+${useful.length - 3} lines omitted]`] : [])].join('\n');
  }).join('\n');
}
interface DiffHunk {header: string; parents: number[]; remaining: number; width: number; body: string[]}
interface DiffFile {path: string; metadata: string[]; hunks: DiffHunk[]}
function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1;) {
    if (value[index] === '\\') {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/);
      if (octal) { bytes.push(parseInt(octal[0], 8)); index += octal[0].length + 1; continue; }
      const escape = value[++index]!;
      bytes.push(...Buffer.from(({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'} as Record<string, string>)[escape] ?? escape)); index++; continue;
    }
    const code = value.codePointAt(index)!;
    bytes.push(...Buffer.from(String.fromCodePoint(code)));
    index += code > 0xffff ? 2 : 1;
  }
  return Buffer.from(bytes).toString('utf8');
}
function diffPath(header: string): string {
  const rest = header.replace(/^diff --(?:git|cc|combined) /, '');
  if (!header.startsWith('diff --git ')) return unquoteGitPath(rest);
  // Equal-length source/destination pairs also support spaces and custom prefixes.
  if (rest.length % 2 === 1 && rest[Math.floor(rest.length / 2)] === ' ') {
    const half = Math.floor(rest.length / 2);
    const first = unquoteGitPath(rest.slice(0, half));
    const second = unquoteGitPath(rest.slice(half + 1));
    if (first === second) return first;
    if (first.slice(first.indexOf('/') + 1) === second.slice(second.indexOf('/') + 1)) return second.slice(second.indexOf('/') + 1);
  }
  const quoted = rest.match(/ "b\/(.*)"$/);
  if (quoted) return unquoteGitPath('"' + quoted[1] + '"');
  const destination = rest.indexOf(' b/');
  return destination >= 0 ? rest.slice(destination + 3) : unquoteGitPath(rest);
}
function gitDiff(input: string): string {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  const exhausted = () => !hunk || (hunk.remaining === 0 && hunk.parents.every(count => count === 0));
  const lines = linesOf(input);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (/^diff --(?:git|cc|combined) /.test(line)) {
      if (!exhausted()) return input;
      file = {path:diffPath(line),metadata:[],hunks:[]}; files.push(file); hunk = undefined; continue;
    }
    if (!file) return input;
    const match = line.match(/^(@{2,}) (.+?) \1(?:.*)$/);
    if (match) {
      if (!exhausted()) return input;
      const ranges = match[2]!.split(' ');
      if (ranges.length !== match[1]!.length || ranges.some((range, index) => !(index === ranges.length - 1 ? /^\+\d+(?:,\d+)?$/ : /^-\d+(?:,\d+)?$/).test(range))) return input;
      const counts = ranges.map(range => Number(range.split(',')[1] ?? 1));
      hunk = {header:line,parents:counts.slice(0, -1),remaining:counts.at(-1)!,width:match[1]!.length-1,body:[]}; file.hunks.push(hunk); continue;
    }
    if (hunk && (!exhausted() || line === '\\ No newline at end of file')) {
      if (line === '\\ No newline at end of file') { hunk.body.push(line); continue; }
      const prefix = line.slice(0, hunk.width);
      if (prefix && !/^[ +-]+$/.test(prefix)) return input;
      const added = prefix.includes('+'), removed = prefix.includes('-');
      for (let index = 0; index < hunk.parents.length; index++) if (removed ? prefix[index] === '-' : prefix[index] !== '+') hunk.parents[index] = Math.max(0, hunk.parents[index]! - 1);
      if (added || !removed) hunk.remaining = Math.max(0, hunk.remaining - 1);
      hunk.body.push(line); continue;
    }
    if (/^(?:index [0-9a-f,.]+(?: [0-7]+)?|--- |\+\+\+ )/.test(line)) continue;
    if (/^(?:old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|literal |delta )/.test(line)) { file.metadata.push(line); continue; }
    // A binary patch payload and outside-hunk text have no safe lossy parser.
    return input;
  }
  if (!files.length || !exhausted()) return input;
  const result: string[] = [];
  let contextTotal = 0, truncated = false;
  outer: for (const entry of files) {
    result.push('\n' + entry.path, ...entry.metadata);
    let added = 0, removed = 0;
    for (const item of entry.hunks) {
      result.push(item.header);
      let shown = 0, skippedAdd = 0, skippedDel = 0;
      let leading: string[] = [];
      const flush = () => { const keep = Math.min(leading.length, 20-contextTotal); if (keep > 0) { result.push(...leading.slice(-keep)); contextTotal += keep; } leading = []; };
      for (const line of item.body) {
        const prefix = line.slice(0, item.width);
        const add = prefix.includes('+'), del = prefix.includes('-');
        if (line.startsWith('\\')) { if (shown < 100) result.push(line); continue; }
        if (add || del) {
          if (add) added++; if (del) removed++;
          if (shown < 100) { flush(); result.push(line); shown++; }
          else if (del) skippedDel++; else skippedAdd++;
          leading = [];
        } else if (shown > 0) { if (shown < 100) { result.push(line); shown++; } }
        else if (contextTotal < 20) { leading.push(line); if (leading.length > 3) leading.shift(); }
        if (result.length - contextTotal >= 200) { result.push('\n... (more changes truncated)'); truncated = true; break outer; }
      }
      flush();
      if (skippedAdd || skippedDel) {
        const counts = [skippedDel ? `${skippedDel} deletion${skippedDel === 1 ? '' : 's'}` : '', skippedAdd ? `${skippedAdd} addition${skippedAdd === 1 ? '' : 's'}` : ''].filter(Boolean);
        result.push(`  ... (${counts.join(', ')} truncated)`); truncated = true;
      }
    }
    if (added || removed) result.push(`  +${added} -${removed}`);
  }
  if (truncated) result.push('[full diff omitted from this summary]');
  return result.join('\n');
}
function gitStatus(input: string): string {
  const lines = nonempty(input);
  if (!lines.length) return input;
  const body = lines[0]!.startsWith('## ') ? lines.slice(1) : lines;
  if (body.some(line => !/^(?:[ MADRCUT?!]{2}) .+/.test(line))) return input;
  if (lines[0]!.startsWith('## ')) return ['* ' + lines[0]!.slice(3), ...(body.length ? body : ['clean — nothing to commit'])].join('\n');
  return lines.join('\n');
}

function logs(input: string): string {
  const errors = new Map<string, string[]>(), warnings = new Map<string, string[]>();
  const unknown: string[] = [];
  let info = 0;
  const normalize = (line: string) => line.replace(/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]?\d*\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>').replace(/0x[0-9a-f]+/gi, '<HEX>').replace(/\b\d{4,}\b/g, '<NUM>').replace(/\/[\w./-]+/g, '<PATH>').trim();
  for (const line of nonempty(input)) {
    let bucket: Map<string, string[]>;
    if (/error|fatal|panic|critical|alert|emerg|severe/i.test(line)) bucket = errors;
    else if (/warn|notice/i.test(line)) bucket = warnings;
    else if (/info/i.test(line)) { info++; continue; }
    else { unknown.push(line); continue; }
    const normalized = normalize(line);
    bucket.set(normalized, [...(bucket.get(normalized) ?? []), line]);
  }
  if (!errors.size && !warnings.size && !info) return input;
  const total = (bucket: Map<string, string[]>) => [...bucket.values()].reduce((sum, values) => sum + values.length, 0);
  const result = ['Log Summary', `   [error] ${total(errors)} errors (${errors.size} unique)`, `   [warn] ${total(warnings)} warnings (${warnings.size} unique)`, `   [info] ${info} info messages`, ''];
  for (const [title, bucket, cap] of [['ERRORS',errors,10],['WARNINGS',warnings,5]] as const) {
    if (!bucket.size) continue;
    result.push(`[${title}]`);
    result.push(...capped(byCount(bucket).map(([, values]) => `   [×${values.length}] ${truncate(values[0]!,100)}`), cap, title.toLowerCase()), '');
  }
  if (unknown.length) result.push(...unknown);
  return result.join('\n').trimEnd();
}
function mypy(input: string): string {
  const errors: Diagnostic[] = [], fileless: string[] = [];
  let clean = false;
  for (const line of nonempty(input)) {
    const match = line.match(/^(.+?):(\d+)(?::\d+)?: (error|warning|note): (.+?)(?:\s+\[(.+)\])?$/);
    if (match) {
      if (match[3] === 'note') { const previous = errors.at(-1); if (previous?.file === match[1]) previous.context.push(match[4]!); else fileless.push(line); }
      else errors.push({file:match[1]!,line:match[2]!,message:match[4]!,code:match[5] ?? '',context:[]});
      continue;
    }
    if (/^Found \d+ errors? in \d+ files?/.test(line)) continue;
    if (/^Success: no issues found in \d+ source files?$/.test(line)) { clean = true; continue; }
    if (line.includes('error:')) { fileless.push(line); continue; }
    return input;
  }
  if (!errors.length) return fileless.length ? fileless.join('\n') : clean ? 'mypy: No issues found' : input;
  return renderDiagnostics('mypy', errors, fileless.length ? [...fileless,''] : []);
}

type RuffDiagnostic = {code: string; message: string; filename: string; location: {row: number; column: number}; fix?: object | null};
const position = (value: unknown): boolean => object(value) && keys(value, ['row','column']) && uint(value.row) && uint(value.column);
function ruffCheck(input: string): string {
  const data = json(input);
  if (!Array.isArray(data) || !data.every(item => object(item) && keys(item, ['code','message','filename','location','end_location','fix','noqa_row','url','cell','name','severity']) && string(item.code) && string(item.message) && string(item.filename) && position(item.location) && optional(item.end_location, position) && optional(item.noqa_row,uint) && optional(item.cell,uint) && optional(item.url,string) && optional(item.name,string) && optional(item.severity, value => value === 'error') && optional(item.fix, value => object(value) && keys(value,['applicability','message','edits']) && optional(value.applicability,string) && optional(value.message,string) && optional(value.edits, edits => Array.isArray(edits) && edits.every(edit => object(edit) && keys(edit,['content','location','end_location']) && string(edit.content) && position(edit.location) && position(edit.end_location)))))) return input;
  const diagnostics = data as RuffDiagnostic[];
  if (!diagnostics.length) return 'Ruff: No issues found';
  const rules = byCount(group(diagnostics, item => item.code));
  const files = byCount(group(diagnostics, item => item.filename));
  const fixable = diagnostics.filter(item => item.fix != null).length;
  const result = [`Ruff: ${diagnostics.length} issues in ${files.length} files${fixable ? ` (${fixable} fixable)` : ''}`, 'Top rules:'];
  const described = new Set<string>();
  for (const [code, items] of rules.slice(0,10)) {
    const message = items[0]!.message.trim();
    const shared = message && items.every(item => item.message.trim() === message);
    result.push(`  ${code} (${items.length}x)${shared ? ': ' + truncate(message,100) : ''}`);
    if (shared) described.add(code);
  }
  if (rules.length > 10) result.push(`  ... +${rules.length - 10} more rules`);
  result.push('', 'Top files:');
  for (const [file, items] of files.slice(0,10)) {
    result.push(`  ${compactPath(file)} (${items.length} issues)`);
    const fileRules = byCount(group(items, item => item.code));
    for (const [code, matches] of fileRules.slice(0,3)) result.push(`    ${code} (${matches.length})`);
    if (fileRules.length > 3) result.push(`    ... +${fileRules.length - 3} more rules`);
  }
  if (files.length > 10) result.push('', `... +${files.length - 10} more files`);
  result.push('', 'Violations:');
  for (const item of diagnostics.slice(0,50)) result.push(`  ${compactPath(item.filename)}:${item.location.row}:${item.location.column} ${item.code}${described.has(item.code) ? '' : ' ' + truncate(item.message.trim(),100)}`);
  if (diagnostics.length > 50) result.push(`  … +${diagnostics.length - 50} more`);
  if (fixable) result.push('', `[hint] Run \`ruff check --fix\` to auto-fix ${fixable} issues`);
  return result.join('\n');
}
function ruffFormat(input: string): string {
  const files: string[] = [];
  let unchanged = 0, summary = false, write = false, expected: number | undefined;
  for (const line of nonempty(input)) {
    const match = line.trim().match(/^would reformat:\s*(.+)$/i);
    if (match) { files.push(match[1]!); continue; }
    const parts = line.trim().split(/,\s*/);
    if (!parts.every(part => /^\d+ files? (?:would be reformatted|reformatted|left unchanged)$/i.test(part))) return input;
    for (const part of parts) {
      const count = Number(part.match(/^\d+/)![0]);
      if (/left unchanged/i.test(part)) unchanged = count;
      else if (/would be/i.test(part)) expected = count;
      else write = true;
    }
    summary = true;
  }
  if (expected !== undefined && expected !== files.length) return input;
  if (write) return files.length ? input : input.trim();
  if (!files.length) return summary && (expected === undefined || expected === 0) ? 'Ruff format: All files formatted correctly' : input;
  const result = [`Ruff format: ${files.length} files need formatting`, ...files.slice(0,10).map((file,index) => `${index + 1}. ${compactPath(file)}`)];
  if (files.length > 10) result.push('', `... +${files.length - 10} more files`);
  if (unchanged) result.push('', `${unchanged} files already formatted`);
  result.push('', '[hint] Run `ruff format` to format these files');
  return result.join('\n');
}

type SqlViolation = {code: string; description?: string; fixes?: unknown[] | null; start_line_no?: number | null; line_no?: number | null; start_line_pos?: number | null; line_pos?: number | null};
type SqlFile = {filepath: string; violations: SqlViolation[]};
const sqlLine = (value: SqlViolation): number | undefined => value.start_line_no ?? value.line_no ?? undefined;
const sqlColumn = (value: SqlViolation): number | undefined => value.start_line_pos ?? value.line_pos ?? undefined;
const sqlLocation = (path: string, line?: number, column?: number): string => sqlPath(path) + (line === undefined ? '' : ':' + line + (column === undefined ? '' : ':' + column));
function sqlfluffLint(input: string): string {
  const data = json(input);
  const numeric = ['start_line_no','line_no','start_line_pos','line_pos','end_line_no','end_line_pos','start_file_pos','end_file_pos'];
  const validFix = (value: unknown) => object(value) && keys(value,['type','edit',...numeric]) && ['delete','replace','create_before','create_after'].includes(String(value.type)) && optional(value.edit,string) && numeric.every(key => optional(value[key],uint));
  const validViolation = (value: unknown) => object(value) && keys(value, ['code','description','name','warning','fixes',...numeric]) && string(value.code) && optional(value.description,string) && optional(value.name,string) && optional(value.warning,item => typeof item === 'boolean') && numeric.every(key => optional(value[key],uint)) && optional(value.fixes, value => Array.isArray(value) && value.every(validFix));
  if (!Array.isArray(data) || !data.every(file => object(file) && keys(file,['filepath','violations','statistics','timings']) && string(file.filepath) && Array.isArray(file.violations) && file.violations.every(validViolation) && optional(file.statistics, value => object(value) && Object.values(value).every(uint)) && optional(file.timings,value => object(value) && Object.values(value).every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0)))) return input;
  const parsed = data as SqlFile[];
  const files = parsed.filter(file => file.violations.length).sort((a,b) => b.violations.length-a.violations.length || compare(a.filepath,b.filepath));
  const total = files.reduce((sum,file) => sum+file.violations.length,0);
  if (!total) return '✓ SQLFluff: No violations found';
  const details = parsed.flatMap(file => file.violations.map(violation => ({...violation, filepath:file.filepath})));
  const rules = byCount(group(details, item => item.code));
  const fixesReported = details.some(item => item.fixes != null);
  const fixable = details.filter(item => item.fixes?.length).length;
  const described = new Set<string>();
  const result = [`SQLFluff: ${total} violations in ${files.length} files${fixable ? ` (${fixable} fixable)` : ''}`, '═══════════════════════════════════════', 'Top rules:'];
  for (const [code, items] of rules.slice(0,10)) {
    const first = items.find(item => sqlLine(item) !== undefined) ?? items[0]!;
    const description = (items[0]!.description ?? '').trim();
    const shared = description && items.every(item => (item.description ?? '').trim() === description);
    result.push(`  ${code} (${items.length}x, first at ${sqlLocation(first.filepath,sqlLine(first))})${shared ? ': ' + truncate(description,100) : ''}`);
    if (shared) described.add(code);
  }
  if (rules.length > 10) result.push(`  ... +${rules.length - 10} more rules`);
  result.push('', 'Top files:');
  for (const file of files.slice(0,10)) {
    result.push(`  ${sqlPath(file.filepath)} (${file.violations.length} violations)`);
    const fileRules = byCount(group(file.violations,item => item.code));
    for (const [code,items] of fileRules.slice(0,3)) {
      const line = items.map(sqlLine).find(line => line !== undefined);
      result.push(`    ${code} (${items.length}${line === undefined ? '' : `, ${items.length === 1 ? 'line' : 'first at line'} ${line}`})`);
    }
    if (fileRules.length > 3) result.push(`    ... +${fileRules.length - 3} more rules`);
  }
  if (files.length > 10) result.push('', `... +${files.length - 10} more files`);
  result.push('', 'Violations:');
  const ranked = files.flatMap(file => file.violations.map(violation => ({...violation,filepath:file.filepath})));
  for (const item of ranked.slice(0,50)) result.push(`  ${sqlLocation(item.filepath,sqlLine(item),sqlColumn(item))} ${item.code}${described.has(item.code) ? '' : ' ' + truncate((item.description ?? '').trim(),100)}`);
  if (total > 50) result.push(`  … +${total - 50} more`);
  if (!fixesReported) result.push('', '💡 Run `sqlfluff fix` to auto-fix the violations that support it');
  else if (fixable) result.push('', `💡 Run \`sqlfluff fix\` to auto-fix ${fixable} violations`);
  return result.join('\n');
}

function prettier(input: string): string {
  const files: string[] = [];
  let clean = false, write = false, expected: number | undefined;
  for (const raw of nonempty(input)) {
    const line = raw.trim();
    if (/^Checking formatting\.{3}$/.test(line)) continue;
    if (/^All matched files use Prettier code style!$/.test(line)) { clean = true; continue; }
    if (/^(?:\[warn\] )?Code style issues found in (?:\d+ files?|the above file\(s\))\./.test(line)) {
      const match = line.match(/found in (\d+) files?/); if (match) expected = Number(match[1]); continue;
    }
    const file = line.match(/^(?:\[warn\] )?(.+\.(?:[cm]?[jt]sx?|json|mdx?|css|scss|less|html|vue|svelte|ya?ml|graphql))(?:\s+\d+(?:\.\d+)?ms(?: \((?:unchanged|cached)\))?)?$/);
    if (file) { files.push(file[1]!); if (/ms(?: \(|$)/.test(line)) write = true; continue; }
    const modified = line.match(/^(\d+) files? (?:modified|formatted)\.?$/);
    if (modified) { write = true; expected = Number(modified[1]); continue; }
    return input;
  }
  if (expected !== undefined && expected !== files.length) return input;
  if (clean) return files.length ? input : 'Prettier: All files formatted correctly';
  if (!files.length) return input;
  if (write) return `Prettier: ${files.length} files formatted`;
  const result = [`Prettier: ${files.length} files need formatting`, ...files.slice(0,10).map((file,index) => `${index+1}. ${file}`)];
  if (files.length > 10) result.push('', `... +${files.length-10} more files`);
  return result.join('\n');
}

const phpHeader = /^(?:PHPUnit |Pest |ParaTest |Runtime:|Configuration:|Random Seed:)/;
const phpProgress = (line: string) => line.includes('.') && /^[.FEWRSIDNOK\d /%()\-]+$/.test(line);
function phpunit(input: string): string {
  const blocks: string[][] = [];
  let current: string[] | undefined, inFailure = false, success: string | undefined, skippedSuccess = false;
  const counts: Record<string,number> = {Tests:0,Assertions:0,Failures:0,Errors:0,Skipped:0};
  let countSeen = false;
  for (const raw of nonempty(input)) {
    const line = raw.trim();
    if (/^OK \(\d+ tests?, \d+ assertions?\)$/.test(line)) { success = line; continue; }
    if (/^OK, but (?:some tests were skipped!|there were issues!)$/.test(line)) { skippedSuccess = true; continue; }
    if (/^There (?:was|were) \d+ (?:failure|error)s?:$/.test(line)) { inFailure = true; current = undefined; continue; }
    if (/^(?:FAILURES|ERRORS)!$/.test(line)) { inFailure = false; current = undefined; continue; }
    if (/^Tests:/.test(line)) {
      for (const part of line.replace(/\.$/,'').split(/,\s*/)) {
        const match = part.match(/^(Tests|Assertions|Failures|Errors|Skipped): (\d+)$/);
        if (!match) return input;
        counts[match[1]!] = Number(match[2]);
      }
      countSeen = true; continue;
    }
    if (inFailure) {
      if (/^\d+\) \S/.test(line)) { current = [line]; blocks.push(current); }
      else if (current) current.push(line);
      else return input;
      continue;
    }
    if (phpHeader.test(line) || phpProgress(line) || /^Time: .+, Memory: .+$/.test(line)) continue;
    return input;
  }
  if (success) return blocks.length || counts.Failures || counts.Errors ? input : 'PHPUnit: ' + success;
  if (!countSeen) return input;
  if (blocks.length !== counts.Failures! + counts.Errors!) return input;
  if (!blocks.length) return skippedSuccess || counts.Tests ? `PHPUnit: ${counts.Tests} tests, ${counts.Assertions} assertions${counts.Skipped ? `, ${counts.Skipped} skipped` : ''}` : input;
  const result = [`PHPUnit: ${counts.Tests} tests, ${counts.Assertions} assertions, ${counts.Failures} failures${counts.Errors ? `, ${counts.Errors} errors` : ''}`];
  for (const block of blocks.slice(0,10)) {
    result.push('',block[0]!, ...block.slice(1,3).map(line => '  ' + line));
    if (block.length > 3) result.push(`  ... +${block.length-3} more detail lines`);
  }
  if (blocks.length > 10) result.push('', `... +${blocks.length-10} more failures`);
  return result.join('\n');
}
function phpTest(input: string): string {
  const lines = nonempty(input).map(line => line.trim());
  if (!lines.some(line => phpHeader.test(line) || /^(?:PASS|FAIL|Tests:|OK \(|There (?:was|were) \d+ (?:failure|error))/.test(line))) return input;
  const body = lines.filter(line => !phpHeader.test(line) && !phpProgress(line));
  if (!body.length) return input;
  if (body.length > 120) return [...body.slice(0,80), `... +${body.length-120} more lines`, ...body.slice(-40)].join('\n');
  return body.join('\n');
}
function ecs(input: string): string {
  const lines = nonempty(input).map(line => line.trim());
  if (!lines.length) return input;
  const clean = /^\[OK\] No errors found(?:\. Great job!|\.)?$/;
  if (lines.every(line => clean.test(line) || /^[=─\-]+$/.test(line)) && lines.some(line => clean.test(line))) return '✓ ecs: no issues';
  if (!lines.some(line => /\.php(?::|$)|^(?:ERROR|FAIL)\b|\[ERROR\]|^\d+ files? (?:checked|fixed)/.test(line))) return input;
  return lines.filter(line => !/^[=─\-]+$/.test(line)).join('\n');
}

type PhpstanMessage = {message: string; line: number; identifier?: string; tip?: string};
type PhpstanFile = {errors: number; messages: PhpstanMessage[]};
function phpstan(input: string): string {
  const data = json(input);
  if (data === undefined && !/^[\s]*[\[{]/.test(input)) {
    const lines = nonempty(input).map(line => line.trim());
    if (lines.length && lines.every(line => /^\[OK\] No errors(?: found)?[.!]?$/i.test(line) || /^[=─\- ]+$/.test(line))) return 'phpstan: ok';
    if (lines.some(line => /^\[ERROR\] Found \d+ errors?$/i.test(line))) return lines.filter(line => !/^[=─\- ]+$/.test(line)).join('\n');
    return input;
  }
  if (!object(data) || !keys(data,['totals','files','errors']) || !object(data.totals) || !keys(data.totals,['errors','file_errors']) || !uint(data.totals.errors) || !uint(data.totals.file_errors) || !object(data.files) || (data.errors !== undefined && !strings(data.errors))) return input;
  for (const value of Object.values(data.files)) {
    if (!object(value) || !keys(value,['errors','messages']) || !uint(value.errors) || !Array.isArray(value.messages) || value.errors !== value.messages.length || !value.messages.every(item => object(item) && keys(item,['message','line','ignorable','identifier','tip']) && string(item.message) && uint(item.line) && optional(item.ignorable,item => typeof item === 'boolean') && optional(item.identifier,string) && optional(item.tip,string))) return input;
  }
  const files = Object.entries(data.files as Record<string,PhpstanFile>).sort((a,b) => b[1].errors-a[1].errors || compare(a[0],b[0]));
  const global = (data.errors ?? []) as string[];
  if (files.reduce((sum,[,file]) => sum+file.errors,0) !== data.totals.file_errors || global.length !== data.totals.errors) return input;
  const total = data.totals.file_errors + data.totals.errors;
  if (!total) return 'phpstan: ok';
  const result = [`phpstan: ${total} errors in ${files.length} files`];
  if (global.length) result.push('', 'Global errors:', ...global.map(line => '  '+line));
  for (const [path,file] of files.slice(0,10)) {
    result.push('', `${phpPath(path)} (${file.errors} errors)`);
    for (const message of file.messages.slice(0,5)) {
      result.push(`  L${message.line}: ${message.message}${message.identifier ? ` [${message.identifier}]` : ''}`);
      if (message.tip) result.push(`    ${message.tip}`);
    }
    if (file.messages.length > 5) result.push(`  ... +${file.messages.length-5} more`);
  }
  if (files.length > 10) result.push('', `... +${files.length-10} more files`);
  return result.join('\n');
}
function pint(input: string): string {
  const data = json(input);
  if (!object(data) || !keys(data,['files','result']) || !Array.isArray(data.files) || (data.result !== undefined && data.result !== 'pass' && data.result !== 'fail')) return input;
  const files: {name:string;rules:string[]}[] = [];
  for (const file of data.files) {
    if (!object(file) || !keys(file,['name','path','appliedFixers','fixers']) || !string(file.name ?? file.path) || (file.name !== undefined && file.path !== undefined) || (file.appliedFixers !== undefined && file.fixers !== undefined) || !strings(file.appliedFixers ?? file.fixers ?? [])) return input;
    files.push({name:(file.name ?? file.path) as string,rules:(file.appliedFixers ?? file.fixers ?? []) as string[]});
  }
  if (!files.length) return data.result === 'fail' ? input : 'pint: ok';
  files.sort((a,b) => b.rules.length-a.rules.length || compare(a.name,b.name));
  const result = [`pint: ${files.reduce((sum,file) => sum+file.rules.length,0)} changes in ${files.length} files`];
  for (const file of files.slice(0,15)) {
    result.push('', `${file.name} (${file.rules.length})`, ...file.rules.slice(0,5).map(rule => '  - '+rule));
    if (file.rules.length > 5) result.push(`  ... +${file.rules.length-5} more rules`);
  }
  if (files.length > 15) result.push('', `... +${files.length-15} more files`);
  return result.join('\n');
}

/** Pure RTK pipe filters. The caller enforces byte savings and control-byte guards. */
export const pipeFilters: Record<string, Filter> = {
  'cargo-test':cargoTest, cargo:cargoTest, pytest, 'go-test':goTest, 'go-build':goBuild,
  ctest, tsc, vitest, grep, rg:grep, find, fd:find, 'git-log':gitLog,
  'git-diff':gitDiff, 'git-status':gitStatus, log:logs, mypy,
  'ruff-check':ruffCheck, 'ruff-format':ruffFormat, 'sqlfluff-lint':sqlfluffLint,
  prettier, phpunit, pest:phpTest, paratest:phpTest, 'php-test':phpTest, ecs, phpstan, pint,
};
