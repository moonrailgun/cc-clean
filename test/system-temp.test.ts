import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { includesSystemTemp } from '../src/app.ts';
import { scanSystemTemp, systemTempBases, systemTempKind, verifySystemTempParents } from '../src/system-temp.ts';

// Disposable metadata layouts only; no cleanup planners, previews, executors or recovery.
const uid = process.getuid?.() ?? 501;
const uuid = '12345678-1234-1234-1234-123456789abc';
const task = `claude-${uid}/project/tasks/task_1.output`;
const hook = `hook_outputs/${uuid}/${uuid}.txt`;
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-temp-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const put = async (relative: string, data = 'fixture') => {
    const path = join(root, relative);
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    await writeFile(path, data, {mode: 0o600});
    return path;
  };
  return {root, put, scope: {uid, excludedRoots: [] as string[]}};
}

test('system temporary rules recognize exact provider layouts, not generic scratch data', () => {
  for (const [path, kind] of [
    [task, 'task-output'], ['claude/project/tasks/abc.output', 'task-output'],
    ['claude-ab12-cwd', 'cwd-record'], [`claude-${uid}/cwd-ab12cd34`, 'cwd-record'],
  ]) assert.equal(systemTempKind(path, 'claude', uid), kind);
  assert.equal(systemTempKind(hook, 'codex', uid), 'hook-output');
  assert.equal(systemTempKind(hook.toUpperCase().replace('HOOK_OUTPUTS', 'hook_outputs'), 'codex', uid), 'hook-output');
  assert.equal(systemTempKind('codex-app-installer-Ab_12-/Codex.dmg', 'codex', uid), 'installer');
  for (const path of [
    `claude-${uid + 1}/project/tasks/a.output`, `claude-${uid}/project/tasks/a.png`,
    `claude-${uid}/project/${uuid}/scratchpad/a.output`, `claude-${uid}/source.ts`,
    'claude-ab12-cwd/asset.png', 'claude/project/tasks/a.output/child', 'claude/../tasks/a.output',
    `/${task}`, `./${task}`, task.replace('/project/', '//'), task.replace('/project/', '/./'),
    task.replace('/project/', '/bad\n/'), task.replace('/project/', '/bad\\name/'),
    'codex-daemon-501/lock', 'codex-ipc/ipc-501.sock', 'codex-rc-test/source.ts',
    'codex-app-installer-test/source.ts', 'hook_outputs/thread/output.txt',
    `hook_outputs/${uuid}/${uuid}.png`, 'cache/a.tmp',
  ]) for (const provider of ['claude', 'codex'] as const) assert.equal(systemTempKind(path, provider, uid), null, path);
  assert.equal(systemTempKind(task, 'codex', uid), null);
  assert.equal(systemTempKind(hook, 'claude', uid), null);
});

test('system temps join quick and ordinary cleanup, never manual or history-only selection', () => {
  for (const options of [{}, {includeFileCleanup: true, removeImages: true, compactTools: true}])
    assert.equal(includesSystemTemp(options), true);
  for (const options of [
    {manual: true}, {files: ['/inert/file']}, {sessions: [uuid]}, {removeImages: true}, {compactTools: true}, {removeReasoning: true},
    {removeRequestArchives: true}, {compactHooks: true}, {compactToolDefinitions: true}, {compactSkillListings: true}, {removeRequestArchives: true, compactHooks: true},
    {removeImages: true, compactTools: true}, {manual: true, includeFileCleanup: true},
    {files: ['/inert/file'], includeFileCleanup: true},
  ]) assert.equal(includesSystemTemp(options), false);
});

