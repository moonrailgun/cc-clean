import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { directoryEntries, scanRoot } from '../src/scan.ts';
import { analyze } from '../src/analyze.ts';
import { readCodexIndex } from '../src/providers/codex.ts';
import { report } from '../src/app.ts';
import type { ScanProgress } from '../src/types.ts';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'cc-clean-analysis-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return realpath(base);
}
async function file(root: string, path: string, content: string | Buffer) {
  const dest = join(root, path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content);
  return dest;
}
function jsonl(records: unknown[]) { return records.map(record => JSON.stringify(record)).join('\n') + '\n'; }
const stamp = '2026-11-01T10:00:00.000Z';

test('analysis progress counts unique session files and bytes, including cache hits', async t => {
  const base = await fixture(t), root = join(base, 'root');
  const content = jsonl([{ type: 'user', sessionId: 'one', message: { content: 'x'.repeat(200_000) } }]);
  const first = await file(root, 'projects/p/one.jsonl', content);
  await file(root, 'projects/p/two.jsonl', content.replace('"one"', '"two"'));
  await link(first, join(root, 'projects/p/z-alias.jsonl'));
  await file(root, 'settings.json', '{}');
  const config = { roots: { claude: root, codex: root }, stateDir: join(base, 'state') };
  for (let run = 0; run < 2; run++) {
    const events: ScanProgress[] = [];
    const data = await report(config, 'claude', true, undefined, p => events.push(p));
    assert.equal(data.usage.parsedFiles, 2);
    assert.ok(events.some(p => p.phase === 'discovering' && p.completed > 0 && p.total === null));
    const parsing = events.filter(p => p.phase === 'sessions');
    assert.equal(parsing[0]?.completed, 0);
    assert.ok(parsing.length > 2, 'progress is reported while files are read');
    assert.ok(parsing.every(p => p.total === 2));
    assert.deepEqual([...new Set(parsing.map(p => p.completed))], [0, 1, 2]);
    assert.equal(parsing.at(-1)?.processedBytes, Buffer.byteLength(content) * 2);
    assert.equal(parsing.at(-1)?.totalBytes, Buffer.byteLength(content) * 2);
    for (let i = 1; i < parsing.length; i++) assert.ok(parsing[i].processedBytes! >= parsing[i - 1].processedBytes!);
    assert.equal(events.at(-1)?.phase, 'finalizing');
    assert.equal((await readdir(join(config.stateDir, 'providers/claude/cache'))).length, 2);
    if (run) assert.equal(parsing.length, 5, 'cached files each report their size once');
  }
});

test('deep scan can stop inside a large file without finishing it or caching partial data', { timeout: 5000 }, async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  const content = jsonl([{ type: 'user', sessionId: 'large', uuid: 'one', message: { content: 'x'.repeat(4096) } }]).repeat(1024);
  const path = await file(root, 'projects/p/large.jsonl', content);
  const controller = new AbortController(), events: ScanProgress[] = [];
  let scheduled = false;
  const result = await report({ roots: { claude: root, codex: root }, stateDir }, 'claude', true, controller.signal, p => {
    events.push(p);
    if (p.phase === 'sessions' && p.processedBytes! > 0 && !scheduled) {
      scheduled = true;
      setImmediate(() => controller.abort());
    }
  });
  assert.equal(scheduled, true);
  assert.equal(result.scanComplete, false);
  const last = events.filter(p => p.phase === 'sessions').at(-1)!;
  assert.equal(last.completed, 0);
  assert.ok(last.processedBytes! < last.totalBytes!);
  assert.deepEqual(await readdir(join(stateDir, 'providers/claude/cache')).catch(() => []), []);
  assert.equal(await readFile(path, 'utf8'), content);
});

test('scan excludes symlink targets and counts hardlinked storage once', async t => {
  const base = await fixture(t), root = join(base, 'root');
  const source = await file(root, 'generated_images/image.png', '12345');
  await link(source, join(root, 'alias.png'));
  const external = await file(base, 'outside/secret', 'outside-content');
  await symlink(dirname(external), join(root, 'linked'));
  const inventory = await scanRoot(root, 'codex');
  assert.equal(inventory.totalBytes, 5);
  assert.equal(inventory.files.length, 2);
  assert.equal(inventory.links.length, 1);
  assert.equal(inventory.complete, true);
  const result = await analyze(inventory);
  assert.equal(result.sharedBytes, 5);
  assert.equal(result.categories.reduce((sum, item) => sum + item.bytes, 0), 5);
  assert.equal(result.projects.reduce((sum, item) => sum + item.bytes, 0) + result.sharedBytes + result.unattributedBytes, 5);
});

