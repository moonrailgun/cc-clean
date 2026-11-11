// Copyright (c) RTK contributors. SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0, commit 653efb6ed02bd287d686c50e830dd1009356904f.
// Licensed under the Apache License, Version 2.0. See third_party/rtk/LICENSE.
// Source mapping and history-only safety changes: third_party/rtk/NATIVE-MAVEN.md.

type Filter = (input: string) => string;
type Mode = 'test' | 'compile' | 'package' | 'quiet';
const valueOptions = new Set(['b','builder','color','D','define','emp','encrypt-master-password','ep','encrypt-password','f','file','gs','global-settings','gt','global-toolchains','l','log-file','P','activate-profiles','pl','projects','rf','resume-from','s','settings','t','toolchains','T','threads']);

export function matchMavenFilter(argv: string[]): string | undefined {
  const exe = argv[0]?.replaceAll('\\', '/').split('/').at(-1);
  if (!exe || !['mvn','mvnw','mvnd'].includes(exe)) return undefined;
  let options = true, quiet = false, verbose = false, goal: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-')) {
      const name = arg.replace(/^--?/, '').split('=')[0]!;
      if (['X','debug','e','errors'].includes(name)) verbose = true;
      if (['q','quiet'].includes(name)) quiet = true;
      if (valueOptions.has(name) && !arg.includes('=')) {
        if (argv[i + 1] === undefined || argv[i + 1] === '--') return undefined;
        i++;
      }
    } else goal = arg;
  }
  if (verbose || !goal) return undefined;
  const mode = ['test','integration-test'].includes(goal) ? 'test' : ['compile','test-compile'].includes(goal) ? 'compile' : ['package','install','verify','deploy'].includes(goal) ? 'package' : undefined;
  return mode ? `${exe === 'mvnd' ? 'mvnd' : 'mvn'}-${quiet ? 'quiet' : mode}` : undefined;
}

const RUNNING = /^\[INFO\] Running /;
const RUNNING_MODULE = /^\[INFO\] Running \S+\s*$/;
const CLOSE = /^\[(?:INFO|ERROR|WARNING)\] Tests run: \d+, Failures: (\d+), Errors: (\d+), Skipped: \d+, Time elapsed: [^ ]+ s(?:\s+<<<\s*(?:FAILURE|ERROR)!)?\s+--?\s+in (.+)$/;
const FOOT = /^\[(?:INFO|ERROR)\] BUILD (?:SUCCESS|FAILURE)$/;
const RESULTS = /^\[INFO\] Results:\s*$/;
const AGG = /^\[(?:INFO|ERROR)\] Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+\s*$/;
const PLUGIN = /^\[INFO\] --- .* @ .* ---$/;
const TEST_PLUGIN = /^\[INFO\] --- (?:maven-)?(surefire|failsafe)(?:-plugin)?:\S+ \([^)]*\) @ .* ---$/;
const BUILDING_MODULE = /^\[INFO\] Building .*\[\d+\/\d+\]\s*$/;
const MODULE = /^\[INFO\] -+< .+ >-+$/;
const REACTOR = /^\[INFO\] Reactor Summary for /;
const FILE_COORD = /\/[^:]+\.java:\[\d+,\d+\]/;
const frameworks = ['at org.junit.','at junit.','at org.apache.maven.surefire.','at sun.reflect.','at jdk.internal.reflect.','at jdk.proxy','at java.base/','at java.lang.reflect.','at java.util.'];
const framework = (line: string): boolean => frameworks.some(prefix => line.trimStart().startsWith(prefix));
const level = (value: string): boolean => ['INFO','ERROR','WARNING','DEBUG','FATAL'].includes(value);
const blank = (core: string): boolean => core === '' || core.trimEnd() === '[INFO]';
const subtest = (core: string): boolean => core.startsWith('[ERROR] ') && /<<< (?:FAILURE|ERROR)!/.test(core);
const summaryHeader = (core: string): boolean => core.startsWith('[ERROR] Failures:') || core.startsWith('[ERROR] Errors:');
const boilerplate = (core: string): boolean => core.trimEnd() === '[ERROR]' || ['[ERROR] See ','[ERROR] -> [Help','[ERROR] To see the full stack trace','[ERROR] Re-run Maven','[ERROR] For more information','[ERROR] [Help'].some(prefix => core.startsWith(prefix));
const laneOpener = (core: string): boolean => RUNNING_MODULE.test(core) || CLOSE.test(core) || MODULE.test(core) || PLUGIN.test(core) || BUILDING_MODULE.test(core) || core.startsWith('[ERROR]') && FILE_COORD.test(core);
function splitLane(line: string, daemon: boolean): {key?: string; core: string} {
  if (!daemon) return {key: '', core: line};
  const match = line.match(/^\[([^\]]*)\] (.*)$/);
  if (match) {
    if (level(match[1]!)) return {key: '', core: line};
    if (match[1] && /^\[(?:INFO|ERROR|WARNING|DEBUG|FATAL)\](?: |$)/.test(match[2]!)) return {key: match[1], core: match[2]!};
  } else if (/^\[(?:INFO|ERROR|WARNING|DEBUG|FATAL)\]$/.test(line.trimEnd())) return {key: '', core: line};
  return {core: line};
}

