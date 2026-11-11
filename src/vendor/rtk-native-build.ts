// SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0 (653efb6ed02bd287d686c50e830dd1009356904f).
// Source mapping and historical-text adaptations: third_party/rtk/NATIVE-BUILD.md.
import {clean, lines, truncate, type Filter} from './rtk-native-common.ts';

const task = /^> Task :/;
const advice = /^\* Try:|^> Run with --|^> Get more help at/;
const buildStatus = /^BUILD (SUCCESSFUL|FAILED)/;
const actionable = /^\d+ actionable tasks?/;
const gradleSummary = /\d+ tests? completed|\d+ tests? failed|There were failing tests|See the report at/;
const framework = /^at (?:org\.junit\.|junit\.|java\.lang\.reflect\.|sun\.reflect\.|org\.gradle\.)/;

function gradleBuild(input: string): string {
  if (!lines(input).some(line => buildStatus.test(line))) return input;
  return lines(input).filter(line => {
    if (task.test(line) || advice.test(line) || /^(Starting a Gradle Daemon|Daemon will be stopped|Reusing configuration cache|Calculating task graph|> Configure project|Deprecated Gradle features|You can use|For more on this|Configuration cache entry)/.test(line) || /^\s*\d+%|^Downloading|^Configuring|^Resolving|^\[Incubating\]|^Wrote HTML report|^class \S+ could not|^\[android-/.test(line)) return false;
    return buildStatus.test(line) || actionable.test(line) || /(^FAILURE:|^\* What went wrong:|^\* Where:|> Could not|e: |error:|^Execution failed|Lint found \d+ error)/i.test(line) || /^(w: |warning:|Warning:|WARNING:)/.test(line) || /gradle\.com\/s\/|Publishing build scan/.test(line) || !line.trim();
  }).join('\n');
}

function gradleTest(input: string): string {
  let failure = false;
  const out: string[] = [];
  for (const line of lines(input)) {
    if (task.test(line) || advice.test(line)) continue;
    if (buildStatus.test(line) || actionable.test(line) || gradleSummary.test(line)) { out.push(line); continue; }
    if (/ PASSED$| SKIPPED$/.test(line)) { failure = false; continue; }
    if (/FAILED$| FAILED /.test(line)) { failure = true; out.push(line); continue; }
    if (failure) {
      const trimmed = line.trim();
      if (/^(java\.|kotlin\.)/.test(trimmed)) out.push(line);
      else if (trimmed.startsWith('at ')) { if (!framework.test(trimmed)) { out.push(line); failure = false; } }
      else if (trimmed) failure = false;
    }
  }
  return out.join('\n').trim() ? out.join('\n') : input;
}

function gradleConnected(input: string): string {
  if (input.includes('No connected devices!')) return 'connectedAndroidTest failed: No connected devices! Start an emulator or connect a device.';
  if (!lines(input).some(line => buildStatus.test(line) || gradleSummary.test(line))) return input;
  const kept = lines(input).filter(line => !/^INSTRUMENTATION_STATUS[_CODE]*:|^INSTRUMENTATION_RESULT:|^INSTRUMENTATION_CODE:|^Starting \d+ tests? on |^Installing APK/.test(line) && !task.test(line) && !advice.test(line)).join('\n');
  return gradleTest(kept) || 'ok ✓ (connected tests passed)';
}

function gradleLint(input: string): string {
  let context = 0;
  const out: string[] = [];
  for (const line of lines(input)) {
    if (task.test(line) || advice.test(line) || /Wrote (HTML|XML|text) report|file:\/\/|\/build\/reports\/lint/.test(line)) { context = 0; continue; }
    const android = /[^:]+:\d+:.*(?:[Ee]rror|[Ww]arning):.*\[/.test(line);
    if (buildStatus.test(line) || actionable.test(line) || /\d+ (issues?|errors?|warnings?)/.test(line) || android || /[^:]+:\d+:\d+:.*(?:[Ll]int|error)/.test(line)) {
      out.push(line); context = android ? 3 : 0; continue;
    }
    if (context) { if (!line.trim()) context = 0; else { out.push(line); context--; } }
  }
  return out.join('\n').trim() ? out.join('\n') : input;
}

function gradleDependencies(input: string): string {
  const configs: {name: string; deps: string[]}[] = [];
  let current: {name: string; deps: string[]} | undefined;
  for (const line of lines(input)) {
    const trimmed = line.trim();
    if (!trimmed || task.test(trimmed) || advice.test(trimmed) || buildStatus.test(trimmed) || actionable.test(trimmed) || /^(Downloading|Download |Starting a Gradle)/.test(trimmed) || ['No dependencies', '(n)'].includes(trimmed)) continue;
    if (!/^[+|\\ ]/.test(trimmed) && trimmed.includes(' - ')) {
      current = {name: trimmed.split(' - ')[0], deps: []}; configs.push(current); continue;
    }
    if (/^(\+---|\\---)/.test(line) && current) current.deps.push(trimmed.replace(/^(?:\+--- |\\--- )/, ''));
  }
  const populated = configs.filter(config => config.deps.length);
  if (!populated.length) return input.includes('BUILD SUCCESSFUL') ? 'ok ✓ no dependencies' : input;
  return `${populated.reduce((sum, config) => sum + config.deps.length, 0)} top-level dependencies across ${populated.length} configurations\n` + populated.map(({name, deps}) => `\n${name} (${deps.length}):\n${deps.slice(0, 20).map(dep => `  ${dep}\n`).join('')}${deps.length > 20 ? `  ... +${deps.length - 20} more\n` : ''}`).join('').trimEnd();
}

type Issue = {file: string; line: number; column: number; code: string; message: string};
type Diagnostics = {errors: Issue[]; warnings: Issue[]};
const sensitive = /\b((?:PATH|HOME|USERPROFILE|USERNAME|USER|APPDATA|LOCALAPPDATA|TEMP|TMP|SSH_AUTH_SOCK|SSH_AGENT_LAUNCHER|GH_TOKEN|GITHUB_TOKEN|GITHUB_PAT|NUGET_API_KEY|NUGET_AUTH_TOKEN|VSS_NUGET_EXTERNAL_FEED_ENDPOINTS|AZURE_DEVOPS_TOKEN|AZURE_CLIENT_SECRET|AZURE_TENANT_ID|AZURE_CLIENT_ID|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PASSWORD|CONNECTION_STRING|DATABASE_URL|DOCKER_CONFIG|KUBECONFIG)\s*(?:=|:)\s*)[^\s;]+/g;
const dotnetText = (input: string) => clean(input.replace(/\r\n/g, '\n')).replace(sensitive, '$1[REDACTED]');
const duration = (text: string) => /^\s*Time Elapsed\s+([^\r\n]+)$/m.exec(text)?.[1]?.trim();
const projects = (text: string) => [...text.matchAll(/^\s*(?:[A-Za-z]:)?[^\r\n]*\.csproj(?:\s|$)/gm)].length;

function diagnostics(text: string, restore = false): Diagnostics {
  const result: Diagnostics = {errors: [], warnings: []};
  const seen = new Set<string>();
  for (const line of lines(text)) {
    const match = restore
      ? /^\s*(?:(.+?)\s+:\s+)?(warning|error)\s+([A-Za-z]{2,}\d{3,})\s*:\s*(.+)$/i.exec(line)
      : /^\s*([^\r\n:(]+)\((\d+),(\d+)\):\s*(error|warning)\s*(?:([A-Za-z]+\d+)\s*:\s*)?(.*)$/.exec(line);
    if (!match) continue;
    const kind = (restore ? match[2] : match[4]).toLowerCase();
    const issue: Issue = restore
      ? {file: match[1]?.trim() ?? '', line: 0, column: 0, code: match[3].trim(), message: match[4].trim()}
      : {file: match[1], line: Number(match[2]), column: Number(match[3]), code: match[5] ?? '', message: match[6].trim() || 'diagnostic without message'};
    const key = kind + JSON.stringify(issue);
    if (!seen.has(key)) { seen.add(key); result[kind === 'error' ? 'errors' : 'warnings'].push(issue); }
  }
  return result;
}

function buildDiagnostics(text: string): Diagnostics | undefined {
  const result = diagnostics(text);
  for (const kind of ['error', 'warning'] as const) {
    const bucket = kind === 'error' ? result.errors : result.warnings;
    if (bucket.length) continue;
    let count = 0;
    for (const match of text.matchAll(new RegExp(`\\b(\\d+)\\s+${kind}\\(s\\)`, 'gi'))) count = Math.max(count, Number(match[1]));
    // Historical logs are untrusted; refuse forged huge counts instead of allocating them.
    if (!Number.isSafeInteger(count) || count > 10_000) return;
    const fallback = lines(text).filter(line => new RegExp(`^.+\\(\\d+,\\d+\\):\\s*${kind}(?:\\s+[A-Za-z]{2,}\\d{3,})?(?:\\s*:.*)?$`, 'i').test(line)).length;
    for (let i = 0; i < (count || fallback); i++) bucket.push({file: '', code: '', line: 0, column: 0, message: `Build ${kind} #${i + 1} (details omitted)`});
  }
  const restore = diagnostics(text, true);
  if (!result.errors.length) result.errors = restore.errors;
  if (!result.warnings.length) result.warnings = restore.warnings;
  return result;
}

function issueSection(issues: Issue[], kind: 'error' | 'warning', cap: number): string {
  if (!issues.length) return '';
  const out = [kind === 'error' ? 'Errors:' : 'Warnings:'];
  for (const issue of issues.slice(0, cap)) {
    const message = truncate(issue.message, 180);
    out.push(!issue.file ? `  ${kind} ${message}` : `  ${issue.file}(${issue.line},${issue.column}) ${kind}${issue.code ? ` ${issue.code}` : ''}: ${message}`);
  }
  if (issues.length > cap) out.push(`  … +${issues.length - cap} more ${kind}s`);
  return out.join('\n') + '\n';
}

function dotnetBuild(input: string): string {
  const text = dotnetText(input);
  if (!/Build (?:succeeded|FAILED)/.test(text)) return input;
  const issues = buildDiagnostics(text);
  if (!issues) return input;
  const succeeded = text.includes('Build succeeded') && !text.includes('Build FAILED');
  return [issueSection(issues.warnings, 'warning', 10), issueSection(issues.errors, 'error', 20), `${succeeded ? 'ok' : 'fail'} dotnet build: ${projects(text) || 1} projects, ${issues.errors.length} errors, ${issues.warnings.length} warnings (${duration(text) ?? 'unknown'})`].filter(Boolean).join('\n');
}

function dotnetTest(input: string): string {
  const text = dotnetText(input);
  let passed = 0, failed = 0, skipped = 0, total = 0, time = duration(text), recognized = false;
  for (const match of text.matchAll(/(?:Passed!|Failed!)\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+),\s*Duration:\s*([^\r\n-]+)/g)) {
    recognized = true; failed += Number(match[1]); passed += Number(match[2]); skipped += Number(match[3]); total += Number(match[4]);
    if (!duration(text)) time = match[5].trim();
  }
  for (const match of text.matchAll(/^\s*Test summary:\s*total:\s*(\d+),\s*failed:\s*(\d+),\s*(?:succeeded|passed):\s*(\d+),\s*skipped:\s*(\d+),\s*duration:\s*([^\r\n]+)$/gmi)) {
    recognized = true; total = Number(match[1]); failed = Number(match[2]); passed = Number(match[3]); skipped = Number(match[4]); time = match[5].trim();
  }
  if (!recognized || ![passed, failed, skipped, total].every(Number.isSafeInteger)) return input;
  const failures: {name: string; details: string[]}[] = [], source = lines(text);
  const failureHead = /^\s*Failed\s+([^\r\n\[]+)\s+\[[^\]\r\n]+\]\s*$/;
  for (let i = 0; i < source.length; i++) {
    const match = failureHead.exec(source[i]);
    if (!match) continue;
    const details: string[] = [];
    for (i++; i < source.length; i++) {
      const line = source[i].trim();
      if (failureHead.test(source[i]) || /^(Failed!  -|Passed!  -|Test summary:|Build )/.test(line)) { i--; break; }
      if (line || details.length) details.push(line);
      if (details.length >= 20) break;
    }
    failures.push({name: match[1].trim(), details});
  }
  failed ||= failures.length;
  if (failed && (!failures.length || failures.length < failed || failures.some(f => !f.details.length))) return input;
  const issues = buildDiagnostics(text);
  if (!issues) return input;
  const failureSection = failures.length ? 'Failed Tests:\n' + failures.slice(0, 10).map(f => `  ${f.name}\n${f.details.map(d => `    ${truncate(d, 320)}\n`).join('')}\n`).join('') + (failures.length > 10 ? `… +${failures.length - 10} more failed tests\n` : '') : '';
  const summary = failed
    ? `fail dotnet test: ${passed} passed, ${failed} failed, ${skipped} skipped, ${issues.warnings.length} warnings in ${projects(text) || 1} projects (${time ?? 'unknown'})`
    : `ok dotnet test: ${passed} tests passed, ${issues.warnings.length} warnings in ${projects(text) || 1} projects (${time ?? 'unknown'})`;
  return [failureSection, issueSection(issues.warnings, 'warning', 10), issueSection(issues.errors, 'error', 10), summary].filter(Boolean).join('\n');
}

function dotnetRestore(input: string): string {
  const text = dotnetText(input), issues = diagnostics(text, true);
  const restored = [...text.matchAll(/^\s*Restored\s+.+\.csproj\s*\(/gm)].length;
  if (!restored && !issues.errors.length && !issues.warnings.length && !text.includes('All projects are up-to-date for restore')) return input;
  return [issueSection(issues.warnings, 'warning', 10), issueSection(issues.errors, 'error', 20), `${issues.errors.length ? 'fail' : 'ok'} dotnet restore: ${restored} projects, ${issues.errors.length} errors, ${issues.warnings.length} warnings (${duration(text) ?? 'unknown'})`].filter(Boolean).join('\n');
}

export const buildFilters: Record<string, Filter> = {
  'gradle-build': gradleBuild, 'gradle-test': gradleTest, 'gradle-connected': gradleConnected,
  'gradle-lint': gradleLint, 'gradle-dependencies': gradleDependencies,
  'dotnet-build': dotnetBuild, 'dotnet-test': dotnetTest, 'dotnet-restore': dotnetRestore,
};

export function matchBuildFilter(argv: string[]): string | undefined {
  const [exe, ...args] = argv;
  if (args.some(arg => ['--help', '-h', '-?', '/?', '--version'].includes(arg))) return;
  if (exe === 'dotnet') return ['build', 'test', 'restore'].includes(args[0]) ? `dotnet-${args[0]}` : undefined;
  if (!['gradle', 'gradlew', 'gradlew.bat'].includes(exe) || args.some(arg => ['--stacktrace', '--info', '--debug', '--full-stacktrace'].includes(arg))) return;
  const selected = args.filter(arg => !arg.startsWith('-') && arg.toLowerCase() !== 'clean').at(-1)?.toLowerCase() ?? '';
  if (selected.includes('connected')) return 'gradle-connected';
  if (selected.includes('test') || selected === 'check') return 'gradle-test';
  if (!selected || /assemble|build|bundle|install/.test(selected)) return 'gradle-build';
  if (/lint|ktlint|detekt/.test(selected)) return 'gradle-lint';
  if (selected.includes('dependencies')) return 'gradle-dependencies';
}