test('directory browsing reconciles nested totals and does not count hardlinks twice', async t => {
  const root = await fixture(t);
  const a = await file(root, 'large/nested/a', '1234567890');
  await file(root, 'small/b', '123');
  await link(a, join(root, 'small', 'alias'));
  const inventory = await scanRoot(root, 'claude');
  const entries = directoryEntries(inventory);
  assert.deepEqual(entries.map(e => e.name), ['large', 'small']);
  assert.equal(entries.reduce((n, e) => n + e.bytes, 0), 13);
  assert.equal(directoryEntries(inventory, 'large/')[0].directory, true);
  assert.deepEqual(directoryEntries(inventory, 'large/nested/').map(e => [e.name, e.bytes, e.directory]), [['a', 10, false]]);
  assert.equal(directoryEntries(inventory, 'small/').reduce((n, e) => n + e.bytes, 0), 3);
  assert.deepEqual(directoryEntries(inventory, 'missing/'), []);
});

test('deep project usage aggregates sessions without counting duplicate assistant messages twice', async t => {
  const root = await fixture(t);
  const message = {id:'message-1', usage:{input_tokens:10, output_tokens:4}, content:[]};
  await file(root, 'projects/p/one.jsonl', jsonl([
    {type:'user', sessionId:'one', cwd:'/project-a', uuid:'u1', message:{content:'synthetic'}},
    {type:'assistant', message}, {type:'assistant', message},
  ]));
  await file(root, 'projects/p/two.jsonl', jsonl([
    {type:'user', sessionId:'two', cwd:'/project-b', uuid:'u2', message:{content:'synthetic'}},
    {type:'assistant', message:{...message, id:'message-2', usage:{input_tokens:20, output_tokens:8}}},
  ]));
  await file(root, 'projects/p/imported.jsonl', jsonl([
    {type:'user', sessionId:'imported', cwd:'/project-a', isImported:true, uuid:'u3', message:{content:'synthetic'}},
    {type:'assistant', message:{...message, id:'message-3'}},
  ]));
  const data = await analyze(await scanRoot(root,'claude'),{deep:true});
  assert.equal(data.projects.find(p => p.path === '/project-a')?.usage.inputTokens, 10);
  assert.equal(data.projects.find(p => p.path === '/project-b')?.usage.inputTokens, 20);
  assert.equal(data.projects.find(p => p.path === '/project-a')?.usage.verified, false);
  assert.equal(data.projects.find(p => p.path === '/project-b')?.usage.verified, true);
  assert.equal(data.projects.reduce((n, p) => n + (p.usage.inputTokens ?? 0), 0), data.usage.inputTokens);
});

test('Claude metadata retains actual cwd and groups only owned files', async t => {
  const root = await fixture(t);
  await file(root, 'projects/-cannot-decode/main.jsonl', jsonl([
    { type: 'user', sessionId: 'main', uuid: 'u1', cwd: '/missing/project-a', timestamp: stamp, message: { role: 'user', content: 'private body' } },
    { type: 'assistant', sessionId: 'main', cwd: '/missing/project-b', message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 4 } } },
  ]));
  await file(root, 'projects/-cannot-decode/main/subagents/agent-child.jsonl', jsonl([
    { type: 'user', sessionId: 'main', agentId: 'child', isSidechain: true, cwd: '/missing/project-a', message: { content: 'child' } },
  ]));
  await file(root, 'projects/-cannot-decode/main/tool-results/result.txt', 'owned');
  await file(root, 'projects/-cannot-decode/memory/MEMORY.md', 'retained');
  const result = await analyze(await scanRoot(root, 'claude'));
  const main = result.sessions.find(item => item.id === 'main')!;
  assert.equal(main.project, '/missing/project-a');
  assert.deepEqual(main.observedProjects, ['/missing/project-a', '/missing/project-b']);
  assert.equal(main.files.length, 2);
  assert.equal(main.usage.inputTokens, null);
  assert.equal(main.usage.userMessages, null);
  assert.equal(result.sessions.find(item => item.id === 'child')?.parentId, 'main');
  assert.equal(result.projects.reduce((sum, item) => sum + item.bytes, 0) + result.sharedBytes + result.unattributedBytes, result.totalBytes);
});

test('Claude deduplicates message usage and reports field and embedded-image bytes without retaining body', async t => {
  const root = await fixture(t), stateDir = join(root, 'state');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };
  const message = { id: 'm1', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 }, content: [{ type: 'tool_use', id: 'tool1', name: 'x', input: {} }] };
  await file(root, 'projects/p/main.jsonl', jsonl([
    { type: 'user', uuid: 'u1', sessionId: 'main', cwd: '/project', timestamp: stamp, message: { role: 'user', content: [image, image, { type: 'text', text: 'DO_NOT_CACHE_BODY' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: stamp, message },
    { type: 'assistant', uuid: 'a2', timestamp: stamp, message: { ...message, usage: { ...message.usage, output_tokens: 9 } } },
    { type: 'user', uuid: 'result1', timestamp: stamp, message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'tool output' }] } },
  ]));
  const result = await analyze(await scanRoot(root, 'claude'), { deep: true, stateDir });
  assert.equal(result.usage.inputTokens, 24);
  assert.equal(result.usage.outputTokens, 9);
  assert.equal(result.usage.cachedTokens, 14);
  assert.equal(result.usage.userMessages, 1);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.byModel['claude-test'].outputTokens, 9);
  assert.equal(result.opportunities.embeddedImageBytes, 16);
  assert.equal(result.opportunities.duplicateImageBytes, 8);
  assert.ok(result.opportunities.fields.some(item => item.path === 'message.content'));
  assert.equal(result.opportunities.recordTypes.find(item => item.type === 'assistant')?.count, 2);
  const cache = join(stateDir, 'providers/claude/cache');
  for (const name of await readdir(cache)) {
    const content = await readFile(join(cache, name), 'utf8');
    assert.ok(!content.includes('DO_NOT_CACHE_BODY'));
    assert.ok(!content.includes('aGVsbG8='));
  }
});