// Unlike upstream's catch-all discard, only recognized Maven framing is removed.
function noise(core: string): boolean {
  if (blank(core) || boilerplate(core) || PLUGIN.test(core)) return true;
  return /^\[INFO\] (?:-+(?:\[ (?:pom|jar|war|ear|maven-plugin) \]-+)?\s*|\s*T E S T S\s*|\s*from .+|Reactor Build Order:|\S+\s+\[(?:pom|jar|war|ear|maven-plugin)\]|Processing build on daemon .+|BuildTimeEventSpy is registered\.|Using the SmartBuilder implementation .+|skip non existing resourceDirectory .+|Nothing to compile - all classes are up to date\.|Recompiling the module because of changed (?:source code|dependency)\.|Compiling \d+ source files? with javac .+|No sources to compile|No tests to run\.|Using auto detected provider .+|Deleting .+|Average project wall time: .+|Total concurrency: .+|Bottleneck projects that decrease concurrency: .+|\t- \S+:\S+:\S+|\d+ errors?)$/.test(core);
}
function keepOutside(core: string, gateBuilding: boolean): boolean {
  return !boilerplate(core) && (RESULTS.test(core) || AGG.test(core) || FOOT.test(core) || MODULE.test(core) ||
    ['[INFO] Total time:','[INFO] Finished at:','[INFO] Scanning ','[INFO] Installing ','[INFO] Building war:','[INFO] Building jar:','[INFO] Building ear:'].some(prefix => core.startsWith(prefix)) ||
    core.startsWith('[INFO] Building ') && (!gateBuilding || BUILDING_MODULE.test(core)) || summaryHeader(core) || core.startsWith('[ERROR]') && !core.startsWith('[ERROR] Tests run:'));
}

class Block {
  lines: string[] = [];
  running?: string;
  inBlock = false;
  failureTrail = false;
  dropTrail = false;
  trailRearm?: boolean;