test('selective scans count only known files and preserve assets, excluded roots and links', {skip: !process.getuid}, async t => {
  const {root, put, scope} = await fixture(t);
  const paths = [task, 'claude/project/tasks/legacy.output', 'claude-ab12-cwd', `claude-${uid}/cwd-ab12`, hook, 'codex-app-installer-test/Codex.dmg'];
  for (const path of paths) await put(path, '12345');
  for (const path of [`claude-${uid}/project/${uuid}/scratchpad/image.png`, `claude-${uid}/source.ts`, 'codex-daemon-501/lock', 'codex-app-installer-test/source.ts']) await put(path);
  const excluded = `claude-${uid}/excluded`;
  await put(`${excluded}/tasks/keep.output`);
  scope.excludedRoots.push(join(root, excluded));
  await symlink(join(root, `claude-${uid}/project`), join(root, `claude-${uid}/linked-project`));
  await symlink(join(root, task), join(root, 'task-link'));
  const claude = await scanSystemTemp(root, 'claude', scope), codex = await scanSystemTemp(root, 'codex', scope);
  for (const [inv, expected] of [[claude, paths.slice(0, 4)], [codex, paths.slice(4)]] as const) {
    assert.equal(inv.complete, true); assert.deepEqual(inv.errors, []);
    assert.deepEqual(inv.files.map(f => f.relative).sort(), [...expected].sort());
    assert.equal(inv.totalBytes, expected.length * 5);
    assert.equal(inv.allocatedBytes, inv.files.reduce((n, f) => n + f.allocatedBytes, 0));
    assert.ok(inv.files.every(f => f.uid === uid && f.nlink === 1));
  }
  assert.ok(claude.links.some(l => l.path === join(root, 'task-link') && l.target === join(root, task)));
  assert.ok(claude.links.some(l => l.path.endsWith('/linked-project')));
  assert.equal((await scanSystemTemp(root, 'claude', {uid, excludedRoots: [root]})).files.length, 0);
});

test('shared files, writable parents, symlink parents and mismatched owners are retained', {skip: !process.getuid}, async t => {
  const {root, put, scope} = await fixture(t);
  const file = await put(task);
  await verifySystemTempParents(root, file, 'claude', scope);
  await link(file, join(root, 'hardlink'));
  let inv = await scanSystemTemp(root, 'claude', scope);
  assert.equal(inv.files.length, 0); assert.match(inv.errors.join('\n'), /shared/);
  const writable = await put('claude/project/tasks/writable.output');
  await chmod(writable, 0o666);
  inv = await scanSystemTemp(root, 'claude', scope);
  assert.equal(inv.files.length, 0); assert.match(inv.errors.join('\n'), /unsafe ownership or permissions/);
  await chmod(dirname(file), 0o777);
  await assert.rejects(verifySystemTempParents(root, file, 'claude', scope), /unsafe ownership or permissions/);
  await chmod(dirname(file), 0o700);
  await symlink(join(root, `claude-${uid}/project`), join(root, `claude-${uid}/linked`));
  await assert.rejects(verifySystemTempParents(root, join(root, `claude-${uid}/linked/tasks/task_1.output`), 'claude', scope), /changed/);
  await assert.rejects(verifySystemTempParents(root, file, 'claude', {uid: uid + 1, excludedRoots: []}), /scope/);
  await assert.rejects(verifySystemTempParents(root, file, 'claude', {uid, excludedRoots: [dirname(file)]}), /scope/);
  inv = await scanSystemTemp(root, 'claude', {uid: uid + 1, excludedRoots: []});
  assert.equal(inv.complete, false); assert.equal(inv.files.length, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(scanSystemTemp(root, 'claude', scope, aborted.signal), {name: 'AbortError'});
});

test('temporary bases are canonical and deduplicated, including Claude custom temp locations', async t => {
  const {root} = await fixture(t), alias = join(root, 'alias'), base = join(root, 'base'), custom = join(root, 'custom');
  await mkdir(base); await mkdir(custom); await symlink(base, alias);
  const bases = await systemTempBases('claude', {TMPDIR: alias, CLAUDE_CODE_TMPDIR: custom});
  assert.ok(bases.includes(base) && bases.includes(custom)); assert.ok(!bases.includes(alias));
  assert.equal(new Set(bases).size, bases.length);
  const duplicates = await systemTempBases('claude', {TMPDIR: alias, CLAUDE_CODE_TMPDIR: base});
  assert.equal(duplicates.filter(p => p === base).length, 1);
  assert.ok(!(await systemTempBases('codex', {TMPDIR: alias, CLAUDE_CODE_TMPDIR: custom})).includes(custom));
  await assert.rejects(systemTempBases('claude', {CLAUDE_CODE_TMPDIR: './relative'}), /absolute/);
  await assert.rejects(systemTempBases('codex', {TMPDIR: '/'}), /Filesystem root/);
});