test('Codex cumulative usage uses deltas across models, handles reset, and ignores last-usage duplication', async t => {
  const root = await fixture(t);
  const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: 3, reasoning_output_tokens: 2 });
  const tokens = (input: number, output: number) => ({ timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(input, output), last_token_usage: usage(input, output) } } });
  await file(root, 'sessions/rollout-test.jsonl', jsonl([
    { type: 'session_meta', payload: { id: 's1', cwd: '/project', timestamp: stamp, cli_version: '0.167.0' } },
    { type: 'turn_context', payload: { model: 'model-a', cwd: '/project' } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    tokens(10, 5), tokens(10, 5), tokens(20, 8),
    { type: 'turn_context', payload: { model: 'model-b', cwd: '/worktree' } },
    tokens(30, 12), tokens(4, 2),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1' } },
  ]));
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.usage.inputTokens, 34);
  assert.equal(result.usage.outputTokens, 14);
  assert.equal(result.usage.byModel['model-a'].inputTokens, 20);
  assert.equal(result.usage.byModel['model-b'].inputTokens, 14);
  assert.equal(result.usage.userMessages, 1);
  assert.equal(result.usage.toolCalls, 1);
  assert.deepEqual(result.sessions[0].observedProjects, ['/project', '/worktree']);
  assert.equal(result.sessions[0].usage.verified, true);
});

test('Codex merges a live WAL index with files and keeps index-only rows visible', async t => {
  const root = await fixture(t);
  const rollout = await file(root, 'sessions/rollout-test.jsonl', jsonl([
    { type: 'session_meta', payload: { id: 'disk', cwd: '/disk', timestamp: stamp } },
  ]));
  const dbPath = join(root, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('disk', rollout, '/disk', 1, 2, 0);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('missing', join(root, 'sessions/missing.jsonl'), '/missing', 1, 3, 1);
  const beforeDb = await readFile(dbPath), beforeWal = await readFile(dbPath + '-wal');
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions.find(item => item.id === 'disk')?.files.length, 1);
  const missing = result.sessions.find(item => item.id === 'missing')!;
  assert.equal(missing.indexOnly, true);
  assert.equal(missing.archived, true);
  assert.equal(missing.bytes, 0);
  assert.equal(missing.usage.inputTokens, null);
  assert.equal(result.scanComplete, false);
  assert.deepEqual(await readFile(dbPath), beforeDb);
  assert.deepEqual(await readFile(dbPath + '-wal'), beforeWal);
  assert.equal(result.projects.reduce((sum, item) => sum + item.bytes, 0) + result.sharedBytes + result.unattributedBytes, result.totalBytes);
});

test('malformed and oversized lines preserve later records but mark analysis incomplete', async t => {
  const root = await fixture(t);
  await file(root, 'projects/p/s1.jsonl', jsonl([{ type: 'user', sessionId: 's1', cwd: '/project', uuid: 'u1', message: { content: 'first' } }]) + '{bad\n' + 'x'.repeat(9 * 1024 * 1024) + '\n' + jsonl([{ type: 'user', uuid: 'u2', message: { content: 'last' } }]) + '{"unfinished":');
  const result = await analyze(await scanRoot(root, 'claude'), { deep: true });
  assert.equal(result.scanComplete, false);
  assert.equal(result.sessions[0].usage.userMessages, 2);
  assert.ok(result.warnings.some(message => /line/.test(message)));
  assert.equal(result.usage.verified, false);
});

test('changed fingerprints invalidate cached usage', async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  const path = await file(root, 'projects/p/s1.jsonl', jsonl([{ type: 'assistant', sessionId: 's1', message: { id: 'a1', usage: { input_tokens: 7, output_tokens: 2 } } }]));
  const first = await analyze(await scanRoot(root, 'claude'), { deep: true, stateDir });
  assert.equal(first.usage.inputTokens, 7);
  await writeFile(path, jsonl([{ type: 'assistant', sessionId: 's1', message: { id: 'a1', usage: { input_tokens: 21, output_tokens: 4 } } }]));
  const second = await analyze(await scanRoot(root, 'claude'), { deep: true, stateDir });
  assert.equal(second.usage.inputTokens, 21);
});

