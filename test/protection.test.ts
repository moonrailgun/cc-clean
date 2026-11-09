import test from 'node:test';
import assert from 'node:assert/strict';
import { ageProtectionReason, protectRecentContent, protectActiveContent, singleSelectedTarget, type Action, type Plan } from '../src/clean.ts';

import { cleanupExecutionOrder, includesSystemTemp } from '../src/app.ts';
import type { SessionTempEvidence } from '../src/session-temp.ts';

// In-memory metadata only: never invoke cleanup planning, estimation or execution.
const now = Date.parse('2026-11-09T12:00:00Z'), cutoff = now - 72 * 3600000;
const session = '12345678-1234-1234-1234-123456789abc';
function action(kind: Action['kind'] = 'delete-files', mtimeMs = now, path = '/inert/file'): Action {
  return { id: path, kind, targetId: path, status: 'planned', recoveryState: 'prepared',
    beforeBytes: 100, afterBytes: 100, estimatedSavingsBytes: 50,
    files: [{path, relative: path.slice('/inert/'.length), size: 100, allocatedBytes: 4096,
      mtimeMs, ctimeMs: now, dev: 1, ino: 1, nlink: 1, mode: 0o100600, category: 'sessions'}] };
}
function plan(actions: Action[], explicitTarget?: string): Plan {
  return {schemaVersion: 1, operationId: 'inert', provider: 'codex', root: '/inert', version: 'unknown',
    source: 'clean', startedAt: new Date(now).toISOString(), scanComplete: true, warnings: [], actions, explicitTarget};
}

test('every destructive kind uses a strict 72-hour modification cutoff', () => {
  for (const kind of ['delete-files', 'codex-delete', 'slim-history', 'deduplicate-history'] as const) {
    assert.equal(ageProtectionReason(action(kind, cutoff - 1), undefined, now), null);
    for (const modified of [cutoff, cutoff + 1, now, now + 1, NaN, Infinity, -Infinity])
      assert.match(ageProtectionReason(action(kind, modified), undefined, now)!, /72-hour protection.*\/inert\/file/);
    for (const clock of [NaN, Infinity, -Infinity])
      assert.ok(ageProtectionReason(action(kind, cutoff - 1), undefined, clock));
  }
  assert.equal(ageProtectionReason(action('compress-png'), undefined, now), null);
});

test('an age exception comes only from one unique explicit selection', () => {
  assert.equal(singleSelectedTarget({}), undefined);
  assert.equal(singleSelectedTarget({filePaths: [], sessionIds: []}), undefined);
  assert.equal(singleSelectedTarget({filePaths: ['/inert/file']}), '/inert/file');
  assert.equal(singleSelectedTarget({sessionIds: [session, session]}), session);
  for (const options of [
    {filePaths: ['/inert/file', '/inert/other']}, {sessionIds: [session, 'another-session']},
    {filePaths: ['/inert/file'], sessionIds: [session]},
  ]) assert.equal(singleSelectedTarget(options), undefined);
});

test('single-file exceptions match only that file and do not waive group protection', () => {
  for (const kind of ['delete-files', 'slim-history'] as const) {
    const a = action(kind);
    assert.equal(ageProtectionReason(a, '/inert/file', now), null);
    assert.ok(ageProtectionReason(a, '/inert/other', now));
    a.files.push(...action(kind, cutoff - 1, '/inert/other').files);
    assert.ok(ageProtectionReason(a, '/inert/file', now));
  }
});

test('a standalone session can own several files but descendants disable its exception', () => {
  for (const kind of ['delete-files', 'codex-delete'] as const) {
    const a = action(kind);
    a.targetId = session; a.sessionIds = [session];
    a.files.push(...action(kind, now, '/inert/tool-output').files);
    assert.equal(ageProtectionReason(a, session, now), null);
    assert.ok(ageProtectionReason(a, 'different-session', now));
    a.sessionIds.push('child-session');
    assert.ok(ageProtectionReason(a, session, now));
    a.files.forEach(f => { f.mtimeMs = cutoff - 1; });
    assert.equal(ageProtectionReason(a, session, now), null);
    a.files[1].mtimeMs = now;
    assert.ok(ageProtectionReason(a, session, now));
  }
});

