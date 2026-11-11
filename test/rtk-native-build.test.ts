import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {buildFilters as filters, matchBuildFilter} from '../src/vendor/rtk-native-build.ts';
const fixture = (name: string) => readFileSync(new URL(`../third_party/rtk/fixtures/${name}`, import.meta.url), 'utf8');

test('Gradle upstream fixtures preserve diagnostics and summaries while removing progress', () => {
  assert.equal(filters['gradle-build'](fixture('gradlew_build_raw.txt')).trim(), 'BUILD SUCCESSFUL in 3s\n28 actionable tasks: 28 up-to-date');
  assert.equal(filters['gradle-test'](fixture('gradlew_test_raw.txt')), '6 tests completed, 0 failed\nBUILD SUCCESSFUL in 18s\n4 actionable tasks: 1 executed, 3 up-to-date');
  const lint = filters['gradle-lint'](fixture('gradlew_lint_raw.txt'));
  assert.match(lint, /MainActivity.kt:45: Error: Format string invalid/);
  assert.match(lint, /String.format/);
  assert.match(lint, /BUILD FAILED/);
  assert.doesNotMatch(lint, /Wrote HTML|> Task|Starting a Gradle/);
  const failed = filters['gradle-test'](fixture('gradlew_test_failed_raw.txt'));
  assert.match(failed, /FAILED/);
  assert.doesNotMatch(failed, /org.junit|org.gradle| PASSED/);
  const connected = filters['gradle-connected'](fixture('gradlew_connected_raw.txt'));
  assert.match(connected, /BUILD SUCCESSFUL/);
  assert.doesNotMatch(connected, /INSTRUMENTATION_STATUS/);
  assert.match(filters['gradle-build'](fixture('gradlew_build_failed_raw.txt')), /BUILD FAILED/);
});

test('Gradle dependencies retain top-level coordinates and count omitted entries', () => {
  const input = 'runtimeClasspath - Runtime classpath\n' + Array.from({length: 22}, (_, i) => `+--- org.example:lib${i}:1.0\n|    \\--- transitive:lib:1.0`).join('\n') + '\nBUILD SUCCESSFUL';
  const output = filters['gradle-dependencies'](input);
  assert.match(output, /^22 top-level dependencies across 1 configurations/);
  assert.match(output, /lib19:1.0/);
  assert.match(output, /\.\.\. \+2 more/);
  assert.doesNotMatch(output, /transitive:lib/);
});

test('.NET text parsers retain upstream fixture errors and failed test details', () => {
  const build = filters['dotnet-build'](fixture('dotnet/build_failed.txt'));
  assert.match(build, /CS1525: Invalid expression term/);
  assert.match(build, /fail dotnet build: 1 projects, 1 errors, 0 warnings \(00:00:00.76\)/);
  assert.equal(build.match(/CS1525/g)?.length, 1);
  const tests = filters['dotnet-test'](fixture('dotnet/test_failed.txt'));
  assert.match(tests, /Failed Tests:/);
  assert.match(tests, /Assert.Equal/);
  assert.match(tests, /fail dotnet test:/);
});

test('.NET success, restore, redaction and malformed-format guards', () => {
  assert.equal(filters['dotnet-test']('Passed! - Failed: 0, Passed: 20, Skipped: 2, Total: 22, Duration: 13 ms - Tests.dll'), 'ok dotnet test: 20 tests passed, 0 warnings in 1 projects (13 ms)');
  assert.equal(filters['dotnet-test']('Test summary: total: 4, failed: 0, succeeded: 4, skipped: 0, duration: 1s'), 'ok dotnet test: 4 tests passed, 0 warnings in 1 projects (1s)');
  assert.match(filters['dotnet-restore']('Determining projects to restore...\nRestored /src/App.csproj (1 sec).'), /ok dotnet restore: 1 projects/);
  assert.doesNotMatch(filters['dotnet-build']('App.cs(1,2): warning CS123: GH_TOKEN=secret\nBuild succeeded.'), /secret/);
  for (const input of ['unknown future format', 'Build FAILED.\n999999999999999999 Error(s)', 'Failed! - Failed: 1, Passed: 0, Skipped: 0, Total: 1, Duration: 1s']) {
    const filter = input.startsWith('Failed!') ? 'dotnet-test' : 'dotnet-build';
    assert.equal(filters[filter](input), input);
  }
});

test('build matchers distinguish tasks and preserve explicit verbose/help requests', () => {
  for (const [args, expected] of [
    [['gradlew', 'clean', ':app:testDebugUnitTest'], 'gradle-test'],
    [['gradle', 'dependencies'], 'gradle-dependencies'], [['gradlew', 'connectedAndroidTest'], 'gradle-connected'],
    [['gradle', 'lintDebug'], 'gradle-lint'], [['dotnet', 'build'], 'dotnet-build'],
    [['gradle', 'build', '--info'], undefined], [['dotnet', 'build', '--help'], undefined],
  ] as const) assert.equal(matchBuildFilter([...args]), expected);
});