test('cancelled inventory and analysis stay explicitly incomplete', async t => {
  const root = await fixture(t);
  await file(root, 'projects/p/s1.jsonl', '{}\n');
  const signal = AbortSignal.abort();
  const inventory = await scanRoot(root, 'claude', signal);
  assert.equal(inventory.complete, false);
  const result = await analyze(inventory, { deep: true, signal });
  assert.equal(result.scanComplete, false);
  assert.equal(result.usage.inputTokens, null);
});

test('bounded metadata mode marks unsampled session content incomplete', async t => {
  const root = await fixture(t);
  await file(root, 'projects/p/s1.jsonl', jsonl([{ type: 'user', sessionId: 's1', cwd: '/project', message: { content: 'hello' } }]) + jsonl([{ type: 'assistant', message: { content: 'x'.repeat(2 * 1024 * 1024) } }]));
  const result = await analyze(await scanRoot(root, 'claude'));
  assert.equal(result.sessions[0].project, '/project');
  assert.equal(result.sessions[0].complete, false);
  assert.equal(result.scanComplete, false);
  assert.equal(result.usage.userMessages, null);
});

test('cache does not hide source replacement after inventory collection', async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  const path = await file(root, 'projects/p/s1.jsonl', jsonl([{ type: 'assistant', sessionId: 's1', message: { id: 'a1', usage: { input_tokens: 7, output_tokens: 2 } } }]));
  const inventory = await scanRoot(root, 'claude');
  await analyze(inventory, { deep: true, stateDir });
  await rm(path);
  await symlink(await file(base, 'outside.jsonl', '{}\n'), path);
  const result = await analyze(inventory, { deep: true, stateDir });
  assert.equal(result.scanComplete, false);
  assert.equal(result.sessions[0].usage.inputTokens, null);
});

test('Codex spawn edges merge while attached relationships block affected sessions', async t => {
  const root = await fixture(t);
  const rollout = await file(root, 'sessions/parent.jsonl', jsonl([{ type: 'session_meta', payload: { id: 'parent', cwd: '/project' } }]));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, attached_thread_parent_id TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('parent', rollout, null);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('child', join(root, 'sessions/child.jsonl'), null);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('attached', join(root, 'sessions/attached.jsonl'), 'parent');
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('parent', 'child', 'running');
  db.close();
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.sessions.find(item => item.id === 'child')?.parentId, 'parent');
  assert.equal(result.sessions.find(item => item.id === 'attached')?.parentId, undefined);
  assert.equal(result.sessions.find(item => item.id === 'parent')?.complete, false);
  assert.ok(result.sessions.find(item => item.id === 'parent')?.warnings.some(warning => warning.includes('Attached')));
  assert.equal(result.scanComplete, false);
});

test('forked usage stays visible in session but is excluded from aggregate totals', async t => {
  const root = await fixture(t);
  await file(root, 'sessions/fork.jsonl', jsonl([
    { type: 'session_meta', payload: { id: 'fork', cwd: '/project', forked_from_id: 'parent' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, output_tokens: 9 } } } },
  ]));
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.sessions[0].usage.inputTokens, 50);
  assert.equal(result.sessions[0].parentId, undefined);
  assert.equal(result.sessions[0].usage.verified, false);
  assert.equal(result.usage.inputTokens, null);
});

test('model keys cannot pollute prototypes and remain visible in usage', async t => {
  const root = await fixture(t);
  await file(root, 'projects/p/s1.jsonl', jsonl([{ type: 'assistant', sessionId: 's1', message: { id: 'm1', model: '__proto__', usage: { input_tokens: 7, output_tokens: 2 } } }]));
  const result = await analyze(await scanRoot(root, 'claude'), { deep: true });
  assert.ok(Object.hasOwn(result.usage.byModel, '__proto__'));
  assert.equal(({} as {inputTokens?: number}).inputTokens, undefined);
  assert.equal(result.usage.byModel['__proto__'].inputTokens, 7);
});

test('cache evicts old entries to a fixed capacity', async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  await file(root, 'projects/p/s1.jsonl', '{}\n');
  const cache = join(stateDir, 'providers/claude/cache');
  await mkdir(cache, { recursive: true });
  for (let i = 0; i < 514; i++) await writeFile(join(cache, i.toString(16).padStart(64, '0') + '.json'), '{}');
  await analyze(await scanRoot(root, 'claude'), { stateDir });
  assert.ok((await readdir(cache)).length <= 512);
});

test('unknown SQLite schema falls back to disk and stays incomplete', async t => {
  const root = await fixture(t);
  await file(root, 'sessions/s1.jsonl', jsonl([{ type: 'session_meta', payload: { id: 's1', cwd: '/project' } }]));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE unsupported (value TEXT)');
  db.close();
  const result = await analyze(await scanRoot(root, 'codex'));
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].complete, false);
  assert.equal(result.scanComplete, false);
  assert.ok(result.warnings.some(warning => warning.includes('unknown threads schema')));
});

