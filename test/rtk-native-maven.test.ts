// Copyright (c) RTK contributors. SPDX-License-Identifier: Apache-2.0
// Synthetic and upstream-fixture tests for the port documented in NATIVE-MAVEN.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mavenFilters, matchMavenFilter } from '../src/vendor/rtk-native-maven.ts';

const run = (name: string, input: string): string => mavenFilters[name]!(input);
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/rtk-maven/${name}`, import.meta.url), 'utf8');
const close = (name: string, failures = 0, errors = 0): string => `[${failures || errors ? 'ERROR' : 'INFO'}] Tests run: ${Math.max(1,failures+errors)}, Failures: ${failures}, Errors: ${errors}, Skipped: 0, Time elapsed: 0.01 s${failures || errors ? ' <<< FAILURE!' : ''} -- in ${name}`;

test('Maven registry exposes all four modes for mvn and mvnd', () => {
  assert.deepEqual(Object.keys(mavenFilters).sort(), ['mvn-compile','mvn-package','mvn-quiet','mvn-test','mvnd-compile','mvnd-package','mvnd-quiet','mvnd-test']);
});

test('Maven grammar consumes value options and uses the final lifecycle goal', () => {
  for (const args of [['test','-f','pom.xml'],['-pl','core','test'],['-DskipTests','test'],['-D','skipTests=true','test'],['-T1C','test'],['--define','foo=bar','test'],['test','--settings=settings.xml'],['-ep','secret','test'],['-emp','secret','test'],['--','test']]) assert.equal(matchMavenFilter(['mvn', ...args]), 'mvn-test', args.join(' '));
  for (const phase of ['compile','test-compile']) assert.equal(matchMavenFilter(['mvnw', phase]), 'mvn-compile');
  for (const phase of ['package','install','verify','deploy']) assert.equal(matchMavenFilter(['mvnd', 'clean', '-P', 'prod', phase]), 'mvnd-package');
  assert.equal(matchMavenFilter(['mvn','integration-test']), 'mvn-test');
  for (const args of [[],['clean'],['site'],['site-deploy'],['help:effective-pom'],['-D','test'],['test','--','-q'],['test','--','-f','pom.xml'],['test','-f']]) assert.equal(matchMavenFilter(['mvn', ...args]), undefined, args.join(' '));
});

test('Maven verbose flags bypass filters and quiet routing is phase aware', () => {
  for (const flag of ['-X','--debug','-debug','-e','--errors','-errors']) assert.equal(matchMavenFilter(['mvn','test',flag]), undefined);
  for (const flag of ['-q','--quiet','-quiet']) assert.equal(matchMavenFilter(['mvnd',flag,'verify']), 'mvnd-quiet');
  assert.equal(matchMavenFilter(['mvn','-am','-amd','-ntp','install']), 'mvn-package');
  assert.equal(matchMavenFilter(['mvn','-q','clean']), undefined);
  assert.equal(matchMavenFilter(['java','test']), undefined);
});

test('Maven public encryption options consume their values', () => {
  for (const flag of ['--encrypt-' + 'pass' + 'word', '--encrypt-master-' + 'pass' + 'word']) {
    assert.equal(matchMavenFilter(['mvn','test',flag,'synthetic-value']), 'mvn-test');
    assert.equal(matchMavenFilter(['mvn',flag,'test']), undefined);
  }
});

test('unrecognized, localized and truncated Maven output remains exact', () => {
  for (const name of Object.keys(mavenFilters)) for (const input of ['unknown diagnostic\r\n', '{"error":"unknown"}\n', '[INFO] SUCCÈS DE LA CONSTRUCTION\n', '[INFO] Running a.Test\ntruncated output', '']) assert.equal(run(name,input),input,name);
});

test('Maven malformed result counters and unrecognized footer framing preserve input', () => {
  const cases = [
    `[INFO] Running a.Test\n${close('a.Test')}\napplication says BUILD SUCCESS\n`,
    '[INFO] Running a.Test\n[INFO] Tests run: 1, Failures: 2, Errors: 0, Skipped: 0, Time elapsed: 0.01 s -- in a.Test\n[INFO] BUILD FAILURE\n',
    '[INFO] Running a.Test\n[INFO] Tests run: broken\n[INFO] BUILD SUCCESS\n',
    '[INFO] Running a.Test\n[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 9, Time elapsed: 0.01 s -- in a.Test\n[INFO] BUILD SUCCESS\n',
  ];
  for (const input of cases) for (const mode of ['test','compile','package']) assert.equal(run(`mvn-${mode}`,input),input);
});

test('Surefire removes green blocks but keeps summary and timing', () => {
  const input = `[INFO] --- surefire:3.5.5:test (default-test) @ app ---\n[INFO] Running a.Test\n${close('a.Test')}\n[INFO] Results:\n[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n[INFO] Total time: 1 s\n`;
  assert.equal(run('mvn-test',input),'[INFO] Results:\n[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n[INFO] Total time: 1 s\n');
});

test('Surefire retains error-only failures, assertions and application frames', () => {
  const input = `[INFO] Running a.Test\n${close('a.Test',0,1)}\n[ERROR] a.Test.bad -- Time elapsed: 0.1 s <<< ERROR!\njava.lang.IllegalStateException: broken\n\tat a.Test.bad(Test.java:9)\n\tat org.junit.Runner.run(Runner.java:3)\n\tat java.base/java.lang.reflect.Method.invoke(Method.java:2)\n\n[ERROR] Failures:\n[ERROR]   a.Test.bad:9 broken\n[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0\n[INFO] BUILD FAILURE\n[ERROR] See /tmp/reports for details\n[ERROR] After correcting the problems, resume with\n[ERROR]   mvn test -rf :app\n`;
  assert.equal(run('mvn-test',input), input.replace('\tat org.junit.Runner.run(Runner.java:3)\n','').replace('\tat java.base/java.lang.reflect.Method.invoke(Method.java:2)\n','').replace('[ERROR] See /tmp/reports for details\n',''));
});

test('Surefire rearms failure trails for a second blank-separated failing method', () => {
  const input = `[INFO] Running a.Test\n${close('a.Test',2)}\n[ERROR] a.Test.first <<< FAILURE!\nfirst assertion\n\tat org.junit.Runner.run(Runner.java:1)\n\n[ERROR] a.Test.second <<< FAILURE!\nsecond assertion\n\tat a.Test.second(Test.java:2)\n\tat org.junit.Runner.run(Runner.java:1)\n\n[INFO] BUILD FAILURE\n`;
  assert.equal(run('mvn-test',input),input.replaceAll('\tat org.junit.Runner.run(Runner.java:1)\n',''));
});

test('compile deduplicates warning coordinates and preserves diagnostic continuations', () => {
  const input = '[INFO] --- compiler:3.15.0:compile (compile) @ app ---\n[WARNING] /src/A.java:[1,2] deprecated API\n[WARNING] /src/B.java:[3,4] deprecated API\n[ERROR] /src/A.java:[8,9] cannot find symbol\n  symbol: class Missing\n  location: class A\n[INFO] BUILD FAILURE\n';
  assert.equal(run('mvn-compile',input),'[WARNING] /src/A.java:[1,2] deprecated API\n[ERROR] /src/A.java:[8,9] cannot find symbol\n  symbol: class Missing\n  location: class A\n[INFO] BUILD FAILURE\n');
});

test('unknown diagnostics remain present outside and inside passing blocks', () => {
  const input = `[INFO] Running a.Test\nWARNING: custom agent lost diagnostics\n${close('a.Test')}\n[INFO] custom build plugin diagnostic\n[INFO] BUILD SUCCESS\n`;
  for (const mode of ['test','compile','package']) {
    const output=run(`mvn-${mode}`,input);
    assert.ok(output.includes('WARNING: custom agent lost diagnostics'));
    assert.ok(output.includes('[INFO] custom build plugin diagnostic'));
  }
});

test('mvnd raw continuation ownership survives unrelated module progress', () => {
  const input = '[a] [ERROR] /src/A.java:[1,1] cannot find symbol\n[b] [INFO] --- compiler:3.1:compile (compile) @ b ---\n  symbol: class Missing\n  location: class A\n[INFO] BUILD FAILURE\n';
  for (const mode of ['test','compile','package']) assert.equal(run(`mvnd-${mode}`,input),'[a] [ERROR] /src/A.java:[1,1] cannot find symbol\n  symbol: class Missing\n  location: class A\n[INFO] BUILD FAILURE\n');
});

test('mvnd keeps ambiguous raw output when multiple blocks are open', () => {
  const input = `[a] [INFO] Running a.Test\n[b] [INFO] Running b.Test\nunknown interleaved diagnostic\n[a] ${close('a.Test')}\n[b] ${close('b.Test')}\n[INFO] BUILD SUCCESS\n`;
  assert.equal(run('mvnd-test',input),'unknown interleaved diagnostic\n[INFO] BUILD SUCCESS\n');
});

test('failing classes and summary entries use independent ten-item caps', () => {
  const blocks=Array.from({length:12},(_,i)=>`[INFO] Running a.Test${i}\n${close(`a.Test${i}`,1)}\nassertion ${i}\n\n`).join('');
  const entries=Array.from({length:12},(_,i)=>`[ERROR]   a.Test${i}: bad\n`).join('');
  const output=run('mvn-test',`${blocks}[ERROR] Failures:\n${entries}[ERROR] Tests run: 12, Failures: 12, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE\n`);
  assert.equal((output.match(/\[INFO\] Running/g)??[]).length,10);
  assert.equal((output.match(/\[ERROR\]   a.Test/g)??[]).length,10);
  assert.ok(output.includes('… +2 more failures\n'));
  assert.ok(output.endsWith('… +2 more failing test classes\n'));
  assert.ok(!output.includes('assertion 11'));
});

test('quiet mode removes framework frames and help while retaining unfamiliar output', () => {
  const input=`${close('a.Test',1)}\n[ERROR] a.Test.bad <<< FAILURE!\nexpected one\n\tat a.Test.bad(Test.java:1)\n\tat org.junit.Runner.run(Runner.java:1)\n\n[ERROR] See /tmp/reports\n[ERROR] custom diagnostic\n`;
  assert.equal(run('mvn-quiet',input),input.replace('\tat org.junit.Runner.run(Runner.java:1)\n','').replace('[ERROR] See /tmp/reports\n',''));
});

test('mvnd summary budget spans modules and versions, resets only on phase family', () => {
  const entries = (tag: string, prefix: string, count: number): string => Array.from({length:count},(_,i)=>`[${tag}] [ERROR]   ${prefix}${i}: failure\n`).join('');
  for (const [surefire,failsafe] of [['surefire','failsafe'],['maven-surefire-plugin','maven-failsafe-plugin']]) {
    const input = `[a] [INFO] --- ${surefire}:3.5.5:test (default-test) @ a ---\n[a] [ERROR] Failures:\n${entries('a','First',9)}[a] [ERROR] Tests run: 9, Failures: 9, Errors: 0, Skipped: 0\n[b] [INFO] --- ${surefire}:2.22.2:test (other-test) @ b ---\n[b] [ERROR] Failures:\n${entries('b','Second',3)}[b] [ERROR] Tests run: 3, Failures: 3, Errors: 0, Skipped: 0\n[c] [INFO] --- ${failsafe}:3.5.5:integration-test (default-integration-test) @ c ---\n[c] [ERROR] Failures:\n${entries('c','Integration',2)}[c] [ERROR] Tests run: 2, Failures: 2, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE\n`;
    const expected = `[a] [ERROR] Failures:\n${entries('a','First',9)}[a] [ERROR] Tests run: 9, Failures: 9, Errors: 0, Skipped: 0\n[b] [ERROR] Failures:\n[b] [ERROR]   Second0: failure\n\n… +2 more failures\n[b] [ERROR] Tests run: 3, Failures: 3, Errors: 0, Skipped: 0\n[c] [ERROR] Failures:\n${entries('c','Integration',2)}[c] [ERROR] Tests run: 2, Failures: 2, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE\n`;
    for (const mode of ['test','package']) assert.equal(run(`mvnd-${mode}`,input),expected);
  }
});

test('mvnd preserves ambiguous compiler continuations without adopting application tags', () => {
  const input = '[a] [ERROR] /src/A.java:[1,1] missing A\n[b] [ERROR] /src/B.java:[1,1] missing B\n[Server] [ERROR] connection refused\n  symbol: ambiguous class\n[INFO] BUILD FAILURE\n';
  for (const mode of ['test','compile','package']) assert.equal(run(`mvnd-${mode}`,input),input);
});

test('mvnd bracket-leading app diagnostics retain their order in failed and passing blocks', () => {
  for (const fail of [0,1]) {
    const input = `[a] [INFO] Running a.Test\n[Server] [ERROR] connection refused\n[1, 2] != [1, 3]\n[] [INFO] started\n[a] ${close('a.Test',fail)}\n[INFO] BUILD ${fail ? 'FAILURE' : 'SUCCESS'}\n`;
    for (const mode of ['test','package']) assert.equal(run(`mvnd-${mode}`,input),input);
  }
});

test('mvnd raw blanks do not terminate tagged trails; keyed blanks rearm them', () => {
  const input = `[a] [INFO] Running a.Test\n[a] ${close('a.Test',2)}\n[a] [ERROR] a.Test.first <<< FAILURE!\nassertion one\n\n\tat org.junit.Runner.run(Runner.java:1)\n[a] [INFO]\n[a] [ERROR] a.Test.second <<< FAILURE!\nassertion two\n\tat org.junit.Runner.run(Runner.java:1)\n[a] [INFO]\n[INFO] BUILD FAILURE\n`;
  assert.equal(run('mvnd-test',input),input.replaceAll('\tat org.junit.Runner.run(Runner.java:1)\n','').replaceAll('[a] [INFO]\n','\n'));
});

test('Surefire preserves unfinished blocks and reports pending dropped summary entries at EOF', () => {
  const incomplete = '[INFO] BUILD FAILURE\n[INFO] Running unfinished.Test\nunknown incomplete assertion\n';
  assert.equal(run('mvn-test',incomplete),incomplete);
  const entries = Array.from({length:12},(_,i)=>`[ERROR]   a.Test${i}: failure\n`);
  const input = `[INFO] BUILD FAILURE\n[ERROR] Failures:\n${entries.join('')}`;
  assert.equal(run('mvn-test',input),`[INFO] BUILD FAILURE\n[ERROR] Failures:\n${entries.slice(0,10).join('')}\n… +2 more failures\n`);
});

test('mvnd caps lane allocation and preserves overflowing module diagnostics', () => {
  const blocks = Array.from({length:260},(_,i)=>`[module${i}] [INFO] Running app.Test${i}\n[module${i}] ${close(`app.Test${i}`)}\n`).join('');
  const overflow = `[overflow] [INFO] Running app.OverflowTest\n[overflow] ${close('app.OverflowTest',1)}\n[INFO] BUILD FAILURE\n`;
  const output = run('mvnd-test',blocks + overflow);
  assert.ok(output.endsWith(overflow));
  assert.ok(!output.includes('app.Test0\n'));
  assert.ok(output.includes('app.Test259\n'));
});

test('legacy Surefire closes and warning-level skipped classes collapse', () => {
  const input = `[INFO] Running app.OldTest\n${close('app.OldTest').replace(' -- in ',' - in ')}\n[INFO] Running app.SkipTest\n[WARNING] Tests run: 1, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 0.01 s -- in app.SkipTest\n[INFO] BUILD SUCCESS\n`;
  assert.equal(run('mvn-test',input),'[INFO] BUILD SUCCESS\n');
});

test('mvnd quiet mode preserves tags while pruning framework and help', () => {
  const input = `[a] ${close('a.Test',1)}\n[a] [ERROR] a.Test.bad <<< FAILURE!\n[a] assertion one\n[a] \tat app.Test.bad(Test.java:1)\n[a] \tat org.junit.Runner.run(Runner.java:1)\n[a] \n[a] [ERROR] See /tmp/reports\n[a] unknown diagnostic\n`;
  assert.equal(run('mvnd-quiet',input),input.replace('[a] \tat org.junit.Runner.run(Runner.java:1)\n','').replace('[a] [ERROR] See /tmp/reports\n',''));
});

for (const [name,filter] of [['mvnd_reactor_pass','mvnd-package'],['mvnd_test_fail','mvnd-test'],['mvnd_reactor_fail','mvnd-test'],['mvnd_compile_error','mvnd-compile']]) {
  test(`upstream full ${name} fixture matches expected output`,()=>assert.equal(run(filter!,fixture(`${name}_raw.txt`)),fixture(`${name}_expected.txt`)));
}

test('upstream Maven success slice retains aggregate results and timing exactly', () => {
  assert.equal(run('mvn-test',fixture('mvn_test_pass_slice_raw.txt')), '[INFO] Scanning for projects...\n[INFO] ----------------------< commons-cli:commons-cli >-----------------------\n[INFO] Building Apache Commons CLI 1.11.1-SNAPSHOT\n[INFO] Results:\n[INFO] Tests run: 977, Failures: 0, Errors: 0, Skipped: 61\n[INFO] BUILD SUCCESS\n[INFO] Total time:  01:14 min\n[INFO] Finished at: 2026-05-21T14:54:30Z\n');
});

test('upstream Maven compilation slice keeps warnings, coordinates and symbol details exactly', () => {
  assert.equal(run('mvn-compile',fixture('mvn_compile_error_slice_raw.txt')), '[INFO] Scanning for projects...\n[INFO] ----------------------< commons-cli:commons-cli >-----------------------\n[INFO] Building Apache Commons CLI 1.11.1-SNAPSHOT\n[WARNING] COMPILATION WARNING :\n[WARNING] source value 8 is obsolete and will be removed in a future release\n[WARNING] target value 8 is obsolete and will be removed in a future release\n[WARNING] To suppress warnings about obsolete options, use -Xlint:-options.\n[INFO] 3 warnings\n[ERROR] COMPILATION ERROR :\n[ERROR] src/main/java/org/apache/commons/cli/CompileBreaker.java:[21,16] cannot find symbol\n  symbol:   variable bar\n  location: class org.apache.commons.cli.CompileBreaker\n[INFO] BUILD FAILURE\n[INFO] Total time:  30.631 s\n[INFO] Finished at: 2026-05-21T14:59:46Z\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile (default-compile) on project commons-cli: Compilation failure\n');
});