test('bulk selection never gains an exception when only one action remains', () => {
  for (const selected of [{}, {filePaths: ['/inert/file', '/inert/unsupported']}]) {
    const p = protectRecentContent(plan([action()], singleSelectedTarget(selected)), now);
    assert.equal(p.actions.length, 0);
    assert.equal(p.warnings.length, 1);
  }
  assert.equal(protectRecentContent(plan([action()], '/inert/file'), now).actions.length, 1);
});

test('protected actions are excluded from savings while old and lossless actions remain', () => {
  const old = action('delete-files', cutoff - 1, '/inert/old');
  const png = action('compress-png', now, '/inert/image.png');
  const p = plan([action(), old, png]); p.warnings.push('Existing warning');
  protectRecentContent(p, now);
  assert.deepEqual(p.actions, [old, png]);
  assert.equal(p.actions.reduce((sum, a) => sum + (a.estimatedSavingsBytes ?? 0), 0), 100);
  assert.equal(p.warnings[0], 'Existing warning');
  assert.match(p.warnings[1], /Entire operation retained/);
});

test('the execution guard can recheck eligibility after a clock or metadata change', () => {
  const a = action('slim-history', cutoff - 1);
  assert.equal(ageProtectionReason(a, undefined, now), null);
  assert.ok(ageProtectionReason(a, undefined, now - 1));
  a.files[0].mtimeMs = now;
  assert.ok(ageProtectionReason(a, undefined, now));
});

test('reasoning removal shares bulk age protection and excludes protected savings', () => {
  const actions = [cutoff - 1, cutoff, now, now + 1, NaN].map((mtime, i) => ({
    ...action('slim-history', mtime, `/inert/${i}.jsonl`),
    slimOptions: {removeImages: false, compactTools: false, removeReasoning: true},
    slimCounts: {images: 0, toolOutputs: 0, reasoning: 1},
    slimSavingsBytes: {images: 0, toolOutputs: 0, reasoning: 50},
  }));
  const p = protectRecentContent(plan(actions), now);
  assert.deepEqual(p.actions, [actions[0]]);
  assert.equal(p.actions.reduce((sum, a) => sum + (a.slimSavingsBytes?.reasoning ?? 0), 0), 50);
  assert.equal(p.warnings.length, 4);
});

test('external system temps retain strict bulk age protection even for one or an explicit target', () => {
  for (const modified of [cutoff, now, now + 1, NaN]) {
    const p = plan([action('delete-files', modified)], '/inert/file');
    p.systemTemp = {uid: 501, excludedRoots: []};
    protectRecentContent(p, now);
    assert.equal(p.actions.length, 0);
    assert.match(p.warnings.join('\n'), /72-hour protection/);
  }
  const p = plan([action('delete-files', cutoff - 1)]);
  p.systemTemp = {uid: 501, excludedRoots: []};
  assert.equal(protectRecentContent(p, now).actions.length, 1);
});


test('activity protection excludes all estimates and cannot be bypassed by a single target or lossless operation', async () => {
  for (const kind of ['delete-files', 'codex-delete', 'slim-history', 'compress-png'] as const) {
    const p = plan([action(kind, cutoff - 1)], '/inert/file');
    p.warnings.push('Existing warning');
    await protectActiveContent(p, async () => 'Client still owns an idle session');
    assert.deepEqual(p.actions, []);
    assert.deepEqual(p.warnings, ['Existing warning', 'Activity protection: Client still owns an idle session']);
  }
});


test('activity inspection failure retains content while a closed client preserves eligible operations', async () => {
  const p = plan([action('slim-history', cutoff - 1)]), original = [...p.actions];
  await protectActiveContent(p, async () => null);
  assert.deepEqual(p.actions, original);
  await protectActiveContent(p, async () => { throw new Error('Inspection unavailable'); });
  assert.deepEqual(p.actions, []);
  assert.match(p.warnings.join('\n'), /Cannot reliably check client activity/);
});