test('absent provider root is a complete empty report', async t => {
  const root = join(await fixture(t), 'absent');
  const result = await analyze(await scanRoot(root, 'codex'));
  assert.equal(result.scanComplete, true);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.sessions.length, 0);
});

test('orphaned index spawn edges remain visible as incomplete children', async t => {
  const root = await fixture(t);
  const rollout = await file(root, 'sessions/parent.jsonl', jsonl([{ type: 'session_meta', payload: { id: 'parent', cwd: '/project' } }]));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('parent', rollout);
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run('parent', 'missing');
  db.close();
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.sessions.find(item => item.id === 'missing')?.parentId, 'parent');
  assert.equal(result.sessions.find(item => item.id === 'missing')?.complete, false);
  assert.equal(result.scanComplete, false);
});

test('external Codex SQLite configuration is reported as incomplete coverage', async t => {
  const root = await fixture(t);
  await file(root, 'config.toml', 'sqlite_home = "/elsewhere"\n');
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  db.close();
  const result = await analyze(await scanRoot(root, 'codex'));
  assert.equal(result.scanComplete, false);
  assert.ok(result.warnings.some(warning => /external.*SQLite/i.test(warning)));
});

test('valid JSON with no provider session identity is not a validated session', async t => {
  const root = await fixture(t);
  await file(root, 'projects/p/s1.jsonl', '{}\n');
  const result = await analyze(await scanRoot(root, 'claude'), { deep: true });
  assert.equal(result.sessions[0].complete, false);
  assert.equal(result.scanComplete, false);
});

test('empty existing Codex root reports complete zero storage', async t => {
  const root = await fixture(t);
  const result = await analyze(await scanRoot(root, 'codex'));
  assert.equal(result.scanComplete, true);
  assert.equal(result.totalBytes, 0);
});

test('analysis cache never writes or evicts through a symlinked state ancestor', async t => {
  const base = await fixture(t), root = join(base, 'root');
  await file(root, 'projects/p/s1.jsonl', jsonl([{ type: 'user', sessionId: 's1', cwd: '/project', message: { content: 'hello' } }]));
  const outside = join(base, 'outside');
  const cache = join(outside, 'nested/providers/claude/cache');
  await mkdir(cache, { recursive: true });
  for (let i = 0; i < 514; i++) await writeFile(join(cache, i.toString(16).padStart(64, '0') + '.json'), '{}');
  await symlink(outside, join(base, 'state-link'));
  const result = await analyze(await scanRoot(root, 'claude'), { stateDir: join(base, 'state-link/nested') });
  assert.equal(result.sessions.length, 1);
  assert.equal((await readdir(cache)).length, 514);
});

test('cyclic session graphs are incomplete instead of an empty deletion root set', async t => {
  const root = await fixture(t);
  const first = await file(root, 'sessions/first.jsonl', jsonl([{ type: 'session_meta', payload: { id: 'first', source: { subagent: { thread_spawn: { parent_thread_id: 'second' } } } } }]));
  const second = await file(root, 'sessions/second.jsonl', jsonl([{ type: 'session_meta', payload: { id: 'second', source: { subagent: { thread_spawn: { parent_thread_id: 'first' } } } } }]));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('first', first);
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('second', second);
  db.close();
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.scanComplete, false);
  assert.ok(result.sessions.every(session => !session.complete));
  assert.ok(result.warnings.some(warning => /cycle/i.test(warning)));
});

test('scanner canonicalizes link targets through another directory alias', async t => {
  const base = await fixture(t), root = join(base, 'root');
  const target = await file(root, 'target', 'retained');
  await symlink(root, join(base, 'root-alias'));
  await symlink(join(base, 'root-alias/target'), join(root, 'reference'));
  const inventory = await scanRoot(root, 'codex');
  assert.equal(inventory.links[0].target, target);
});

test('Codex index graph fingerprints ignore row order and change with relationships', async t => {
  const root = await fixture(t), dbPath = join(root, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, archived INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
  insert.run('b', 'sessions/b.jsonl', 0); insert.run('a', 'sessions/a.jsonl', 0);
  const first = await readCodexIndex(await scanRoot(root, 'codex'));
  assert.equal(first.complete, true);
  assert.match(first.fingerprint!, /^[a-f0-9]{64}$/);
  db.exec('DELETE FROM threads');
  insert.run('a', 'sessions/a.jsonl', 0); insert.run('b', 'sessions/b.jsonl', 0);
  assert.equal((await readCodexIndex(await scanRoot(root, 'codex'))).fingerprint, first.fingerprint);
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('a', 'b', 'running');
  assert.notEqual((await readCodexIndex(await scanRoot(root, 'codex'))).fingerprint, first.fingerprint);
  db.exec('DROP TABLE thread_spawn_edges');
  const missing = await readCodexIndex(await scanRoot(root, 'codex'));
  assert.equal(missing.complete, false);
  assert.equal(missing.fingerprint, null);
});

test('Codex spawn graph exceeding its bounded row limit cannot validate deletions', async t => {
  const root = await fixture(t), db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); BEGIN');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('child', 'sessions/child.jsonl');
  const edge = db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)');
  for (let i = 0; i < 100001; i++) edge.run('parent', 'child');
  db.exec('COMMIT'); db.close();
  const result = await readCodexIndex(await scanRoot(root, 'codex'));
  assert.equal(result.complete, false);
  assert.equal(result.fingerprint, null);
  assert.match(result.warnings.join(' '), /edge limit/);
});
import { parseSession } from '../src/providers/jsonl.ts';

