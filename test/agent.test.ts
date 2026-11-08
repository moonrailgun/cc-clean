import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CleanupLog } from '../src/history.ts';

// These CLI smoke tests invoke only help, version, analysis and statistics.
const exec = promisify(execFile), cli = resolve('src/cli.ts');
async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-agent-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { ...process.env, HOME: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') };
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  try { return { ...await exec(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env, timeout: 20000 }), code: 0 }; }
  catch (error) { return error as unknown as { stdout: string; stderr: string; code: number }; }
}
test('JSON discovery and version work without creating state', async t => {
  const env = await fixture(t);
  for (const args of [['--help', '--json'], ['--json'], ['--version', '--json']]) {
    const result = await run(args, env), data = JSON.parse(result.stdout);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(data.schemaVersion, 1); assert.equal(data.status, 'completed');
    assert.equal(data.version, '1.0.0');
    if (!args.includes('--version')) assert.ok(data.commands.some((item: {command: string}) => item.command === 'analyze delete'));
  }
  await assert.rejects(access(join(env.HOME, '.config', 'cc-clean')));
});
test('empty analysis and statistics emit a single JSON object with provider filtering', async t => {
  const env = await fixture(t);
  const analysis = await run(['analyze', '--no-interactive', '--json'], env);
  assert.equal(analysis.code, 0, analysis.stderr);
  const data = JSON.parse(analysis.stdout);
  assert.equal(data.status, 'completed'); assert.equal(data.reports.length, 2);
  assert.ok(data.reports.every((report: {totalBytes: number}) => report.totalBytes === 0));
  const stats = await run(['stats', '--provider', 'claude', '--json'], env);
  assert.equal(stats.code, 0, stats.stderr);
  const totals = JSON.parse(stats.stdout);
  assert.deepEqual(Object.keys(totals.providers), ['claude']);
  assert.equal(totals.providers.claude.savedBytes, 0);
  assert.equal(totals.status, 'completed');
  assert.equal(totals.schemaVersion, 2);
  assert.equal(totals.savedBytes, 0);
  assert.equal(totals.cleanedRecords, 0);
  assert.equal('commonOverheadBytes' in totals, false);
  await assert.rejects(access(join(env.HOME, '.config', 'cc-clean', 'cleanup.jsonl')));
});
test('argument and config failures use structured JSON errors and distinct exit codes', async t => {
  const env = await fixture(t);
  for (const args of [['analyze', '--unknown', '--json'], ['stats', '--provider', 'invalid', '--json']]) {
    const result = await run(args, env), data = JSON.parse(result.stdout);
    assert.equal(result.code, 2); assert.equal(data.status, 'failed');
    assert.equal(data.error.code, 'USAGE_ERROR'); assert.ok(data.error.message.length > 0);
  }
  const path = join(env.HOME, '.config', 'cc-clean', 'config.json');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, '{invalid');
  const result = await run(['stats', '--json'], env), data = JSON.parse(result.stdout);
  assert.equal(result.code, 1); assert.equal(data.error.code, 'OPERATION_FAILED');
  assert.equal(/\p{Script=Han}/u.test(data.error.message), false);
});
test('statistics read the JSONL in .config/cc-clean and filter measured totals by provider', async t => {
  const env = await fixture(t), path = join(env.HOME, '.config', 'cc-clean', 'cleanup.jsonl');
  const logs: CleanupLog[] = (['claude', 'codex'] as const).map((provider, i) => ({
    schemaVersion: 1, operationId: randomUUID(), provider, root: join(env.HOME, provider), source: 'clean',
    startedAt: '2026-11-08T00:00:00.000Z', finishedAt: '2026-11-08T00:01:00.000Z', status: 'completed',
    beforeBytes: 100, afterBytes: 90 - i * 10, savedBytes: 10 + i * 10, cleanedRecords: 1 + i,
    cleanupTypes: [{type: 'delete-sessions', cleanedRecords: 1 + i}], needsReview: false,
  }));
  const content = logs.map(log => JSON.stringify(log) + '\n').join('');
  await mkdir(dirname(path), {recursive: true}); await writeFile(path, content);
  for (const provider of ['all', 'claude', 'codex']) {
    const result = await run(['stats', '--provider', provider, '--json'], env);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    const stats = JSON.parse(result.stdout), selected = logs.filter(log => provider === 'all' || log.provider === provider);
    assert.equal(stats.schemaVersion, 2);
    assert.deepEqual(Object.keys(stats.providers), selected.map(log => log.provider));
    assert.equal(stats.savedBytes, selected.reduce((sum, log) => sum + log.savedBytes!, 0));
    assert.equal(stats.cleanedRecords, selected.reduce((sum, log) => sum + log.cleanedRecords, 0));
    for (const log of selected) assert.deepEqual(stats.providers[log.provider].operations, [log]);
  }
  const human = await run(['stats', '--provider', 'codex', '--no-interactive'], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /20 B\s+Space saved/);
  assert.match(human.stdout, /Started:\s+2026-11-08T00:00:00.000Z/);
  assert.match(human.stdout, /100 B\s+Directory before/);
  assert.match(human.stdout, /80 B\s+Directory after/);
  assert.match(human.stdout, /delete-sessions: 2/);
  assert.doesNotMatch(human.stdout, /Claude Code · completed|Application overhead|Net savings/);
  assert.equal(await readFile(path, 'utf8'), content, 'statistics must not change cleanup history');
});
test('noninteractive human output and JSON preserve Unicode paths without touching transcripts', async t => {
  const env = await fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  const project = join(env.HOME, '项目 with spaces');
  await mkdir(project);
  const path = join(env.CLAUDE_CONFIG_DIR, 'projects', '-synthetic', id + '.jsonl');
  const content = JSON.stringify({ type: 'user', sessionId: id, cwd: project, version: '2.1.319', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'Synthetic Unicode data: 你好' } }) + '\n';
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
  const result = await run(['analyze', '--provider', 'claude', '--view', 'sessions', '--project', project, '--json'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reports[0].sessions[0].project, project);
  const deep = await run(['analyze', '--provider', 'claude', '--view', 'usage', '--json'], env);
  assert.equal(deep.code, 0, deep.stderr);
  assert.equal(deep.stderr, '');
  assert.equal(JSON.parse(deep.stdout).reports[0].usage.parsedFiles, 1);
  const human = await run(['analyze', '--provider', 'claude', '--no-interactive'], env);
  assert.equal(human.code, 0, human.stderr); assert.match(human.stdout, /Total .*files/);
  const details = await run(['analyze', '--provider', 'claude', '--view', 'opportunities', '--no-interactive'], env);
  assert.equal(details.code, 0, details.stderr); assert.match(details.stdout, /Field sizes/);
  assert.doesNotMatch(details.stdout, /Fold\/Expand|Enter Open|Q\/Esc/);
  assert.equal(await readFile(path, 'utf8'), content);
});
