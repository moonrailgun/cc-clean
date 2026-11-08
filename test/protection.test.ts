import test from 'node:test';
import assert from 'node:assert/strict';
import { ageProtectionReason, protectRecentContent, singleSelectedTarget, type Action, type Plan } from '../src/clean.ts';

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
  for (const kind of ['delete-files', 'codex-delete'] as const) {
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
  for (const kind of ['delete-files'] as const) {
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
  const a = action('delete-files', cutoff - 1);
  assert.equal(ageProtectionReason(a, undefined, now), null);
  assert.ok(ageProtectionReason(a, undefined, now - 1));
  a.files[0].mtimeMs = now;
  assert.ok(ageProtectionReason(a, undefined, now));
});