test('mixed Claude versions do not make a structurally consistent session incomplete', async t => {
  const root = await fixture(t);
  for (const version of ['unknown-new-format', '2.1.300']) {
    await file(root, 'projects/p/s1.jsonl', jsonl([
      { type: 'user', sessionId: 's1', version, message: { content: 'first' } },
      { type: 'user', sessionId: 's1', version: '2.1.319', message: { content: 'second' } },
    ]));
    const result = await analyze(await scanRoot(root, 'claude'), { deep: true });
    assert.equal(result.sessions[0].complete, true);
    assert.equal(result.scanComplete, true);
    assert.equal(result.sessions[0].version, '2.1.319');
  }
});

test('Codex metadata versions do not hide identity conflicts or block consistent records', async t => {
  const root = await fixture(t);
  for (const id of ['s1', 'different-session']) {
    const content = jsonl([
      { type: 'session_meta', payload: { id: 's1', cli_version: '0.154.0' } },
      { type: 'session_meta', payload: { id, cli_version: 'custom-build' } },
    ]);
    const path = await file(root, 'sessions/s1.jsonl', content);
    const result = await parseSession((await scanRoot(root, 'codex')).files[0], 'codex', true);
    assert.equal(result.version, 'custom-build');
    assert.equal(result.complete, id === 's1');
    assert.deepEqual(result.warnings, id === 's1' ? [] : ['Multiple session identities in one rollout']);
    assert.equal(await readFile(path, 'utf8'), content);
  }
});


test('Claude workflow journals remain inventoried without being parsed as conversations', async t => {
  const root = await fixture(t);
  await file(root, 'projects/p/main.jsonl', jsonl([{ type: 'user', sessionId: 'main' }]));
  const journal = await file(root, 'projects/p/main/subagents/workflows/wf-one/journal.jsonl', jsonl([{ event: 'started' }]));
  await file(root, 'projects/p/main/subagents/agent-child.jsonl', jsonl([{ type: 'user', sessionId: 'main', agentId: 'child' }]));
  const inventory = await scanRoot(root, 'claude');
  assert.equal(inventory.files.find(f => f.path === journal)?.category, 'attachments');
  const result = await analyze(inventory, { deep: true });
  assert.equal(result.scanComplete, true);
  assert.deepEqual(result.sessions.map(s => s.id).sort(), ['child', 'main']);
  assert.ok(result.sessions.every(s => s.files.every(f => f.path !== journal)));
  assert.equal(result.fileCount, 3);
  await file(root, 'projects/p/unknown.jsonl', jsonl([{ event: 'unknown' }]));
  const unknown = await analyze(await scanRoot(root, 'claude'), { deep: true });
  assert.equal(unknown.scanComplete, false, 'unrecognized transcript files must still be reported');
});


test('Claude tool-ID maps are counted as fields without exhausting the field group limit', async t => {
  const root = await fixture(t);
  const wireToolInputs = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`toolu_${i}`, { command: 'private command' }]));
  const wireIngestContext = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`toolu_${i}`, { source: 'private context' }]));
  await file(root, 'projects/p/main.jsonl', jsonl([{ type: 'user', sessionId: 'main', wireToolInputs, wireIngestContext, message: { content: 'hello' } }]));
  const result = await analyze(await scanRoot(root, 'claude'), { deep: true });
  assert.equal(result.scanComplete, true);
  for (const [path, value] of Object.entries({ wireToolInputs, wireIngestContext })) {
    assert.deepEqual(result.opportunities.fields.find(f => f.path === path), { path, bytes: Buffer.byteLength(JSON.stringify(value)), count: 1 });
  }
  assert.ok(result.opportunities.fields.some(f => f.path === 'message.content'));
  assert.ok(result.opportunities.fields.every(f => !f.path.includes('toolu_')));
});


test('changed or unreadable transcripts report the read failure without cascading identity warnings', async t => {
  const root = await fixture(t);
  const path = await file(root, 'projects/p/main.jsonl', jsonl([{ type: 'user', sessionId: 'main' }]));
  const inventory = await scanRoot(root, 'claude');
  await writeFile(path, 'changed');
  const changed = await parseSession(inventory.files[0], 'claude', true);
  assert.equal(changed.complete, false);
  assert.deepEqual(changed.warnings, ['Cannot read session: FILE_CHANGED']);
  const unreadable = await parseSession({ ...inventory.files[0], path: join(root, 'missing.jsonl') }, 'claude', true);
  assert.equal(unreadable.complete, false);
  assert.deepEqual(unreadable.warnings, ['Cannot read session: ENOENT']);
  const malformed = await parseSession((await scanRoot(root, 'claude')).files[0], 'claude', true);
  assert.equal(malformed.complete, false);
  assert.ok(malformed.warnings.some(w => w.includes('malformed JSONL')));
});