test('activity filtering supplies only candidate paths for external temporary files', async () => {
  const p = plan([action('delete-files', cutoff - 1)]);
  p.systemTemp = {uid: 501, excludedRoots: []};
  await protectActiveContent(p, async (provider, root, files) => {
    assert.equal(provider, 'codex'); assert.equal(root, '/inert');
    assert.deepEqual(files, ['/inert/file']);
    return null;
  });
  assert.equal(p.actions.length, 1);
});


test('ordinary Codex activity retains the provider directory inspection', async () => {
  const p = plan([action('slim-history', cutoff - 1)]);
  await protectActiveContent(p, async (provider, root, files) => {
    assert.equal(provider, 'codex'); assert.equal(root, p.root);
    assert.equal(files, undefined);
    return 'Index has an open writer';
  });
  assert.deepEqual(p.actions, []);
  assert.match(p.warnings.join('\n'), /Index has an open writer/);
});

const sessionTemp: SessionTempEvidence = {path: '/inert', kind: 'directory', callId: 'exec-1', startedAt: 1, completedAt: 1,
  roots: {claude: '/claude', codex: '/codex'}, source: '/codex/sessions/s1.jsonl', sessionId: 's1', fingerprint: 'a'.repeat(64), dev: 1, ino: 1, birthtimeMs: 1};


test('session temporary files require strict age and both providers closed', async () => {
  for (const mtime of [cutoff - 1, cutoff, now, now + 1, NaN]) {
    const p = plan([action('delete-files', mtime)], '/inert/file');
    p.systemTemp = {uid: 501, excludedRoots: [], session: sessionTemp};
    protectRecentContent(p, now);
    assert.equal(p.actions.length, mtime < cutoff ? 1 : 0);
  }
  for (const active of ['claude', 'codex', null]) {
    const p = plan([action('delete-files', cutoff - 1)]), seen: string[] = [];
    p.systemTemp = {uid: 501, excludedRoots: [], session: sessionTemp};
    await protectActiveContent(p, async (provider, root, paths) => {
      seen.push(provider); assert.equal(root, sessionTemp.roots[provider]); assert.deepEqual(paths, ['/inert/file']);
      return provider === active ? 'Idle client remains open' : null;
    });
    assert.equal(p.actions.length, active ? 0 : 1);
    assert.deepEqual(seen, active === 'claude' ? ['claude'] : ['claude', 'codex']);
  }
});


test('temporary scopes run before evidence-changing history plans without mutating the list', () => {
  const history = plan([action('slim-history')]), temp = plan([action()]), fixed = plan([action()]);
  temp.systemTemp = {uid: 501, excludedRoots: [], session: sessionTemp};
  fixed.systemTemp = {uid: 501, excludedRoots: []};
  const plans = [history, temp, fixed];
  assert.deepEqual(cleanupExecutionOrder(plans), [temp, history, fixed]);
  assert.deepEqual(plans, [history, temp, fixed]);
  assert.equal(includesSystemTemp({tempOnly: true}), true);
  assert.equal(includesSystemTemp({includeFileCleanup: true, removeImages: true}), true);
});


test('Claude archive, hook, tool-definition and skill-listing slimming share age and activity protection', async () => {
  for (const option of ['removeRequestArchives', 'compactHooks', 'compactToolDefinitions', 'compactSkillListings'] as const) {
    const actions = [cutoff - 1, cutoff, now, now + 1, NaN].map((mtime, i) => ({
      ...action('slim-history', mtime, `/inert/${i}.jsonl`),
      slimOptions: {removeImages: false, compactTools: false, [option]: true},
    }));
    const p = plan(actions); p.provider = 'claude';
    protectRecentContent(p, now);
    assert.deepEqual(p.actions, [actions[0]]);
    assert.equal(p.warnings.length, 4);
    await protectActiveContent(p, async () => 'Idle client is still open');
    assert.deepEqual(p.actions, []);
    assert.match(p.warnings.at(-1)!, /Activity protection/);
  }
});