  flush(out: string[]): void {
    if (this.running !== undefined) out.push(this.running);
    out.push(...this.lines);
    this.running = undefined; this.lines = []; this.inBlock = false;
  }
  step(line: string, core: string, keyed: boolean, root: boolean, out: string[]): 'consumed' | 'failed' | 'pass' {
    if (keyed && PLUGIN.test(core)) return 'consumed';
    if (keyed && RUNNING.test(core)) {
      if (this.inBlock) this.flush(out);
      this.lines = []; this.running = line; this.inBlock = true; this.failureTrail = false; this.trailRearm = undefined;
      return 'consumed';
    }
    if (keyed && this.inBlock && summaryHeader(core)) { this.flush(out); return 'pass'; }
    if (this.inBlock) {
      const close = keyed ? core.match(CLOSE) : null;
      if (close) {
        this.inBlock = false;
        if (Number(close[1]) || Number(close[2])) return 'failed';
        // Preserve application output even when its enclosing test passed.
        if (this.lines.some(value => !noise(splitLane(value, true).core))) { this.flush(out); out.push(line); }
        this.lines = []; this.running = undefined;
      } else this.lines.push(line);
      return 'consumed';
    }
    if (this.failureTrail) {
      if (blank(core) && (keyed || root)) {
        if (!this.dropTrail) out.push('');
        this.trailRearm = this.dropTrail; this.failureTrail = false; this.dropTrail = false;
      } else if (!this.dropTrail && !framework(core)) out.push(line);
      return 'consumed';
    }
    if (this.trailRearm !== undefined && !blank(core) && keyed) {
      const dropped = this.trailRearm; this.trailRearm = undefined;
      if (subtest(core)) {
        this.failureTrail = true; this.dropTrail = dropped;
        if (!dropped) out.push(line);
        return 'consumed';
      }
    }
    return 'pass';
  }
  fail(line: string, admit: boolean, out: string[]): void {
    if (admit) {
      if (this.running !== undefined) out.push(this.running);
      out.push(...this.lines.filter(value => !framework(value)), line);
    }
    this.running = undefined; this.lines = []; this.failureTrail = true; this.dropTrail = !admit; this.trailRearm = undefined;
  }
}
class Lane {
  key: string;
  block = new Block();
  continuation = false;
  summary = false;
  dropped = 0;
  constructor(key: string) { this.key = key; }
}
class Lanes {
  all = [new Lane('')];
  hot = 0;
  rawOwner(): number | undefined {
    const armed = this.all.flatMap((lane, i) => lane.continuation ? [i] : []);
    if (armed.length > 1) return undefined;
    for (const kind of ['failureTrail','inBlock'] as const) {
      const owners = this.all.flatMap((lane, i) => lane.block[kind] ? [i] : []);
      if (owners.length) return owners.length === 1 && !armed.length ? owners[0] : undefined;
    }
    return armed[0] ?? this.hot;
  }
  route(key: string | undefined, core: string): {index: number; keyed: boolean} | undefined {
    if (key !== undefined) {
      const index = this.all.findIndex(lane => lane.key === key);
      if (index >= 0) return {index, keyed: true};
      if (laneOpener(core)) {
        if (this.all.length >= 256) return undefined;
        this.all.push(new Lane(key));
        return {index: this.all.length - 1, keyed: true};
      }
    }
    const index = this.rawOwner();
    return index === undefined ? undefined : {index, keyed: false};
  }
}
function inputLines(input: string): string[] {
  const lines = input.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
function render(input: string, lines: string[], out: string[]): string {
  if (lines.length === out.length && lines.every((line, i) => line === out[i])) return input;
  return out.length ? out.join('\n') + '\n' : '';
}

function validResult(core: string): boolean {
  if (!/^\[(?:INFO|ERROR|WARNING)\] Tests run:/.test(core)) return true;
  if (!CLOSE.test(core) && !AGG.test(core)) return false;
  const counts = core.match(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/)!.slice(1).map(Number);
  return counts.every(Number.isSafeInteger) && counts[1]! + counts[2]! + counts[3]! <= counts[0]!;
}

function filter(input: string, mode: Exclude<Mode, 'quiet'>, daemon: boolean): string {
  const lines = inputLines(input);
  const cores = lines.map(line => splitLane(line, daemon).core);
  if (!cores.some(core => FOOT.test(core)) || !cores.every(validResult)) return input;
  const lanes = new Lanes(), out: string[] = [], warnings = new Set<string>();
  let classes = 0, droppedClasses = 0, entries = 0, phase: string | undefined, reactor = false;
  for (const line of lines) {
    const {key, core} = splitLane(line, daemon);
    const route = lanes.route(key, core);
    if (!route) { out.push(line); continue; }
    const {index, keyed} = route, lane = lanes.all[index]!;
    if (mode !== 'compile') {
      const banner = keyed ? core.match(TEST_PLUGIN) : null;
      if (daemon && banner && phase !== banner[1]) { phase = banner[1]; entries = 0; }
      const step = lane.block.step(line, core, keyed, index === 0, out);
      if (lane.block.inBlock) lane.continuation = false;
      if (step === 'consumed') continue;
      if (step === 'failed') {
        const admit = classes < 10;
        if (admit) classes++; else droppedClasses++;
        lane.block.fail(line, admit, out); lanes.hot = index; lane.continuation = false;
        continue;
      }
      if (mode === 'test' && lane.continuation && /^[ \t]/.test(core)) { out.push(line); continue; }
      if (lane.summary && core.startsWith('[ERROR]   ')) {
        if (entries < 10) { out.push(line); entries++; } else lane.dropped++;
        continue;
      }
      if (REACTOR.test(core)) reactor = true;
      if (FOOT.test(core)) reactor = false;
      if (reactor || keepOutside(core, daemon && line !== core)) {
        if (lane.summary && AGG.test(core)) {
          if (lane.dropped) { out.push('', `… +${lane.dropped} more failures`); lane.dropped = 0; }
          lane.summary = false;
        }
        if (summaryHeader(core) && !lane.summary) {
          lane.summary = true;
          if (!daemon) { entries = 0; lane.dropped = 0; }
        }
        out.push(line);
        if (keyed) lane.continuation = core.startsWith('[ERROR]') && !core.startsWith('[ERROR] Tests run:') && !summaryHeader(core) && (index === 0 || FILE_COORD.test(core));
        continue;
      }
    } else {
      if (MODULE.test(core) || FOOT.test(core) || core.startsWith('[INFO] Building ') && (!(daemon && line !== core) || BUILDING_MODULE.test(core)) || ['[INFO] Total time:','[INFO] Finished at:','[INFO] Scanning '].some(prefix => core.startsWith(prefix))) {
        out.push(line); if (keyed) lane.continuation = false; continue;
      }
      if (!boilerplate(core) && core.startsWith('[ERROR]')) {
        out.push(line); if (keyed) lane.continuation = index === 0 || FILE_COORD.test(core); continue;
      }
    }
    if (boilerplate(core)) { if (keyed) lane.continuation = false; continue; }
    if (lane.continuation && /^[ \t]/.test(core)) { out.push(line); continue; }
    if (core.startsWith('[WARNING]') && mode !== 'test') {
      const normalized = core.replace(/^\[WARNING\] /, '').replace(new RegExp(FILE_COORD.source, 'g'), '');
      if (!warnings.has(normalized)) { warnings.add(normalized); out.push(line); }
      if (keyed) lane.continuation = false;
      continue;
    }
    if (!noise(core)) out.push(line);
    if (keyed || index === 0) lane.continuation = false;
  }
  if (mode !== 'compile') {
    for (const lane of lanes.all) if (lane.block.inBlock) lane.block.flush(out);
    for (const lane of lanes.all) if (lane.dropped) out.push('', `… +${lane.dropped} more failures`);
    if (droppedClasses) out.push('', `… +${droppedClasses} more failing test classes`);
  }
  return render(input, lines, out);
}

function quiet(input: string, daemon: boolean): string {
  const lines = inputLines(input), out: string[] = [];
  if (!lines.every(line => validResult(splitLane(line, daemon).core))) return input;
  let trail = false;
  for (const line of lines) {
    const tagged = daemon ? line.match(/^\[([^\]\s]+)\] (.*)$/) : null;
    const core = tagged && !level(tagged[1]!) ? tagged[2]! : line;
    if (CLOSE.test(core)) { out.push(line); trail = /<<< (?:FAILURE|ERROR)!/.test(core); continue; }
    if (subtest(core)) { out.push(line); trail = true; continue; }
    if (trail) {
      if (!core.trim()) { out.push(daemon ? line : ''); trail = false; }
      else if (!framework(core)) out.push(line);
      continue;
    }
    if (!boilerplate(core)) out.push(line);
  }
  return render(input, lines, out);
}

export const mavenFilters: Record<string, Filter> = Object.fromEntries(
  ['mvn','mvnd'].flatMap(exe => (['test','compile','package','quiet'] as const).map(mode => [
    `${exe}-${mode}`, (input: string) => mode === 'quiet' ? quiet(input, exe === 'mvnd') : filter(input, mode, exe === 'mvnd'),
  ])),
);