import { zstdCompressSync } from 'node:zlib';

import { randomBytes } from 'node:crypto';


function codexHistory(id: string, input = 10) {
  return jsonl([
    { type: 'session_meta', payload: { id, cwd: '/project', timestamp: stamp, cli_version: '0.167.0' } },
    { type: 'turn_context', payload: { model: 'test-model' } },
    { type: 'event_msg', timestamp: stamp, payload: { type: 'user_message', message: '原始文本'.repeat(20_000) } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1' } },
    { type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 5, cached_input_tokens: 3, reasoning_output_tokens: 2 } } } },
  ]);
}


test('Codex reads current and archived zstd histories with plain-path indexes and physical-byte progress', async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  const content = Buffer.from(codexHistory('current') + jsonl([{ type: 'padding', payload: randomBytes(192 * 1024).toString('base64') }]));
  // Separate frames split a UTF-8 JSONL record, as a streaming decoder may do.
  const compressed = Buffer.concat([zstdCompressSync(''), zstdCompressSync(content.subarray(0, 1111)), zstdCompressSync(content.subarray(1111))]);
  assert.ok(compressed.length > 64 * 1024, 'compressed input must span multiple file reads');
  const current = await file(root, 'sessions/current.jsonl.zst', compressed);
  const archived = await file(root, 'archived_sessions/archived.jsonl.zst', zstdCompressSync(codexHistory('archived', 20)));
  await file(base, 'reference/sessions/current.jsonl', content);
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  for (const [id, path] of [['current', current], ['archived', archived]]) db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, path.slice(0, -4), '/project');
  db.close();
  const inventory = await scanRoot(root, 'codex'), histories = inventory.files.filter(f => f.category === 'sessions');
  assert.equal(histories.length, 2);
  const plain = await parseSession((await scanRoot(join(base, 'reference'), 'codex')).files[0], 'codex', true);
  assert.deepEqual(await parseSession(histories.find(f => f.path === current)!, 'codex', true), plain);
  assert.equal((await parseSession(histories.find(f => f.path === current)!, 'codex', false)).complete, true);
  for (let run = 0; run < 2; run++) {
    const events: ScanProgress[] = [];
    const result = await analyze(inventory, { deep: true, stateDir, onProgress: p => events.push(p) });
    assert.equal(result.scanComplete, true);
    assert.equal(result.sessions.length, 2);
    assert.ok(result.sessions.every(s => s.complete && !s.indexOnly));
    assert.equal(result.sessions.find(s => s.id === 'archived')?.archived, true);
    assert.equal(result.usage.inputTokens, 30);
    assert.equal(result.usage.outputTokens, 10);
    assert.equal(result.usage.verified, true);
    assert.equal(result.usage.byModel['test-model'].inputTokens, 30);
    assert.equal(result.usage.byDate[stamp.slice(0, 10)].inputTokens, 30);
    const diskBytes = histories.reduce((n, f) => n + f.size, 0);
    assert.equal(result.projects[0].bytes, diskBytes);
    assert.equal(result.projects[0].bytes + result.sharedBytes + result.unattributedBytes, result.totalBytes);
    assert.ok(result.opportunities.recordTypes.reduce((n, item) => n + item.bytes, 0) > diskBytes);
    const progress = events.filter(p => p.phase === 'sessions');
    assert.equal(progress.at(-1)?.processedBytes, diskBytes);
    assert.equal(progress.at(-1)?.totalBytes, diskBytes);
    assert.equal(progress.at(-1)?.completed, 2);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].processedBytes! >= progress[i - 1].processedBytes! && progress[i].processedBytes! <= diskBytes);
    assert.equal((await readdir(join(stateDir, 'providers/codex/cache'))).length, 2);
    if (run) assert.equal(progress.length, 5, 'both compressed histories were served from cache');
  }
  assert.deepEqual(await readFile(current), compressed);
  assert.equal((await scanRoot(root, 'claude')).files.filter(f => f.category === 'sessions').length, 0);
});