test('duplicate pairs require both files older than 72 hours even with an explicit original', async () => {
  for (const member of [0, 1]) for (const mtime of [cutoff - 1, cutoff, now, now + 1, NaN]) {
    const a = action('deduplicate-history', cutoff - 1, '/inert/sessions/one.jsonl');
    a.files.push({...a.files[0], path: a.files[0].path + '.zst', ino: 2});
    a.files[member].mtimeMs = mtime;
    const p = plan([a], a.files[0].path);
    protectRecentContent(p, now);
    assert.equal(p.actions.length, mtime < cutoff ? 1 : 0);
  }
  for (const activity of [async () => 'Idle client is still open', async () => { throw new Error('Unknown activity'); }]) {
    const a = action('deduplicate-history', cutoff - 1);
    a.files.push({...a.files[0], path: a.files[0].path + '.zst', ino: 2});
    const p = plan([a], a.files[0].path);
    await protectActiveContent(p, activity);
    assert.deepEqual(p.actions, []);
    assert.match(p.warnings.join('\n'), /Activity protection/);
  }
});

test('old snapshot removal inherits strict age and active-client protection', async () => {
  for (const mtime of [cutoff - 1, cutoff, now, now + 1, NaN]) {
    const a = action('slim-history', mtime);
    a.slimOptions = {removeImages: false, compactTools: false, removeOldSnapshots: true};
    a.slimCounts = {images: 0, toolOutputs: 0, oldSnapshots: 1};
    const p = protectRecentContent(plan([a]), now);
    assert.equal(p.actions.length, mtime < cutoff ? 1 : 0);
  }
  const a = action('slim-history', cutoff - 1);
  a.slimOptions = {removeImages: false, compactTools: false, removeOldSnapshots: true};
  const p = plan([a], a.files[0].path);
  await protectActiveContent(p, async () => 'Idle client remains open');
  assert.deepEqual(p.actions, []);
  assert.match(p.warnings.join('\n'), /Activity protection/);
});

test('Claude activity retains only the active session, its descendants and unknown ownership', async () => {
  const closed = 'aaaaaaaa-1234-1234-1234-123456789abc';
  const paths = [`projects/p/${session}.jsonl`, `projects/p/${session}/subagents/agent-child.jsonl`,
    `projects/p/${session}/tool-results/result.txt`, `projects/p/${closed}.jsonl`, 'debug/unknown.log'];
  const p = plan(paths.map(path => action('slim-history', cutoff - 1, `/inert/${path}`)));
  p.provider = 'claude';
  let calls = 0;
  await protectActiveContent(p, async () => { calls++; return {sessionIds: [session], openFiles: []}; });
  assert.equal(calls, 1);
  assert.deepEqual(p.actions.map(a => a.files[0].path), [`/inert/projects/p/${closed}.jsonl`]);
  assert.equal(p.actions.reduce((sum, a) => sum + a.estimatedSavingsBytes!, 0), 50);
  assert.match(p.warnings.join('\n'), /active session/i);
});

test('grouped actions and explicit targets cannot hide an active parent or open file', async () => {
  const child = action('delete-files', cutoff - 1, `/inert/projects/p/${session}/subagents/agent-child.jsonl`);
  child.sessionIds = ['child'];
  const other = action('slim-history', cutoff - 1, '/inert/projects/p/aaaaaaaa-1234-1234-1234-123456789abc.jsonl');
  const group = action('delete-files', cutoff - 1, other.files[0].path);
  group.files.push(...child.files); group.sessionIds = ['child'];
  const p = plan([child, other, group], child.files[0].path); p.provider = 'claude';
  await protectActiveContent(p, async () => ({sessionIds: [session], openFiles: [other.files[0].path]}));
  assert.deepEqual(p.actions, []);
});

test('session temp evidence uses provider roots and keeps unknown cross-provider ownership conservative', async () => {
  const p = plan([action('delete-files', cutoff - 1)]); p.provider = 'claude';
  p.systemTemp = {uid: 501, excludedRoots: [], session: {...sessionTemp, source: `/claude/projects/p/${session}.jsonl`, sessionId: session}};
  await protectActiveContent(p, async provider => provider === 'claude' ? {sessionIds: ['aaaaaaaa-1234-1234-1234-123456789abc'], openFiles: []} : null);
  assert.equal(p.actions.length, 1);
  await protectActiveContent(p, async provider => provider === 'claude' ? {sessionIds: [session], openFiles: []} : null);
  assert.equal(p.actions.length, 0);
});