test('Codex prefers a plain sibling without double counting usage or assuming compressed contents match', async t => {
  const root = await fixture(t);
  const content = codexHistory('one');
  const path = await file(root, 'sessions/one.jsonl', content);
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('one', path);
  db.close();
  for (const sibling of [zstdCompressSync(content), zstdCompressSync(codexHistory('stale-id', 999)), Buffer.from('not zstd')]) {
    await file(root, 'sessions/one.jsonl.zst', sibling);
    const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'one');
    assert.equal(result.sessions[0].files.length, 2);
    assert.equal(result.sessions[0].bytes, Buffer.byteLength(content) + sibling.length);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.verified, true, 'preferred plain usage remains verifiable');
    assert.equal(result.usage.parsedFiles, 1);
    assert.equal(result.usage.totalFiles, 1);
    assert.equal(result.opportunities.recordTypes.find(r => r.type === 'session_meta')?.count, 1);
    assert.equal(result.scanComplete, false, 'unverified sibling ownership must not authorize deletion');
    assert.equal(result.sessions[0].complete, false);
    assert.ok(result.warnings.some(w => w.includes('compressed sibling')));
  }
  await file(root, 'sessions/one.jsonl.zst', zstdCompressSync(content));
  await writeFile(path, 'malformed plain history');
  const brokenPlain = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(brokenPlain.usage.inputTokens, null, 'never fall back to potentially stale compressed usage');
  await writeFile(path, content);
  await file(root, 'sessions/unrelated.jsonl.zst', zstdCompressSync(content));
  const duplicate = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(duplicate.usage.inputTokens, null, 'unrelated paths with duplicate IDs are still excluded');
  assert.ok(duplicate.sessions[0].warnings.some(w => w.includes('Multiple distinct files')));
});


test('Codex compressed path aliases detect index/session identity mismatches', async t => {
  const root = await fixture(t);
  const path = await file(root, 'sessions/one.jsonl.zst', zstdCompressSync(codexHistory('one')));
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('different', path.slice(0, -4));
  db.close();
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].complete, false);
  assert.ok(result.sessions[0].warnings.includes('Index/session ID mismatch'));
});


test('compressed metadata sampling is bounded by decoded bytes while record visitors read the full stream', async t => {
  const root = await fixture(t), limit = 1024 * 1024;
  const header = jsonl([{ type: 'session_meta', payload: { id: 'one', cwd: '/first' } }]);
  const exact = header + ' '.repeat(limit - Buffer.byteLength(header));
  const path = await file(root, 'sessions/one.jsonl.zst', zstdCompressSync(exact));
  assert.equal((await parseSession((await scanRoot(root, 'codex')).files[0], 'codex', false)).complete, true);
  await writeFile(path, zstdCompressSync(exact + '\n' + jsonl([{ type: 'turn_context', payload: { cwd: '/later' } }])));
  const entry = (await scanRoot(root, 'codex')).files[0];
  assert.ok(entry.size < 1024, 'small disk size must not bypass the decoded sample limit');
  const sampled = await parseSession(entry, 'codex', false);
  assert.equal(sampled.complete, false);
  assert.deepEqual(sampled.observedProjects, ['/first']);
  assert.ok(sampled.warnings.some(w => w.includes('first 1 MiB')));
  const records: unknown[] = [];
  const full = await parseSession(entry, 'codex', false, undefined, undefined, row => records.push(row));
  assert.equal(full.complete, true);
  assert.deepEqual(full.observedProjects, ['/first', '/later']);
  assert.equal(records.length, 2);
});


test('damaged zstd streams stay incomplete and uncached even after complete JSONL records', async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  const valid = zstdCompressSync(codexHistory('one'));
  for (const damaged of [Buffer.alloc(0), Buffer.from('invalid frame'), valid.subarray(0, valid.length - 2), Buffer.concat([valid, Buffer.from('invalid trailing frame')]), Buffer.concat([valid, valid.subarray(0, valid.length - 2)])]) {
    const path = await file(root, 'sessions/one.jsonl.zst', damaged);
    const result = await analyze(await scanRoot(root, 'codex'), { deep: true, stateDir });
    assert.equal(result.scanComplete, false);
    assert.equal(result.usage.verified, false);
    assert.ok(result.warnings.some(w => w.includes('Cannot read session')));
    assert.deepEqual(await readdir(join(stateDir, 'providers/codex/cache')).catch(() => []), []);
    assert.deepEqual(await readFile(path), damaged);
  }
});


test('decoding can be cancelled without caching partial results or touching the compressed source', { timeout: 5000 }, async t => {
  const base = await fixture(t), root = join(base, 'root'), stateDir = join(base, 'state');
  const compressed = zstdCompressSync(codexHistory('one') + jsonl([{ type: 'padding', payload: 'x'.repeat(4096) }]).repeat(2048));
  const path = await file(root, 'sessions/one.jsonl.zst', compressed);
  const controller = new AbortController();
  const result = await analyze(await scanRoot(root, 'codex'), { deep: true, stateDir, signal: controller.signal, onProgress: p => {
    if (p.phase === 'sessions' && p.processedBytes! > 0) controller.abort();
  } });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.scanComplete, false);
  assert.equal(result.usage.verified, false);
  assert.equal(result.sessions[0].complete, false);
  assert.deepEqual(await readdir(join(stateDir, 'providers/codex/cache')).catch(() => []), []);
  assert.deepEqual(await readFile(path), compressed);
});
