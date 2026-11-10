import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { mkdtemp, mkdir, writeFile, readdir, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import measure from 'fast-string-truncated-width';
import { select, checkbox, withProgress, fit, paint, safe, storageRow, menuRow, table, tree, pager } from '../src/terminal.ts';
import { analysisMenu, menu, printReport, detailNodes, cleanupFileNodes, printPlan, printPlans, printReceipts, printCleanupLog, confirmPlans, emptyPlansMenu, cleanOptions, usageMenu, cleanupResults, executeCleanup, runSelection, selectedPlanLoader } from '../src/ui.ts';
import { CLAUDE_FILE_CLEANUP_NOTICE } from '../src/app.ts';
import type { Plan, Receipt } from '../src/clean.ts';
import type { Analysis, Usage } from '../src/types.ts';

// Cleanup interactions below replace every planner, executor and recovery call with in-memory stubs.
async function terminal(t: test.TestContext) {
  const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
  // Like stdout, keep the destination open when a prompt's output stream ends.
  Object.defineProperty(output, '_isStdio', { value: true });
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  t.after(() => { controller.abort(); input.destroy(); output.destroy(); });
  return {
    context: { input, output, signal: controller.signal },
    abort: () => controller.abort(),
    text: () => text,
    key: async (key: string) => { input.write(key); if (key === '\x1b') await setTimeout(550); else await setImmediate(); },
  };
}
const choices = [
  { name: 'Alpha', value: 'alpha', description: 'First item' },
  { name: 'Beta', value: 'beta', description: 'Second item' },
  { name: 'Query 42 项目', value: 'query', description: 'Third item' },
];

// Interpret the cursor/erase commands used by these prompts to check the resulting screen.
function screenLines(output: string): string[] {
  const rows: string[][] = [[]];
  let row = 0, column = 0;
  for (const token of output.matchAll(/\x1b\[([?\d;]*)([A-Za-z])|([^\x1b])/gu)) {
    const [, argument, command, character] = token;
    if (command === 'A') row = Math.max(0, row - Number(argument || 1));
    else if (command === 'B') row += Number(argument || 1);
    else if (command === 'G') column = Number(argument || 1) - 1;
    else if (command === 'K') {
      if (argument === '2') rows[row] = [];
      else rows[row] = (rows[row] ?? []).slice(0, column);
    } else if (command) assert.ok(command === 'm' || command === 'h' || command === 'l', `Unexpected control: ${token[0]}`);
    else if (character === '\n') { row++; column = 0; }
    else if (character === '\r') column = 0;
    else {
      rows[row] ??= [];
      rows[row][column] = character;
      column += measure(character).width;
    }
  }
  return Array.from({ length: rows.length }, (_, i) => (rows[i] ?? []).join('').trimEnd());
}

test('moving a menu selection updates only changed rows without erasing the screen', async t => {
  const term = await terminal(t);
  const answer = select({ message: 'Projects', choices: choices.map((choice, i) => ({ ...choice, bytes: 100 - i })) }, term.context);
  void answer.catch(() => {});
  const from = term.text().length;
  await term.key('\x1b[B');
  const update = term.text().slice(from), text = stripVTControlCharacters(update);
  assert.match(text, /1\..*Alpha/);
  assert.match(text, /➤\s+2\..*Beta/);
  assert.doesNotMatch(text, /Projects|Query 42|Move|Back/);
  assert.doesNotMatch(update, /\x1b\[(?:2K|2J)/);
  await term.key('\r');
  assert.equal(await answer, 'beta');
});

test('incremental repaint preserves row positions through filtering, paging and prompt cleanup', async t => {
  const term = await terminal(t);
  const entries = Array.from({ length: 20 }, (_, i) => ({ name: `Item ${String(i).padStart(2, '0')}`, value: i }));
  const answer = select({ message: 'Projects', choices: entries, searchable: true }, term.context);
  void answer.catch(() => {});
  const original = screenLines(term.text());
  await term.key('\x1b[6~');
  const lastPage = screenLines(term.text()).join('\n');
  assert.match(lastPage, /➤\s+15\. Item 14/);
  assert.doesNotMatch(lastPage, /Item 00|Item 13/);
  await term.key('\x1b[5~');
  assert.deepEqual(screenLines(term.text()).slice(0, original.length), original);
  await term.key('/'); await term.key('Item 19');
  let filtered = screenLines(term.text()).join('\n');
  assert.match(filtered, /➤\s+1\. Item 19/);
  assert.doesNotMatch(filtered, /Item 00|Item 14|20 items/);
  await term.key('x');
  filtered = screenLines(term.text()).join('\n');
  assert.match(filtered, /No matching items/);
  assert.doesNotMatch(filtered, /\d\. Item/);
  await term.key('\x1b');
  assert.deepEqual(screenLines(term.text()).slice(0, original.length), original);
  assert.ok(screenLines(term.text()).slice(original.length).every(line => !line));
  await term.key('q'); await answer;
  assert.equal(screenLines(term.text()).join('').trim(), '');
  assert.equal(term.context.output.writableEnded, false, 'the shared destination remains open');
});

test('tree and checkbox navigation leave surrounding rows untouched', async t => {
  const term = await terminal(t);
  const branches = [{ name: 'First', children: [{ name: 'Child' }] }, { name: 'Second' }, { name: 'Third' }];
  const answer = tree({ message: 'Details', nodes: branches }, term.context);
  void answer.catch(() => {});
  const original = screenLines(term.text());
  await term.key('\x1b[C');
  assert.match(screenLines(term.text()).join('\n'), /Child/);
  await term.key('\x1b[D');
  assert.deepEqual(screenLines(term.text()).slice(0, original.length), original);
  assert.ok(screenLines(term.text()).slice(original.length).every(line => !line));
  let from = term.text().length;
  await term.key('j');
  assert.doesNotMatch(stripVTControlCharacters(term.text().slice(from)), /Details|Third|Fold\/Expand/);
  await term.key('q'); await answer;
  assert.equal(screenLines(term.text()).join('').trim(), '');
  const checked = checkbox({ message: 'Choose items', choices }, term.context);
  from = term.text().length;
  await term.key(' ');
  const update = stripVTControlCharacters(term.text().slice(from));
  assert.match(update, /● Alpha/);
  assert.doesNotMatch(update, /Choose items|Beta|Query 42|Space Toggle/);
  await term.key('\r'); assert.deepEqual(await checked, ['alpha']);
});

test('progress updates overwrite counts without repainting the title or controls', async t => {
  const term = await terminal(t);
  await withProgress({ message: 'Deep Scan' }, async (_signal, update) => {
    update({ phase: 'sessions', completed: 1, total: 10 });
    await setTimeout(120);
    const from = term.text().length;
    update({ phase: 'sessions', completed: 2, total: 10 });
    await setTimeout(120);
    const output = term.text().slice(from);
    assert.match(stripVTControlCharacters(output), /2 \/ 10/);
    assert.doesNotMatch(output, /Deep Scan|Scanning sessions|Cancel|\x1b\[2K/);
  }, term.context);
  assert.equal(screenLines(term.text()).join('').trim(), '');
});

function sampleReport(): Analysis {
  const usage: Usage = { userMessages: 9, toolCalls: 541, inputTokens: 29135711, outputTokens: 278512, cachedTokens: 29134657, reasoningTokens: null, verified: true };
  return {
    schemaVersion: 1, provider: 'claude', root: '/synthetic/claude', totalBytes: 1000,
    scanComplete: false, scannedAt: '2026-11-08T00:00:00.000Z', fileCount: 1, categories: [], directories: [],
    projects: [{ path: '/project', sessions: 1, bytes: 1000, updatedAt: '', usage }], sessions: [], sharedBytes: 0, unattributedBytes: 0,
    usage: { ...usage, parsedFiles: 1, totalFiles: 1, byDate: { '2026-11-08': usage }, byModel: {
      'claude-sonnet': usage, 'other-model': { ...usage, userMessages: 0, inputTokens: null, verified: false },
    } },
    opportunities: { pngBytes: 10, pngCount: 1, embeddedImageBytes: 50, duplicateImageBytes: 20,
      fields: [{ path: 'wireToolInputs.a', bytes: 500, count: 10 }, { path: 'wireToolInputs.b', bytes: 100, count: 2 },
        { path: 'wireToolInputs', bytes: 2, count: 1 }, { path: 'type', bytes: 50, count: 13 }],
      recordTypes: [{ type: 'user', bytes: 400, count: 5 }, { type: 'assistant', bytes: 600, count: 8 }] },
    warnings: ['/synthetic/claude/projects/session.jsonl: Mixed session format versions'],
  };
}

test('usage reports use rows per model, project and date, keeping diagnostics in Details', t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 160 });
  t.after(() => { if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor); else delete process.stdout.columns; });
  let lines: string[] = [];
  t.mock.method(console, 'log', (text = '') => lines.push(stripVTControlCharacters(text)));
  const report = sampleReport();
  printReport(report, 'usage');
  const output = lines.join('\n');
  for (const label of ['claude-sonnet', '/project', '2026-11-08']) {
    assert.match(lines.find(line => line.trimStart().startsWith(label))!, /9\s+541\s+29,135,711\s+278,512\s+29,134,657$/);
  }
  assert.match(output, /other-model\s+0\s+541\s+—/);
  assert.match(output, /Some data is partial.*Details/);
  assert.doesNotMatch(output, /Reasoning tokens|Usage: verified|Mixed session format|session\.jsonl/);
  report.usage.byModel['other-model'].reasoningTokens = 0;
  lines = []; printReport(report, 'usage');
  assert.match(lines.join('\n'), /Reasoning tokens/);
  assert.match(lines.find(line => line.includes('other-model'))!, /\s+0$/);
  report.totalBytes = 100;
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  t.after(() => { if (tty) Object.defineProperty(process.stdout, 'isTTY', tty); else delete process.stdout.isTTY; });
  lines = []; printReport(report, 'opportunities');
  assert.match(lines.join('\n'), /session\.jsonl: Mixed session format/);
  assert.match(lines.join('\n'), /Percentages use decoded history bytes/);
  assert.match(lines.find(line => line.includes('assistant (8)'))!, /60\.0%/);
  assert.match(lines.find(line => line.includes('wireToolInputs.a (10)'))!, /50\.0%/);
});

test('tables preserve exact numeric columns at narrow widths and sanitize Unicode labels', () => {
  const headers = ['Model', 'Messages', 'Tools', 'Input tokens', 'Output tokens', 'Cached tokens'];
  const record = ['\x1b[2J模型👨‍👩‍👧‍👦 very long model name\n', '0', '541', '29,135,711', '278,512', '29,134,657'];
  for (const width of [40, 48, 79, 159]) {
    const lines = table(headers, [record], width).map(stripVTControlCharacters);
    assert.ok(lines.every(line => measure(line).width <= width), `${width}: ${lines.join('\n')}`);
    for (const value of record.slice(1)) assert.ok(lines.some(line => line.includes(value)), value);
    assert.doesNotMatch(lines.join('\n'), /\x1b/);
  }
});

test('tabbed reports scroll within the viewport, retain positions and repaint only changed rows', async t => {
  const term = await terminal(t), listeners = process.stdout.listenerCount('resize');
  for (const [key, value] of [['columns', 100], ['rows', 20]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
    Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else Reflect.deleteProperty(process.stdout, key); });
  }
  const answer = pager({ message: 'Usage breakdown', subtitle: 'Synthetic data', pages: [
    { name: 'Projects', content: () => Array.from({ length: 100 }, (_, i) => `  Project ${String(i).padStart(3, '0')}`) },
    { name: 'Models', content: () => ['  Model only'] },
  ] }, term.context);
  void answer.catch(() => {});
  const current = () => screenLines(term.text());
  assert.ok(current().length <= 20);
  assert.match(current().join('\n'), /\[Projects\]/);
  assert.match(current().join('\n'), /Project 000/);
  assert.doesNotMatch(current().join('\n'), /Project 099|Model only/);
  const first = current();
  const from = term.text().length;
  await term.key('\x1b[B');
  const update = term.text().slice(from);
  assert.doesNotMatch(update, /Usage breakdown|Synthetic data|\[Projects\]|Scroll|\x1b\[(?:2K|2J)/);
  assert.doesNotMatch(current().join('\n'), /Project 000/);
  await term.key('k'); assert.deepEqual(current(), first);
  await term.key('\x1b[6~'); // Page down.
  assert.doesNotMatch(current().join('\n'), /Project 000/);
  await term.key('\x1b[5~'); assert.deepEqual(current(), first);
  await term.key('\x1b[F'); // End.
  const last = current();
  assert.match(last.join('\n'), /Project 099/);
  assert.ok(last.length <= 20);
  await term.key('\x1b[C');
  assert.match(current().join('\n'), /\[Models\].*\n(?:.*\n)*.*Model only/);
  assert.doesNotMatch(current().join('\n'), /Project \d/);
  await term.key('\x1b[D'); assert.deepEqual(current(), last);
  await term.key('\t');
  assert.match(current().join('\n'), /\[Models\]/);
  await term.key('\x1b[Z'); assert.deepEqual(current(), last);
  await term.key('\x1b[H'); assert.deepEqual(current(), first);
  process.stdout.columns = 41; process.stdout.rows = 12;
  const resizedFrom = term.text().length;
  process.stdout.emit('resize'); await setImmediate();
  const resized = screenLines(term.text().slice(resizedFrom));
  assert.ok(resized.filter(Boolean).length <= 12);
  assert.ok(resized.every(line => measure(line).width <= 40));
  await term.key('\x1b[F');
  assert.match(current().join('\n'), /Project 099/);
  await term.key('q'); await answer;
  assert.equal(current().join('').trim(), '');
  assert.equal(process.stdout.listenerCount('resize'), listeners);
  assert.equal(term.context.input.listenerCount('keypress'), 0);
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('usage tabs preserve exact numbers in narrow windows and show empty states', async t => {
  const term = await terminal(t);
  Object.defineProperties(term.context.output, { columns: { value: 41 }, rows: { value: 12 } });
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, value });
    t.after(() => Object.defineProperty(process, name, descriptor));
  }
  const data = sampleReport();
  data.projects = []; data.usage.byDate = {};
  const answer = usageMenu(data, term.context.signal);
  void answer.catch(() => {});
  const current = () => screenLines(term.text());
  let seen = current().join('\n');
  for (let i = 0; i < 20; i++) {
    await term.key('j');
    const lines = current();
    assert.ok(lines.length <= 12);
    assert.ok(lines.every(line => measure(line).width <= 40), JSON.stringify(lines));
    seen += '\n' + lines.join('\n');
  }
  for (const value of ['29,135,711', '278,512', '29,134,657']) assert.ok(seen.includes(value), value);
  assert.doesNotMatch(seen, /claude-sonnet|Mixed session format|\/synthetic/);
  await term.key('\x1b[C');
  assert.match(current().join('\n'), /No projects data available/);
  await term.key('\x1b[C');
  assert.match(current().join('\n'), /No dates data available/);
  await term.key('\x1b[C');
  let models = current().join('\n');
  for (let i = 0; i < 20; i++) { await term.key('j'); models += '\n' + current().join('\n'); }
  assert.match(models, /claude-sonnet/);
  assert.match(models, /other-model/);
  assert.match(models, /—/);
  await term.key('\x1b'); await answer;
  assert.equal(current().join('').trim(), '');
});

test('tabbed report abort restores input, cursor and resize listeners', async t => {
  const term = await terminal(t), listeners = process.stdout.listenerCount('resize');
  const answer = pager({ message: 'Usage breakdown', pages: [] }, term.context);
  const rejected = assert.rejects(answer, { name: 'AbortPromptError' });
  term.abort(); await rejected;
  assert.equal(term.context.input.listenerCount('keypress'), 0);
  assert.equal(process.stdout.listenerCount('resize'), listeners);
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('Details groups fields by parent, totals disjoint values and keeps duplicate images separate', () => {
  const nodes = detailNodes(sampleReport()), fields = nodes[1];
  assert.equal(fields.bytes, 652);
  assert.equal(fields.children?.length, 2);
  const group = fields.children![0];
  assert.equal(group.name, 'wireToolInputs'); assert.equal(group.bytes, 602);
  assert.deepEqual(group.children?.map(node => [node.name, node.bytes]), [['a', 500], ['b', 100], ['(other values)', 2]]);
  assert.match(group.children![0].detail!, /10 occurrences/);
  assert.equal(nodes[0].bytes, undefined, 'duplicate image candidates must not inflate a group total');
  assert.deepEqual(nodes[2].children?.map(node => node.name), ['assistant', 'user']);
  assert.equal(nodes[3].children![0].name, 'Mixed session format versions');
  assert.equal(nodes[3].children![0].detail, sampleReport().warnings[0]);
});

test('Details tree expands, collapses and moves to parents without printing all fields', async t => {
  const term = await terminal(t), listeners = process.stdout.listenerCount('resize');
  const answer = tree({ message: 'Details', nodes: detailNodes(sampleReport()) }, term.context);
  const current = () => stripVTControlCharacters(term.text());
  assert.match(current(), /▸ Field sizes/); assert.doesNotMatch(current(), /wireToolInputs/);
  const press = async (key: string) => {
    const from = term.text().length; await term.key(key); return stripVTControlCharacters(term.text().slice(from));
  };
  await press('j');
  assert.match(await press('\x1b[C'), /▸ wireToolInputs/);
  await press('\x1b[C');
  assert.match(await press('\r'), /· a\s+500 B/);
  await press('j');
  assert.match(await press('\x1b[D'), /➤\s+▾ wireToolInputs/);
  assert.doesNotMatch(await press('\x1b[D'), /· a\s/);
  await press('\x1b[D');
  assert.doesNotMatch(await press('\x1b[D'), /wireToolInputs/);
  await press('q'); await answer;
  assert.equal(process.stdout.listenerCount('resize'), listeners);
  assert.equal(term.context.input.listenerCount('keypress'), 0);
});

test('tree pages long groups, adapts to resize and opens scrollable full notes', async t => {
  const term = await terminal(t);
  const dimensions = { columns: 49, rows: 18 };
  for (const [key, value] of Object.entries(dimensions)) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
    Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else Reflect.deleteProperty(process.stdout, key); });
  }
  const answer = tree({ message: 'Details', nodes: [{ name: 'Fields', children: Array.from({ length: 100 }, (_, i) => ({ name: `Field ${i}`, bytes: i })) },
    { name: 'Long note', detail: 'Full note: ' + '/项目/👨‍👩‍👧‍👦/long-path'.repeat(100) + ' END OF NOTE' }], }, term.context);
  void answer.catch(() => {});
  const press = async (key: string) => {
    const from = term.text().length; await term.key(key); return stripVTControlCharacters(term.text().slice(from));
  };
  await press('\x1b[C');
  assert.match(await press('\x1b[6~'), /Field [1-9]/);
  await press('\x1b[F'); // End selects the note after all fields.
  assert.match(await press('\r'), /Full note:/);
  process.stdout.columns = 41; process.stdout.emit('resize'); await setImmediate();
  const end = await press('\x1b[F');
  assert.match(end, /END\s+OF NOTE/);
  assert.ok(end.split('\n').every(line => measure(line).width <= 40));
  assert.match(await press('q'), /Long note/);
  await press('q'); await answer;
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('tree abort restores input, cursor and resize listeners', async t => {
  const term = await terminal(t), listeners = process.stdout.listenerCount('resize');
  const answer = tree({ message: 'Details', nodes: [] }, term.context);
  const rejected = assert.rejects(answer, { name: 'AbortPromptError' });
  term.abort(); await rejected;
  assert.equal(term.context.input.listenerCount('keypress'), 0);
  assert.equal(process.stdout.listenerCount('resize'), listeners);
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('activity and estimate progress draw a bar from item counts', async t => {
  const term = await terminal(t);
  await withProgress({ message: 'Deep Scan Before Cleanup' }, async (_signal, update) => {
    update({ phase: 'activity', completed: 250, total: 1000 });
    await setTimeout(120);
    const activity = stripVTControlCharacters(term.text());
    assert.match(activity, /Checking for open sessions…/);
    assert.match(activity, /250 \/ 1000 candidate paths checked/);
    assert.match(activity, /█+░+\s+25\.0%/);
    assert.doesNotMatch(activity, / B \/ /);
    update({ phase: 'estimating', completed: 1, total: 2 });
    await setTimeout(120);
    assert.match(stripVTControlCharacters(term.text()), /50\.0%/);
  }, term.context);
});

test('scan progress shows counts, returns results, and propagates failures', async t => {
  const term = await terminal(t);
  const value = await withProgress({ message: 'Deep Scan' }, async (_signal, update) => {
    update({ phase: 'sessions', completed: 3, total: 10, processedBytes: 1024, totalBytes: 4096, currentFile: 'projects/test.jsonl' });
    await setTimeout(120);
    return 42;
  }, term.context);
  assert.equal(value, 42);
  const text = stripVTControlCharacters(term.text());
  assert.match(text, /3 \/ 10/);
  assert.match(text, /1\.00 KiB \/ 4\.00 KiB/);
  assert.match(text, /projects\/test\.jsonl/);
  await assert.rejects(withProgress({ message: 'Deep Scan' }, async () => { throw new Error('read failed'); }, term.context), /read failed/);
  assert.ok(term.text().includes('\x1b[?25h'));
});

for (const [name, key] of [['Q', 'q'], ['Esc', '\x1b'], ['Ctrl+C', '\x03']]) {
  test(`scan ${name} cancellation waits for work to stop and leaves the menu usable`, { timeout: 3000 }, async t => {
    const term = await terminal(t);
    let stopped = false;
    const answer = withProgress({ message: 'Deep Scan' }, async (signal, update) => {
      update({ phase: 'sessions', completed: 0, total: 100 });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await setTimeout(20);
      stopped = true;
      return 'partial';
    }, term.context);
    await setImmediate(); await term.key(key);
    assert.equal(await answer, null);
    assert.equal(stopped, true);
    assert.equal(term.context.signal.aborted, false);
    assert.equal(term.context.input.listenerCount('keypress'), 0);
    const next = select({ message: 'Choose', choices }, term.context);
    await term.key('2'); assert.equal(await next, 'beta');
  });
}

test('parent abort stops the scan and restores the terminal', async t => {
  const term = await terminal(t);
  let stopped = false;
  const answer = withProgress({ message: 'Deep Scan' }, async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    stopped = true;
  }, term.context);
  const rejected = assert.rejects(answer, { name: 'AbortPromptError' });
  await setImmediate(); term.abort(); await rejected;
  assert.equal(stopped, true);
  assert.equal(term.context.input.listenerCount('keypress'), 0);
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('storage rows align percentages, relative bars and sizes without clipping wide text', () => {
  const row = storageRow({ name: 'projects/', bytes: 750 }, { width: 79, total: 1000, max: 750, color: false });
  assert.match(row, /█+\s+75\.0%  \|  projects\/\s+750 B$/);
  assert.equal(measure(row).width, 79);
  const smaller = storageRow({ name: 'logs/', bytes: 250 }, { width: 79, total: 1000, max: 750, color: false });
  assert.ok((row.match(/█/g)?.length ?? 0) > (smaller.match(/█/g)?.length ?? 0));
  for (const width of [1, 12, 35, 59, 79, 119]) {
    const rendered = storageRow({ name: '/项目/👨‍👩‍👧‍👦/a-very-long-project-name/'.repeat(3), bytes: 1024 }, { width, total: 2048, max: 1024, color: false });
    assert.ok(measure(rendered).width <= width, `${width}: ${rendered}`);
    assert.doesNotMatch(rendered, /\x1b|\n|\r/);
    if (width >= 35) assert.match(rendered, /1\.00 KiB$/);
  }
  const empty = storageRow({ name: 'empty', bytes: 0 }, { width: 79, total: 0, max: 0, color: false });
  assert.match(empty, /0\.0%/); assert.doesNotMatch(empty, /NaN|Infinity|█/);
});

test('Unicode clipping and output sanitization preserve text and reject terminal controls', () => {
  assert.equal(fit('项目文件', 5), '项目…');
  assert.equal(fit('👨‍👩‍👧‍👦abc', 4), '👨‍👩‍👧‍👦a…');
  assert.equal(fit('hello', 0), '');
  assert.equal(fit('long-folder/项目文件', 7, true), '…目文件');
  assert.equal(fit('long-folder/👨‍👩‍👧‍👦abc', 6, true), '…👨‍👩‍👧‍👦abc');
  assert.equal(fit('hello', 0, true), '');
  assert.ok(measure(fit('99–102 / 102 items · Compress PNG (lossless)', 30)).width <= 30);
  assert.equal(safe('\x1b[31m项目\x1b[0m\n\u202eevil'), '项目  evil');
  assert.equal(paint('cyan', '\x1b[2Jfile', false), 'file');
  const row = menuRow({ name: '\x1b[2JUntrusted\nname', value: 1 }, 0, true, 79, { total: 0, max: 0, labelWidth: 15, color: true });
  assert.match(row, /^\x1b\[36m/);
  assert.doesNotMatch(row, /\x1b\[2J|\n/);
  assert.match(stripVTControlCharacters(row), /➤\s+1\. Untrusted name/);
});

test('numbered menu supports arrows, Vim navigation and direct numeric selection', async t => {
  const term = await terminal(t);
  let answer = select({ message: 'Choose', choices }, term.context);
  assert.match(stripVTControlCharacters(term.text()), /➤\s+1\. Alpha/);
  await term.key('\x1b[B'); await term.key('\r');
  assert.equal(await answer, 'beta');
  answer = select({ message: 'Choose', choices }, term.context);
  await term.key('j'); await term.key('k'); await term.key('\r');
  assert.equal(await answer, 'alpha');
  answer = select({ message: 'Choose', choices }, term.context);
  await term.key('3'); assert.equal(await answer, 'query');
  assert.ok(term.text().includes('\x1b[?25h'), 'cursor restored after prompt');
});

test('menus show descriptions once and reserve the footer for additional details', async t => {
  const term = await terminal(t);
  const answer = select({ message: 'Choose', choices: [{ ...choices[0], detail: 'Additional context' }, choices[1]] }, term.context);
  const text = stripVTControlCharacters(term.text());
  assert.equal(text.match(/First item/g)?.length, 1);
  assert.equal(text.match(/Additional context/g)?.length, 1);
  await term.key('q'); await answer;
});

test('merged analysis reuses snapshots and shares persistent caches with session insights', { timeout: 10000 }, async t => {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output], ['stderr', term.context.output]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, value });
    t.after(() => Object.defineProperty(process, name, descriptor));
  }
  t.mock.method(console, 'log', (...args: unknown[]) => term.context.output.write(args.join(' ') + '\n'));
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-menu-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'claude'), project = join(root, 'projects/p');
  await mkdir(project, { recursive: true });
  const transcript = (id: string, tokens: number) => [
    { type: 'user', sessionId: id, cwd: '/project', uuid: id, message: { content: 'synthetic' } },
    { type: 'assistant', message: { id, model: 'test', usage: { input_tokens: tokens, output_tokens: 2 } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(join(project, 'one.jsonl'), transcript('one', 7));
  await writeFile(join(project, 'two.jsonl'), transcript('two', 11));
  const config = { roots: { claude: root, codex: join(base, 'codex') }, stateDir: join(base, 'state') };
  const cache = join(config.stateDir, 'providers/claude/cache');
  const entries = async () => new Map(await Promise.all((await readdir(cache)).map(async name => [name, (await stat(join(cache, name))).ino] as const)));
  const waitFor = async (pattern: RegExp, from = 0) => {
    for (let i = 0; i < 300; i++) {
      const text = stripVTControlCharacters(term.text().slice(from));
      if (pattern.test(text)) return text;
      await setTimeout(10);
    }
    assert.fail(`Missing ${pattern}: ${stripVTControlCharacters(term.text().slice(from))}`);
  };
  const press = async (key: string, pattern: RegExp) => {
    const from = term.text().length;
    await term.key(key);
    return waitFor(pattern, from);
  };
  const running = analysisMenu(config, 'claude', term.context.signal);
  void running.catch(() => {});
  const home = await waitFor(/3\. Insights/);
  assert.match(home, /1\. Storage/);
  assert.match(home, /2\. Projects/);
  assert.doesNotMatch(home, /\d\. (Sessions|Compression|Select files|Back)/);
  await press('2', /All sessions/);
  await press('1', /sorted by size/);
  await press('1', /Analyze Sessions/);
  await press('1', /Preview deletion/); // Opens the session; never selects deletion.
  assert.equal((await entries()).size, 2, 'project browsing caches metadata');
  const session = await press('1', /Usage breakdown/);
  assert.doesNotMatch(session, /Field sizes|Record types|Parsed \d/);
  const sessionCache = await entries();
  assert.equal(sessionCache.size, 3, 'session insights persist their deep parse');
  const snapshotStart = term.text().length;
  await press('2', /Field sizes/);
  await press('q', /Usage breakdown/);
  const usagePage = await press('1', /Input tokens/);
  assert.match(usagePage, /\[Overview\]/);
  assert.doesNotMatch(usagePage, /By project|By date|By model|Continue/);
  await press('\x1b[C', /\[Projects\]/);
  await press('\x1b[C', /\[Dates\]/);
  await press('\x1b[C', /\[Models\]/);
  await press('q', /Usage breakdown/);
  assert.doesNotMatch(term.text().slice(snapshotStart), /Deep Scan/, 'report views share one scan');
  await press('q', /Preview deletion/);
  await press('q', /sorted by size/);
  await press('q', /Analyze Storage/);
  await press('3', /Usage breakdown/);
  const fullCache = await entries();
  assert.equal(fullCache.size, 4);
  for (const [name, ino] of sessionCache) assert.equal(fullCache.get(name), ino, 'full analysis reuses session caches');
  // The open report remains one snapshot; Refresh incorporates changed files.
  await writeFile(join(project, 'two.jsonl'), transcript('two', 21));
  assert.match(await press('1', /Input tokens/), /Total\s+2\s+0\s+18\s+4/);
  await press('q', /Usage breakdown/);
  assert.match(await press('3', /Usage breakdown/), /28 input/);
  const refreshedCache = await entries();
  assert.equal(refreshedCache.size, 5, 'only the changed file needs a new parse');
  for (const [name, ino] of fullCache) assert.equal(refreshedCache.get(name), ino);
  await press('q', /Analyze Storage/);
  await press('3', /Usage breakdown/);
  assert.deepEqual(await entries(), refreshedCache, 'reopening reuses persisted results');
  await press('q', /Analyze Storage/);
  await term.key('q'); await running;

  const main = menu(config, term.context.signal);
  void main.catch(() => {});
  const clean = await press('1', /Select files/);
  assert.match(clean, /Quick clean/);
  assert.match(clean, /Slim history \+ file cleanup \(irreversible\)/);
  assert.doesNotMatch(clean, /Scanning|Preview only|Confirmed reduction/);
  await press('q', /cc-clean/);
  const stats = await press('3', /No cleanup history yet/);
  assert.match(stats, /Total space saved\s+0 B/);
  assert.doesNotMatch(stats, /Application overhead|Shared overhead|Net savings|−/);
  await press('/', /Filter:/);
  await press('missing', /No matching items/);
  await press('\x1b', /No cleanup history yet/);
  await press('q', /cc-clean/);
  await term.key('q'); await main;
  assert.equal(await readdir(join(config.stateDir, 'providers/claude')).then(names => names.includes('operations')), false);
  assert.equal((await readdir(config.stateDir)).includes('cleanup.jsonl'), false);
});

test('filter accepts q, digits, spaces and Unicode without activating menu shortcuts', async t => {
  const term = await terminal(t);
  const answer = select({ message: 'Browse', choices, searchable: true }, term.context);
  await term.key('/'); await term.key('query 42 项目');
  assert.match(stripVTControlCharacters(term.text()), /Filter: query 42 项目▌/);
  await term.key('\r'); await term.key('\r');
  assert.equal(await answer, 'query');
});

test('empty filters can be cleared and Escape or Q cancels safely', async t => {
  const term = await terminal(t);
  let answer = select({ message: 'Browse', choices, searchable: true }, term.context);
  await term.key('/'); await term.key('missing'); await term.key('\r');
  assert.match(stripVTControlCharacters(term.text()), /No matching items/);
  await term.key('\r'); // No match must not select the previous item.
  await term.key('/'); await term.key('\x1b');
  await term.key('2'); assert.equal(await answer, 'beta');
  for (const key of ['q', '\x1b', '\x1b[D']) {
    answer = select({ message: 'Browse', choices }, term.context);
    await term.key(key); assert.equal(await answer, null);
  }
});

test('multi-selection survives filtering and Escape discards pending selections', async t => {
  const term = await terminal(t);
  let answer = checkbox({ message: 'Select inert items', choices }, term.context);
  await term.key(' '); await term.key('/'); await term.key('beta'); await term.key('\r'); await term.key(' ');
  await term.key('\r'); assert.deepEqual(await answer, ['alpha', 'beta']);
  answer = checkbox({ message: 'Select inert items', choices }, term.context);
  await term.key(' '); await term.key('q'); assert.deepEqual(await answer, []);
  answer = checkbox({ message: 'Select inert items', choices }, term.context);
  await term.key('\r'); assert.deepEqual(await answer, []);
});

test('pagination reaches off-screen entries and terminal resize keeps the active item', async t => {
  const term = await terminal(t), count = process.stdout.listenerCount('resize');
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i}`, value: i }));
  const answer = select({ message: 'Browse', choices: many, searchable: true }, term.context);
  await term.key('\x1b[6~'); // Page down.
  assert.match(stripVTControlCharacters(term.text()), /15–28/);
  await term.key('\x1b[F'); // End.
  process.stdout.emit('resize'); await setImmediate();
  await term.key('\r'); assert.equal(await answer, 49);
  assert.equal(process.stdout.listenerCount('resize'), count);
});

function inertPlan(): Plan {
  return {
    schemaVersion: 1, operationId: 'inert', provider: 'codex', root: '/inert/codex', version: 'unknown',
    source: 'clean', startedAt: '2026-11-08T00:00:00.000Z', scanComplete: true, warnings: [],
    actions: [{ id: 'inert-image', kind: 'compress-png', targetId: 'generated_images/图片.png',
      files: [{ path: '/inert/codex/generated_images/图片.png', relative: 'generated_images/图片.png', size: 4096,
        allocatedBytes: 4096, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0, nlink: 1, mode: 0, category: 'images' }],
      beforeBytes: 4096, afterBytes: 4096, estimatedSavingsBytes: 1024, status: 'planned', recoveryState: 'prepared' }],
  };
}

function interruptedReceipt(): Receipt {
  const p = inertPlan(), base = p.actions[0];
  const action = (i: number, status: Receipt['actions'][number]['status'], recoveryState: Receipt['actions'][number]['recoveryState'], reason?: string) => ({
    ...base, id: `action-${i}`, targetId: `sessions/private-${i}.jsonl`, status, recoveryState, reason,
  });
  const busy = 'Cannot reliably associate every Claude client or service with its idle open session; provider retained';
  return { ...p, provider: 'claude', root: '/inert/claude', status: 'needs-review',
    rootBeforeBytes: 100000, rootAfterBytes: 90000, confirmedReductionBytes: 0, attributionComplete: false,
    warnings: [busy, busy, ...Array.from({ length: 200 }, (_, i) => `sessions/private-${i}.jsonl: unknown format`)],
    actions: [
      ...Array.from({ length: 15 }, (_, i) => action(i, 'completed', 'finalized')),
      action(15, 'completed', 'applied', busy),
      action(16, 'skipped', 'finalized', busy), action(17, 'skipped', 'finalized', busy),
      ...Array.from({ length: 465 }, (_, i) => action(i + 18, 'skipped', 'finalized', 'Operation stopped')),
    ],
  };
}

test('interrupted results distinguish unfinished work and group reasons without dumping paths', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  printReceipts([interruptedReceipt()]);
  const output = stripVTControlCharacters(lines.join('\n'));
  for (const [label, count] of [['Completed', 15], ['Pending finalization', 1], ['Not started', 465], ['Skipped', 2]])
    assert.match(output, new RegExp(`${label}: ${count} items`));
  assert.match(output, /Cannot reliably associate/);
  assert.match(output, /Activity reasons above are from the last check/);
  assert.match(output, /checks individual sessions again/);
  assert.doesNotMatch(output, /Close the affected clients/);
  assert.match(output, /View details/);
  assert.doesNotMatch(output, /private-\d+|completed: 16|skipped: 467/);
  assert.ok(lines.length < 35, `Expected compact output, got ${lines.length} lines`);
});

test('shared results distinguish unstarted entries from interrupted and unknown file changes', t => {
  const lines: string[] = [], p = inertPlan(), base = { ...p.actions[0], kind: 'deduplicate-history' as const };
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const shared = { homes: [], groups: [base.files], compressedLinks: [] };
  printReceipts([{ ...interruptedReceipt(), ...p, actions: [
    { ...base, codexShared: shared },
    { ...base, codexShared: { ...shared, started: false } },
    { ...base, codexShared: { ...shared, started: true } },
    { ...base, codexShared: { ...shared, started: true }, status: 'completed', recoveryState: 'finalized' },
    { ...base, codexShared: shared, status: 'skipped', recoveryState: 'finalized' },
    base, // Without a start marker, prepared alone cannot prove that no mutation occurred.
  ] }]);
  const output = stripVTControlCharacters(lines.join('\n'));
  for (const [label, count] of [['Completed', 1], ['Pending finalization', 2], ['Not started', 2], ['Skipped', 1]])
    assert.match(output, new RegExp(`${label}: ${count} items`));
  assert.match(output, /Continue rechecks safety/);
});

test('unfinished results explain why the after-size is unknown', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  printReceipts([{ ...interruptedReceipt(), rootAfterBytes: null }]);
  const unmeasured = stripVTControlCharacters(lines.join('\n'));
  assert.match(unmeasured, /unknown\s+Directory after/);
  assert.match(unmeasured, /Directory after and change are unknown: this cleanup stopped before its final size measurement/);
  lines.length = 0;
  printReceipts([{ ...interruptedReceipt(), rootAfterBytes: null, attributionComplete: true, confirmedReductionBytes: 10000 }]);
  const derived = stripVTControlCharacters(lines.join('\n'));
  assert.match(derived, /87\.89 KiB\s+Directory after/);
  assert.match(derived, /9\.77 KiB\s+Directory change/);
  assert.match(derived, /Directory after and change are derived from Confirmed reduction/);
  lines.length = 0;
  printReceipts([interruptedReceipt()]);
  assert.doesNotMatch(stripVTControlCharacters(lines.join('\n')), /stopped before its final size measurement/);
});

async function cleanupTerminal(t: test.TestContext) {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output], ['stderr', term.context.output]] as const) {
    const original = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  t.mock.method(console, 'log', (...args: unknown[]) => term.context.output.write(args.join(' ') + '\n'));
  return { ...term, waitFor: async (pattern: RegExp, from = 0) => {
    for (let i = 0; i < 100; i++) {
      const output = stripVTControlCharacters(term.text().slice(from));
      if (pattern.test(output)) return output;
      await setTimeout(5);
    }
    assert.fail(`Missing ${pattern}`);
  } };
}
const cleanupConfig = { roots: { claude: '/inert/claude', codex: '/inert/codex' }, stateDir: '/inert/state' };
function cleanupStats(receipts: Receipt[] = []) {
  const provider = (name: string) => ({ savedBytes: 0, cleanedRecords: 0, pending: receipts.length,
    operations: [], pendingOperations: receipts.filter(r => r.provider === name) });
  return { schemaVersion: 2 as const, providers: { claude: provider('claude'), codex: provider('codex') }, savedBytes: 0, cleanedRecords: 0 };
}
function finalizedReceipt(r: Receipt): Receipt {
  return { ...r, status: 'interrupted', rootAfterBytes: null, attributionComplete: false,
    actions: r.actions.map(a => ({ ...a, recoveryState: 'finalized' })) };
}

test('recovery details show shared Codex aliases, coordinated homes and compressed links', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t), p = inertPlan(), base = p.actions[0];
  Object.defineProperty(term.context.output, 'rows', { value: 40 });
  const primary = { ...base.files[0], path: '/inert/codex/sessions/a.jsonl', relative: 'sessions/a.jsonl', category: 'sessions', nlink: 2 };
  const alias = { ...primary, path: '/inert/orca-codex/sessions/a.jsonl' };
  const compressed = { ...primary, path: `${primary.path}.zst`, relative: `${primary.relative}.zst`, ino: 1, nlink: 1 };
  const r: Receipt = { ...interruptedReceipt(), ...p, actions: [{ ...base,
    kind: 'deduplicate-history', targetId: primary.relative, status: 'completed', recoveryState: 'applied',
    files: [primary, compressed], codexProjection: [], codexShared: {
      homes: [{ root: p.root, dev: 0, ino: 2, codexProjection: [] }, { root: '/inert/orca-codex', dev: 0, ino: 3, codexProjection: [] }],
      groups: [[primary, alias], [compressed]], compressedLinks: ['/inert/orca-codex/sessions/a.jsonl.zst'],
    },
  }] };
  const original = structuredClone(r);
  const running = cleanupResults(cleanupConfig, [r], true, term.context.signal, async () => { assert.fail('details must not recover'); });
  await term.waitFor(/Cleanup results/);
  const from = term.text().length;
  await term.key('2'); await term.key('\r');
  const output = await term.waitFor(/Cleanup details/, from);
  await term.key('q'); await term.key('q'); await running;
  for (const path of ['/inert/codex/sessions/a.jsonl', '/inert/orca-codex/sessions/a.jsonl',
    '/inert/codex/sessions/a.jsonl.zst', '/inert/orca-codex/sessions/a.jsonl.zst'])
    assert.ok(output.includes(path), `Missing shared path: ${path}`);
  assert.match(output, /Coordinated Codex homes:\s+\/inert\/codex\s+\/inert\/orca-codex/);
  assert.match(output, /Create compressed hard links before removing originals:/);
  assert.deepEqual(r, original, 'viewing details must not mutate the receipt');
});

test('Continue needs Enter confirmation, keeps blocked recovery visible and only retries after finalization', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t), original = interruptedReceipt();
  let calls = 0;
  const running = cleanupResults(cleanupConfig, [original], true, term.context.signal, async (stateDir, check, ids) => {
    assert.equal(stateDir, cleanupConfig.stateDir); assert.equal(check, undefined);
    assert.deepEqual(ids, [original.operationId], 'recovery is limited to the displayed operation');
    return [++calls === 1 ? original : finalizedReceipt(original)];
  });
  await term.waitFor(/Cleanup results/);
  assert.doesNotMatch(stripVTControlCharacters(term.text()), /\d\. Retry/);
  await term.key('1'); assert.equal(calls, 0);
  await term.key('\r'); await term.waitFor(/Confirm recovery/);
  await term.key('1'); assert.equal(calls, 0);
  await term.key('q'); assert.equal(calls, 0, 'cancelling confirmation does not recover');
  await term.key('\r'); await term.key('\r');
  assert.equal(calls, 1);
  let from = term.text().length;
  await term.key('\r'); await term.key('\r');
  const recovered = await term.waitFor(/1\. Retry/, from);
  assert.equal(calls, 2);
  assert.doesNotMatch(recovered, /\d\. Continue/);
  assert.match(recovered, /Savings need review; no unfinished file changes remain/);
  await term.key('2'); await term.key('\r');
  await term.waitFor(/Cleanup details/);
  assert.match(stripVTControlCharacters(term.text()), /sessions\/private-0\.jsonl/);
  await term.key('q'); await term.key('1'); await term.key('\r');
  assert.deepEqual(await running, [finalizedReceipt(original)]);
});

test('Continue finalizes an interrupted receipt even when all file changes are finalized', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t);
  const r: Receipt = { ...finalizedReceipt(interruptedReceipt()), status: 'needs-review', executionStartedAt: inertPlan().startedAt };
  const recovered: Receipt = { ...r, status: 'interrupted', finishedAt: r.executionStartedAt };
  let calls = 0;
  const running = cleanupResults(cleanupConfig, [r], true, term.context.signal, async (_stateDir, _check, ids) => {
    calls++; assert.deepEqual(ids, [r.operationId]); return [recovered];
  });
  const initial = await term.waitFor(/1\. Continue/);
  assert.doesNotMatch(initial, /\d\. Retry/);
  await term.key('\r'); await term.waitFor(/Confirm recovery/);
  assert.equal(calls, 0);
  const from = term.text().length;
  await term.key('\r');
  const output = await term.waitFor(/1\. Retry/, from);
  assert.equal(calls, 1); assert.doesNotMatch(output, /\d\. Continue/);
  await term.key('\r'); assert.deepEqual(await running, [recovered]);
});

test('a finished savings-only review allows Retry without file recovery', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t);
  const r: Receipt = { ...finalizedReceipt(interruptedReceipt()), executionStartedAt: inertPlan().startedAt, finishedAt: inertPlan().startedAt };
  const running = cleanupResults(cleanupConfig, [r], true, term.context.signal, async () => { assert.fail('no file recovery needed'); });
  const output = await term.waitFor(/1\. Retry/);
  assert.doesNotMatch(output, /\d\. Continue/);
  assert.match(output, /Savings need review; no unfinished file changes remain/);
  await term.key('\r'); assert.deepEqual(await running, [r]);
});

test('Retry rebuilds the original selection and requires confirmation for the fresh plan', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t), first = { ...inertPlan(), explicitTarget: '/inert/selected.png' };
  const fresh = { ...first, operationId: 'fresh', actions: first.actions.map(a => ({ ...a, beforeBytes: 2048 })) };
  let scans = 0;
  const executed: Plan[][] = [];
  const running = runSelection(cleanupConfig, [first], term.context.signal, async () => { scans++; return [fresh]; }, {
    readStats: async () => cleanupStats(),
    recoverOperations: async () => { assert.fail('no recovery expected'); },
    execute: async (_config, plans, dryRun, _signal, progress) => {
      assert.equal(dryRun, false); executed.push(plans); progress?.('private path must not be printed');
      return { schemaVersion: 1, receipts: plans.map(p => ({ ...p, status: 'interrupted', rootBeforeBytes: 4096, rootAfterBytes: 4096,
        confirmedReductionBytes: 0, attributionComplete: true,
        actions: p.actions.map(a => ({ ...a, status: 'skipped', recoveryState: 'finalized', reason: 'Operation stopped' })) })) };
    },
  });
  await term.waitFor(/Review cleanup/); assert.equal(executed.length, 0);
  await term.key('\r'); await term.waitFor(/1\. Retry/);
  await term.key('1'); assert.equal(scans, 0);
  const from = term.text().length;
  await term.key('\r'); await term.waitFor(/Review cleanup/, from);
  assert.equal(scans, 1); assert.equal(executed.length, 1);
  await term.key('1'); assert.equal(executed.length, 1);
  await term.key('\r'); await term.waitFor(/Cleanup results/, from);
  await term.key('q'); await running;
  assert.equal(executed.length, 2);
  assert.equal(executed[1][0], fresh);
  assert.equal(executed[1][0].explicitTarget, first.explicitTarget);
  assert.doesNotMatch(stripVTControlCharacters(term.text()), /private path must not be printed/);
});

test('cancelling cleanup keeps its returned receipt and never automatically rescans', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t), r = interruptedReceipt();
  let started = false;
  const running = runSelection(cleanupConfig, [r], term.context.signal, async () => { assert.fail('cancellation must not rescan'); }, {
    readStats: async () => cleanupStats(), recoverOperations: async () => { assert.fail('no automatic recovery'); },
    execute: async (_config, _plans, _dryRun, signal) => {
      started = true;
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { schemaVersion: 1, receipts: [r] };
    },
  });
  await term.waitFor(/Review cleanup/); await term.key('\r');
  for (let i = 0; !started && i < 100; i++) await setTimeout(5);
  assert.equal(started, true);
  await term.key('q'); await term.waitFor(/Pending finalization: 1 items/);
  assert.match(stripVTControlCharacters(term.text()), /1\. Continue/);
  await term.key('q'); await running;
});

for (const [name, key] of [['Q', 'q'], ['Esc', '\x1b'], ['Ctrl+C', '\x03']]) {
  test(`cleanup ${name} cancellation surfaces execution failures and reloads pending recovery`, { timeout: 5000 }, async t => {
    const term = await cleanupTerminal(t), p = inertPlan(), started = Promise.withResolvers<void>();
    const pending: Receipt = { ...interruptedReceipt(), ...p,
      actions: p.actions.map(a => ({ ...a, status: 'completed', recoveryState: 'applied' })) };
    let reads = 0;
    const running = runSelection(cleanupConfig, [p], term.context.signal, async () => { assert.fail('failure must not rescan'); }, {
      readStats: async () => cleanupStats(++reads === 1 ? [] : [pending]),
      recoverOperations: async () => { assert.fail('failure must not automatically recover'); },
      execute: async (_config, _plans, _dryRun, signal) => {
        started.resolve();
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('Synthetic receipt persistence failure');
      },
    });
    await term.waitFor(/Review cleanup/); await term.key('\r'); await started.promise;
    const from = term.text().length;
    await term.key(key);
    const output = await term.waitFor(/Cleanup results/, from);
    await term.key('q'); await running;
    assert.match(output, /Cleanup stopped: Synthetic receipt persistence failure/);
    assert.match(output, /Pending finalization: 1 items/);
    assert.match(output, /1\. Continue/);
    assert.doesNotMatch(output, /\d\. Retry|additional planned items were not started/);
    assert.equal(reads, 2);
  });
}

test('cancelling before any receipt is returned remains an interruption', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t);
  const running = executeCleanup(cleanupConfig, [inertPlan()], term.context.signal, async (_config, _plans, _dryRun, signal) => {
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    return { schemaVersion: 1, receipts: [] };
  });
  await term.waitFor(/Applying cleanup/);
  await term.key('q');
  assert.deepEqual(await running, { schemaVersion: 1, receipts: [], cancelled: true });
});

test('pending recovery remains accessible with an empty plan and recovery failures do not start new work', { timeout: 5000 }, async t => {
  const term = await cleanupTerminal(t), r = interruptedReceipt();
  const running = runSelection(cleanupConfig, [{ ...r, actions: [] }], term.context.signal, async () => { assert.fail('blocked recovery must not replan'); }, {
    readStats: async () => cleanupStats([r]), execute: async () => { assert.fail('blocked recovery must not execute'); },
    recoverOperations: async () => { throw new Error('Synthetic recovery failure'); },
  });
  const saved = await term.waitFor(/Cleanup results/);
  // The page must not read as the estimate from the scan that just finished.
  assert.match(saved, /An earlier cleanup needs review before a new cleanup can start[^]*saved results, not an estimate from the scan that just ran[^]*Confirmed reduction/);
  await term.key('\r'); await term.key('\r');
  const output = await term.waitFor(/Could not continue: Synthetic recovery failure/);
  assert.doesNotMatch(output, /\d\. Retry|No cleanup items/);
  await term.key('q'); await running;
});

test('selected-file retries exclude completed deletions cumulatively and retain bulk protection', async () => {
  const p = inertPlan(), paths = ['a', 'b', 'c'].map(name => `${p.root}/${name}`);
  const receipt: Receipt = { ...finalizedReceipt(interruptedReceipt()), provider: p.provider, root: p.root,
    actions: paths.map(path => ({ ...p.actions[0], kind: 'delete-files', status: 'completed', recoveryState: 'finalized',
      files: [{ ...p.actions[0].files[0], path }] })) };
  const options = { files: paths, manual: true, deleteImages: true };
  const seen: unknown[] = [];
  const reload = selectedPlanLoader(cleanupConfig, p.provider, options, undefined, async (_config, _provider, selected) => {
    seen.push(structuredClone(selected)); return p;
  });
  assert.deepEqual(await reload(), [p]);
  await reload([{ ...receipt, actions: receipt.actions.slice(0, 1) }]);
  await reload([{ ...receipt, actions: receipt.actions.slice(1, 2) }]);
  assert.deepEqual(seen, [paths, paths.slice(1), paths.slice(2)].map(files => ({
    ...options, files, sessions: undefined, bulkSelection: true,
  })));
  assert.deepEqual(await reload([{ ...receipt, actions: receipt.actions.slice(2) }]), []);
  assert.equal(seen.length, 3, 'exhausted selections must not scan the provider');
  assert.deepEqual(options.files, paths, 'original options are not mutated');
});

test('file retries retain unfinished, skipped, rewritten and unrelated targets', async () => {
  const p = inertPlan(), path = p.actions[0].files[0].path;
  const receipt: Receipt = { ...finalizedReceipt(interruptedReceipt()), provider: p.provider, root: p.root,
    actions: [{ ...p.actions[0], kind: 'delete-files', status: 'completed', recoveryState: 'finalized' }] };
  const variants: Receipt[] = [
    { ...receipt, actions: [{ ...receipt.actions[0], recoveryState: 'applied' }] },
    ...(['skipped', 'failed'] as const).map(status => ({ ...receipt, actions: [{ ...receipt.actions[0], status }] })),
    { ...receipt, actions: [{ ...receipt.actions[0], kind: 'slim-history' }] },
    { ...receipt, provider: 'claude' }, { ...receipt, root: '/inert/other-home' },
  ];
  let scans = 0;
  const reload = selectedPlanLoader(cleanupConfig, p.provider, { files: [path], bulkSelection: true }, undefined,
    async (_config, _provider, selected) => {
      scans++; assert.deepEqual(selected?.files, [path]); assert.equal(selected?.bulkSelection, true); return p;
    });
  for (const r of variants) assert.deepEqual(await reload([r]), [p]);
  assert.equal(scans, variants.length);
});

test('session retries exclude finalized parent and child deletions without widening their scope', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const p = { ...inertPlan(), provider, root: cleanupConfig.roots[provider] };
    const receipt: Receipt = { ...finalizedReceipt(interruptedReceipt()), provider, root: p.root,
      actions: [{ ...p.actions[0], kind: provider === 'codex' ? 'codex-delete' : 'delete-files',
        status: 'completed', recoveryState: 'finalized', sessionIds: ['parent', 'child'] }] };
    let scans = 0;
    const reload = selectedPlanLoader(cleanupConfig, provider, { sessions: ['parent', 'child', 'other'], manual: true }, undefined,
      async (_config, _provider, selected) => {
        scans++; assert.deepEqual(selected?.sessions, ['other']); assert.equal(selected?.bulkSelection, true); return p;
      });
    assert.deepEqual(await reload([receipt]), [p]);
    assert.deepEqual(await reload([{ ...receipt, actions: [{ ...receipt.actions[0], sessionIds: ['other'] }] }]), []);
    assert.equal(scans, 1);
  }
});

test('retry after deduplication retains the compressed sibling and preserves single-target selection semantics', async () => {
  const p = inertPlan(), original = { ...p.actions[0].files[0], path: `${p.root}/one.jsonl` };
  const compressed = { ...original, path: original.path + '.zst' };
  const receipt: Receipt = { ...finalizedReceipt(interruptedReceipt()), provider: p.provider, root: p.root,
    actions: [{ ...p.actions[0], kind: 'deduplicate-history', status: 'completed', recoveryState: 'finalized', files: [original, compressed] }] };
  const reload = selectedPlanLoader(cleanupConfig, p.provider, { files: [original.path, compressed.path] }, undefined,
    async (_config, _provider, selected) => {
      assert.deepEqual(selected?.files, [compressed.path]); assert.equal(selected?.bulkSelection, true); return p;
    });
  assert.deepEqual(await reload([receipt]), [p]);
  const single = selectedPlanLoader(cleanupConfig, p.provider, { files: [compressed.path] }, undefined,
    async (_config, _provider, selected) => {
      assert.deepEqual(selected?.files, [compressed.path]); assert.equal(selected?.bulkSelection, false); return p;
    });
  assert.deepEqual(await single(), [p]);
});

test('cleanup summary shows all session bytes beside savings in both views, excluding temporary roots', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const first = { ...inertPlan(), totalSessionBytes: 8192 };
  const second = { ...inertPlan(), provider: 'claude' as const, totalSessionBytes: 16384 };
  const temporary = { ...inertPlan(), systemTemp: { uid: 501, excludedRoots: [] }, totalSessionBytes: 65536 };
  for (const details of [false, true]) {
    lines.length = 0;
    printPlans([first, second, temporary], details);
    const text = lines.join('\n');
    assert.match(text, /24\.00 KiB\s+Total session size/);
    assert.match(text, /3\.00 KiB\s+Total estimated savings/);
    assert.equal(text.match(/Total session size/g)?.length, 1);
  }
  for (const totalSessionBytes of [undefined, null]) {
    lines.length = 0;
    printPlans([first, { ...second, totalSessionBytes }], false);
    assert.match(lines.join('\n'), /unknown\s+Total session size/);
  }
  lines.length = 0;
  printPlans([temporary], false);
  assert.doesNotMatch(lines.join('\n'), /Total session size/);
});

test('cleanup file rows group and rank savings, hide inactive effects and retain full details', () => {
  const p = { ...inertPlan(), provider: 'claude' as const, root: '/inert/claude' };
  const history = (id: string, project: string, savings: number): Plan['actions'][number] => ({
    ...p.actions[0], id, kind: 'slim-history', targetId: id, estimatedSavingsBytes: savings,
    files: [{ ...p.actions[0].files[0], path: `${p.root}/projects/${project}/${id}.jsonl` }],
    slimOptions: { removeImages: true, compactTools: true }, slimCounts: { images: 3, toolOutputs: 0 },
    slimSavingsBytes: { images: savings, toolOutputs: 0 },
  });
  p.actions = [history('358d0528-6479-412b-87a3-74339e26037c', 'small', 256),
    history('dc8434c2-7c80-4783-857c-f6ed5a7b550f', 'large', 2048),
    history('e8dee114-fa7f-43ad-a9ac-228115a3d60d', 'large', 1024)];
  const original = structuredClone(p);
  const [provider] = cleanupFileNodes([p, { ...p, actions: [] }]);
  assert.equal(provider.bytes, 3328);
  assert.equal(provider.expanded, true);
  assert.deepEqual(provider.children?.map(n => [n.name, n.bytes]), [['projects/large · 2 items', 3072], ['projects/small · 1 item', 256]]);
  const files = provider.children![0].children!;
  assert.equal(files[0].name, 'dc8434c2….jsonl · 3 images');
  assert.deepEqual(files.map(n => n.bytes), [2048, 1024]);
  assert.doesNotMatch(files[0].name + files[0].detail, /reasoning|outputs|yes|no/);
  assert.match(files[0].detail!, /Remove inline images: 3 · 2\.00 KiB/);
  assert.ok(files[0].detail!.includes(p.actions[1].files[0].path));
  assert.deepEqual(p, original, 'formatting must not mutate the plan');
});

test('compressed history details explain stored savings without changing the plan', () => {
  const p = inertPlan(), a = p.actions[0];
  p.actions = [{...a, kind: 'slim-history', estimatedSavingsBytes: 1024,
    files: [{...a.files[0], path: `${p.root}/sessions/history.jsonl.zst`}],
    slimOptions: {removeImages: true, compactTools: false, removeReasoning: true},
    slimCounts: {images: 2, toolOutputs: 0, reasoning: 3},
    slimSavingsBytes: {images: 768, toolOutputs: 0, reasoning: 256}}];
  const original = structuredClone(p), [provider] = cleanupFileNodes([p]);
  const file = provider.children![0].children![0];
  assert.equal(provider.bytes, 1024); assert.equal(file.bytes, 1024);
  assert.match(file.detail!, /recompressed file size; operation amounts are proportional estimates/);
  assert.match(file.detail!, /Remove inline images: 2 · 768 B/);
  assert.match(file.detail!, /Remove encrypted reasoning: 3 · 256 B/);
  assert.deepEqual(p, original);
});

test('cleanup folders rank known savings even when some estimates are unknown', () => {
  const p = inertPlan(), base = p.actions[0];
  p.actions = ([
    ['unknown', 'unknown.png', null], ['zero', 'zero.png', 0], ['small', 'small.png', 1],
    ['large', 'unknown.png', null], ['large', 'first.png', 512], ['large', 'second.png', 512],
    ['medium', 'medium.png', 768],
  ] as const).map(([directory, file, estimatedSavingsBytes]) => ({
    ...base, id: `${directory}/${file}`, estimatedSavingsBytes,
    files: [{ ...base.files[0], path: `${p.root}/${directory}/${file}` }],
  }));
  const original = structuredClone(p);
  const [provider] = cleanupFileNodes([p]);
  assert.deepEqual(provider.children?.map(n => [n.name, n.bytes]), [
    ['large · 3 items', null], ['medium · 1 item', 768], ['small · 1 item', 1],
    ['zero · 1 item', 0], ['unknown · 1 item', null],
  ]);
  assert.match(provider.children![0].detail!, /1\.00 KiB \+ unknown \(1 item\)/);
  assert.deepEqual(provider.children![0].children?.map(n => n.bytes), [512, 512, null]);
  assert.equal(provider.bytes, null);
  assert.deepEqual(p, original, 'sorting must not mutate the plan');
});

test('cleanup file details preserve unknown estimates, multi-file scope and Codex effects', () => {
  const p = inertPlan(), a = p.actions[0];
  p.actions = [{ ...a, estimatedSavingsBytes: null, kind: 'codex-delete', sessionIds: ['parent', 'child'],
    files: [...a.files, { ...a.files[0], path: '/inert/codex/other/child.jsonl' }] },
    { ...a, kind: 'slim-history', slimOptions: { removeImages: false, compactTools: false, removeReasoning: true },
      slimCounts: { images: 0, toolOutputs: 0, reasoning: 7 }, slimSavingsBytes: { images: 0, toolOutputs: 0, reasoning: 1024 } }];
  const [provider] = cleanupFileNodes([p]), group = provider.children![0];
  assert.equal(provider.bytes, null); assert.equal(group.bytes, null);
  assert.match(provider.detail!, /1\.00 KiB \+ unknown \(1 item\)/);
  const [slim, deletion] = group.children!;
  assert.match(slim.name, /7 reasoning blocks/);
  assert.match(slim.detail!, /Remove encrypted reasoning: 7 · 1\.00 KiB/);
  assert.match(deletion.name, /\(\+1 file\) · Delete session/);
  assert.equal(deletion.bytes, null);
  assert.match(deletion.detail!, /Estimated savings: unknown/);
  assert.match(deletion.detail!, /\/other\/child\.jsonl\n\nRelated sessions:\nparent\nchild$/);
});

test('cleanup file tree stays compact, shows folder suffixes and opens multiline full paths', async t => {
  const term = await terminal(t);
  for (const [key, value] of Object.entries({ columns: 81, rows: 24 })) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
    Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else Reflect.deleteProperty(process.stdout, key); });
  }
  const p = inertPlan();
  p.actions = Array.from({ length: 100 }, (_, i) => ({ ...p.actions[0],
    files: [{ ...p.actions[0].files[0], path: `/inert/codex/${'long-directory-'.repeat(8)}项目/image-${i}.png` }],
    estimatedSavingsBytes: i === 99 ? null : 1024,
  }));
  const answer = tree({ message: 'Cleanup files · Estimated savings', nodes: cleanupFileNodes([p]) }, term.context);
  void answer.catch(() => {});
  const current = () => screenLines(term.text()).filter(Boolean);
  assert.ok(current().length < 12, '100 files should start as one collapsed directory');
  assert.match(current().join('\n'), /项目 · 100 items\s+unknown/);
  assert.doesNotMatch(current().join('\n'), /image-0/);
  await term.key('\x1b[C'); await term.key('\x1b[C'); await term.key('j');
  assert.match(current().join('\n'), /image-0\.png · Compress PNG \(lossless\)\s+1\.00 KiB/);
  await term.key('\r');
  assert.match(current().join('\n'), /Estimated savings: 1\.00 KiB\n  Source size: 4\.00 KiB/);
  assert.ok(current().some(line => line === '  Full paths:'));
  process.stdout.columns = 46; process.stdout.emit('resize'); await setImmediate();
  await term.key('\x1b[F');
  assert.match(current().join('\n'), /image-0\.png/);
  assert.ok(current().every(line => measure(line).width <= 45), JSON.stringify(current()));
  await term.key('q');
  await term.key('\x1b[F');
  assert.match(current().join('\n'), /image-99.*unknown/);
  assert.ok(current().every(line => measure(line).width <= 45), JSON.stringify(current()));
  await term.key('q'); await answer;
});

test('Quick clean selects all supported history operations alongside file cleanup without prompting', async t => {
  const term = await terminal(t);
  assert.deepEqual(await cleanOptions(false, term.context.signal), {
    includeFileCleanup: true, removeImages: true, compactTools: true, removeReasoning: true, removeRequestArchives: true, compactHooks: true,
    compactToolDefinitions: true, compactSkillListings: true, removeOldSnapshots: true,
  });
  assert.equal(term.text(), '');
  assert.equal((await cleanOptions(false, term.context.signal, false))?.removeOldSnapshots, false);
  assert.equal((await cleanOptions(false, term.context.signal, false))?.removeReasoning, false);
  const codexOnly = await cleanOptions(false, term.context.signal, true, false);
  assert.equal(codexOnly?.removeRequestArchives, false);
  assert.equal(codexOnly?.compactHooks, false);
  assert.equal(codexOnly?.compactToolDefinitions, false);
  assert.equal(codexOnly?.compactSkillListings, false);
});

test('temporary cleanup menu can be opened and cancelled before any scan', async t => {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, {configurable: true, value});
    t.after(() => Object.defineProperty(process, name, descriptor));
  }
  const running = menu({roots: {claude: '/inert/claude', codex: '/inert/codex'}, stateDir: '/inert/state'}, term.context.signal);
  void running.catch(() => {});
  await term.key('1');
  assert.match(stripVTControlCharacters(term.text()), /4\. Clean temporary files/);
  await term.key('4');
  assert.match(stripVTControlCharacters(term.text()), /Claude Code/);
  await term.key('q'); await term.key('q'); await running;
  assert.doesNotMatch(stripVTControlCharacters(term.text()), /Scanning|Deep Scan|Confirm cleanup|Incomplete:/);
});

test('standalone Slim history starts unchecked and only includes the selected operations', async t => {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output]] as const) {
    const original = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, get: () => value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  let answer = cleanOptions(true, term.context.signal);
  await term.key('\r'); assert.equal(await answer, null);
  for (const keys of ['1', '2', '12', '3', '123', '4', '5', '45', '12345', '6', '7', '67', '1234567', '8', '12345678']) {
    answer = cleanOptions(true, term.context.signal);
    for (const key of keys) await term.key(key);
    await term.key('\r');
    assert.deepEqual(await answer, { removeImages: keys.includes('1'), compactTools: keys.includes('2'),
      removeReasoning: keys.includes('3'), removeRequestArchives: keys.includes('4'), compactHooks: keys.includes('5'),
      compactToolDefinitions: keys.includes('6'), compactSkillListings: keys.includes('7'), removeOldSnapshots: keys.includes('8') });
  }
  answer = cleanOptions(true, term.context.signal, false, true);
  await term.key('3'); await term.key('4'); await term.key('5'); await term.key('6'); await term.key('\r');
  assert.deepEqual(await answer, {removeImages: false, compactTools: false, removeReasoning: false, removeRequestArchives: true, compactHooks: true, compactToolDefinitions: true, compactSkillListings: true, removeOldSnapshots: false});
  answer = cleanOptions(true, term.context.signal, true, false);
  await term.key('3'); await term.key('4'); await term.key('\r');
  assert.deepEqual(await answer, {removeImages: false, compactTools: false, removeReasoning: true, removeRequestArchives: false, compactHooks: false, compactToolDefinitions: false, compactSkillListings: false, removeOldSnapshots: true});
  answer = cleanOptions(true, term.context.signal);
  await term.key('q'); assert.equal(await answer, null);
  assert.match(stripVTControlCharacters(term.text()), /irreversible; no undo/);
  assert.match(stripVTControlCharacters(term.text()), /more than 72 hours/);
});

test('empty Claude file plans explain available rules and summarize repeated notes without flooding paths', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const p = { ...inertPlan(), provider: 'claude' as const, actions: [], warnings: [
    CLAUDE_FILE_CLEANUP_NOTICE,
    ...Array.from({ length: 40 }, (_, i) => `projects/p/session-${i}.jsonl: Mixed session format versions require unverified compatibility`),
    ...Array.from({ length: 2 }, (_, i) => `72-hour protection: projects/p/recent-${i}.jsonl; Entire operation retained.`),
    ...Array.from({ length: 7 }, (_, i) => `Additional reason ${i}`),
  ] };
  const original = [...p.warnings];
  printPlan(p);
  const text = lines.join('\n');
  assert.match(text, /Quick clean also checks known system temporary files/);
  assert.match(text, /Slim history/);
  assert.match(text, /40 × Mixed session format versions/);
  assert.match(text, /2 × 72-hour protection: modified within the last 3 days, or file time is invalid; kept unchanged/);
  assert.match(text, /Scan notes.*50 notices/);
  assert.match(text, /One file can have several notices/);
  assert.match(text, /Plus 4 more note types/);
  assert.match(text, /--json/);
  assert.doesNotMatch(text, /projects\/p\/session-/);
  assert.ok(lines.length < 25);
  assert.deepEqual(p.warnings, original, 'full warnings remain available in JSON and details');
});

test('cleanup notes and menu descriptions use readable terminal foreground in color mode', t => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const noColor = process.env.NO_COLOR, term = process.env.TERM;
  Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: true});
  delete process.env.NO_COLOR; process.env.TERM = 'xterm-256color';
  t.after(() => {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty); else delete (process.stdout as any).isTTY;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    if (term === undefined) delete process.env.TERM; else process.env.TERM = term;
  });
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  printPlan({...inertPlan(), actions: [], warnings: ['Kept unchanged: unrecognized image format']});
  assert.doesNotMatch(lines.join('\n'), /\x1b\[(?:90|2)m/);
  assert.match(lines.join('\n'), /\x1b\[1m.*Scan notes/);
  const description = menuRow({name: 'View scan notes', description: 'Full paths and reasons', value: 'notes'}, 0, false, 100, {total: 0, max: 0, labelWidth: 20, color: true});
  assert.match(description, /Full paths and reasons/);
  assert.doesNotMatch(description, /\x1b\[(?:90|2)m/);
});

test('More folds scan notes and returning to review still requires Enter to confirm', async t => {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output]] as const) {
    const original = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, get: () => value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  t.mock.method(console, 'log', (...args: unknown[]) => term.context.output.write(args.join(' ') + '\n'));
  const p = inertPlan();
  p.warnings = ['sessions/changed.jsonl: Cannot read session: FILE_CHANGED'];
  let settled = false;
  const answer = confirmPlans([p], term.context.signal);
  void answer.then(() => { settled = true; }, () => {});
  await setImmediate();
  const initial = stripVTControlCharacters(term.text());
  assert.match(initial, /Total estimated savings/);
  assert.match(initial, /2\. More/);
  assert.doesNotMatch(initial, /FILE_CHANGED|View scan notes|View files|72-hour protection|logical bytes/);
  await term.key('2');
  assert.equal(settled, false);
  await term.key('\r');
  assert.equal(settled, false);
  assert.match(stripVTControlCharacters(term.text()), /Scan notes.*1 notices/);
  assert.match(stripVTControlCharacters(term.text()), /2\. Less/);
  await term.key('4'); await term.key('\r');
  assert.match(stripVTControlCharacters(term.text()), /sessions\/changed\.jsonl: Cannot read session: FILE_CHANGED/);
  await term.key('q');
  await term.key('2');
  const from = term.text().length;
  await term.key('\r');
  const collapsed = stripVTControlCharacters(term.text().slice(from));
  assert.match(collapsed, /2\. More/);
  assert.doesNotMatch(collapsed, /FILE_CHANGED|View scan notes|View files|logical bytes/);
  await term.key('1');
  assert.equal(settled, false);
  await term.key('\r');
  assert.equal(await answer, true);
});

test('empty plan navigation offers opt-in slimming and full notes without approving cleanup', async t => {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output]] as const) {
    const original = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, get: () => value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  t.mock.method(console, 'log', (...args: unknown[]) => term.context.output.write(args.join(' ') + '\n'));
  const p = { ...inertPlan(), provider: 'claude' as const, actions: [], warnings: [CLAUDE_FILE_CLEANUP_NOTICE, 'sessions/a.jsonl: Retained'] };
  let answer = emptyPlansMenu([p], term.context.signal);
  await term.key('\r'); assert.equal(await answer, null, 'Back is the default');
  answer = emptyPlansMenu([p], term.context.signal);
  await term.key('3'); await term.key('\r');
  await term.key('4'); await term.key('\r');
  assert.match(stripVTControlCharacters(term.text()), /sessions\/a\.jsonl: Retained/);
  await term.key('q');
  await term.key('3'); await term.key('\r');
  let settled = false;
  void answer.then(() => { settled = true; }, () => {});
  await term.key('2'); assert.equal(settled, false);
  await term.key('\r'); assert.equal(await answer, 'slim');
});

test('cleanup confirmation summarizes scope, offers file details, and only Enter can approve', async t => {
  const term = await terminal(t);
  for (const [name, value] of [['stdin', term.context.input], ['stdout', term.context.output]] as const) {
    const original = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { configurable: true, get: () => value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  t.mock.method(console, 'log', (...args: unknown[]) => term.context.output.write(args.join(' ') + '\n'));
  const first = inertPlan(), second = { ...inertPlan(), provider: 'claude' as const };
  second.actions[0] = { ...second.actions[0], kind: 'slim-history', slimOptions: { removeImages: true, compactTools: true }, slimCounts: { images: 3, toolOutputs: 2 }, slimSavingsBytes: { images: 768, toolOutputs: 256 } };
  let settled = false;
  let answer = confirmPlans([first, second], term.context.signal);
  void answer.then(() => { settled = true; }, () => {});
  await setImmediate();
  const text = stripVTControlCharacters(term.text());
  assert.doesNotMatch(text, /\/inert\/codex\/generated_images\/图片\.png/);
  assert.equal(text.match(/Estimated savings by operation/g)?.length, 1);
  assert.match(text, /2\.00 KiB\s+Total estimated savings/);
  assert.match(text, /768 B\s+Remove inline images · 3 images/);
  assert.match(text, /256 B\s+Compact shell output · 2 outputs/);
  assert.match(text, /Irreversible: removed content cannot be recovered\. No undo/);
  assert.match(text, /Resumed context may differ or cost more/);
  assert.doesNotMatch(text, /Full file paths|logical bytes|last modified more than 72 hours/);
  await term.key('2'); await term.key('\r');
  await term.key('3'); await term.key('\r');
  assert.equal(settled, false, 'file details must not approve cleanup');
  assert.match(stripVTControlCharacters(term.text()), /generated_images · 1 item/);
  await term.key('\x1b[C'); await term.key('\x1b[C'); await term.key('j'); await term.key('\r');
  assert.match(stripVTControlCharacters(term.text()), /\/inert\/codex\/generated_images\/图片\.png/);
  assert.match(stripVTControlCharacters(term.text()), /Source size: 4\.00 KiB/);
  assert.match(stripVTControlCharacters(term.text()), /Estimated savings: 1\.00 KiB/);
  await term.key('q');
  assert.equal(settled, false, 'closing file details must return to the file list');
  await term.key('q');
  await term.key('2'); await term.key('\r');
  for (const key of ['1', '2', ' ', 'y', '\x1b[B']) {
    await term.key(key);
    assert.equal(settled, false, 'a non-Enter key must never approve cleanup');
  }
  await term.key('\r'); assert.equal(await answer, true);
  for (const key of ['q', '\x1b']) {
    answer = confirmPlans([first], term.context.signal);
    await term.key(key); assert.equal(await answer, false);
  }
  assert.equal(await confirmPlans([{ ...first, actions: [] }], term.context.signal), false);
  const aborted = confirmPlans([first], term.context.signal);
  const rejected = assert.rejects(aborted, { name: 'AbortPromptError' });
  term.abort(); await rejected;
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('plan estimates distinguish unknown savings and measured results', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const p = inertPlan();
  p.actions.push({ ...p.actions[0], id: 'unknown', targetId: 'unknown.png', estimatedSavingsBytes: null });
  printPlan(p);
  assert.match(lines.join('\n'), /1\.00 KiB \+ unknown \(1 item\)\s+Total estimated savings/);
  assert.match(lines.join('\n'), /1\.00 KiB \+ unknown \(1 item\)\s+Compress PNGs \(lossless\) · 2 files/);
  assert.match(lines.join('\n'), /last modified more than 72 hours ago/);
  assert.equal(p.actions[0].afterBytes, 4096, 'estimates must not overwrite measured sizes');
  lines.length = 0;
  p.actions = [];
  printPlan(p);
  assert.match(lines.join('\n'), /No eligible cleanup items/);
  assert.match(lines.join('\n'), /0 B\s+Total estimated savings/);
  lines.length = 0;
  p.explicitTarget = '/inert/codex/selected.jsonl';
  printPlan(p);
  assert.match(lines.join('\n'), /Explicit single target: \/inert\/codex\/selected\.jsonl/);
  assert.match(lines.join('\n'), /session without descendants/);
});

test('duplicate cleanup shows plaintext savings once and identifies the retained compressed copy', t => {
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  const p = inertPlan(), a = p.actions[0], f = a.files[0];
  Object.assign(f, {path: `${p.root}/sessions/one.jsonl`, relative: 'sessions/one.jsonl', category: 'sessions'});
  Object.assign(a, {kind: 'deduplicate-history', targetId: f.relative, beforeBytes: 5120, afterBytes: 5120,
    estimatedSavingsBytes: 4096, files: [f, {...f, path: f.path + '.zst', relative: f.relative + '.zst', size: 1024, ino: 1}]});
  const original = structuredClone(p);
  printPlan(p);
  const text = stripVTControlCharacters(output.join('\n'));
  assert.match(text, /4\.00 KiB\s+Remove duplicate originals \(keep zstd\) · 1 file/);
  assert.match(text, /4\.00 KiB\s+Total estimated savings/);
  assert.equal(text.match(/Remove duplicate originals/g)?.length, 1);
  assert.match(text, /identical compressed histories are retained/);
  assert.match(text, /No undo copy/);
  assert.doesNotMatch(text, /one\.jsonl/);
  const [provider] = cleanupFileNodes([p]), leaf = provider.children![0].children![0];
  assert.equal(provider.bytes, 4096); assert.equal(leaf.bytes, 4096);
  assert.match(leaf.detail!, /Remove duplicate original \(keep zstd\)/);
  assert.ok(leaf.detail!.includes(`Remove: ${f.path}\nKeep: ${f.path}.zst`));
  assert.deepEqual(p, original, 'rendering must not mutate the plan');
});

test('history plan rendering shows irreversible choices, counts and savings using inert data', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const p = inertPlan(), action = p.actions[0];
  action.kind = 'slim-history'; action.targetId = 'sessions/example.jsonl';
  action.files[0].path = '/inert/codex/sessions/example.jsonl';
  action.slimOptions = {removeImages: true, compactTools: false}; action.slimCounts = {images: 3, toolOutputs: 0};
  action.slimSavingsBytes = {images: 1024, toolOutputs: 0};
  printPlan(p);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /\/inert\/codex\/sessions\/example\.jsonl/);
  assert.match(text, /1\.00 KiB\s+Remove inline images · 3 images/);
  assert.doesNotMatch(text, /Compact shell output/);
  assert.match(text, /Irreversible:.*No undo/);
  assert.match(text, /1\.00 KiB\s+Total estimated savings/);
  assert.match(text, /View files/);
});

test('hundreds of history actions render one bounded category summary including zero-saving operations', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const p = inertPlan(), base = p.actions[0];
  p.actions = Array.from({length: 200}, (_, i) => ({
    ...base, id: `history-${i}`, kind: 'slim-history', targetId: `sessions/${i}.jsonl`,
    files: [{...base.files[0], path: `/inert/codex/sessions/${i}.jsonl`}],
    slimOptions: {removeImages: true, compactTools: true}, slimCounts: {images: 3, toolOutputs: 0},
    slimSavingsBytes: {images: 1024, toolOutputs: 0},
  }));
  const original = structuredClone(p);
  printPlan(p);
  const text = lines.join('\n');
  assert.match(text, /200\.00 KiB\s+Remove inline images · 600 images/);
  assert.match(text, /0 B\s+Compact shell output · 0 outputs/);
  assert.match(text, /200\.00 KiB\s+Total estimated savings/);
  assert.doesNotMatch(text, /sessions\/|source size/);
  assert.equal(text.match(/Irreversible:/g)?.length, 1);
  assert.ok(lines.length < 20);
  assert.deepEqual(p, original, 'all details remain intact for JSON and file review');
});

test('mixed plans distinguish session deletion and preserve legacy history estimates without inventing a breakdown', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const p = inertPlan(), base = p.actions[0];
  p.actions.push(
    {...base, kind: 'slim-history', slimOptions: {removeImages: true, compactTools: true}, slimCounts: {images: 1, toolOutputs: 1}},
    {...base, kind: 'delete-files'},
    {...base, kind: 'delete-files', sessionIds: ['claude-session']},
    {...base, kind: 'codex-delete', sessionIds: ['codex-session']},
  );
  printPlan(p);
  const text = lines.join('\n');
  assert.match(text, /1\.00 KiB\s+History slimming \(breakdown unavailable\) · 1 files/);
  assert.match(text, /1\.00 KiB\s+Delete files · 1 files/);
  assert.match(text, /2\.00 KiB\s+Delete sessions · 2 files/);
  assert.match(text, /5\.00 KiB\s+Total estimated savings/);
  assert.doesNotMatch(text, /Remove inline images|Compact shell output/);
});

test('system temps show category estimates and selective accounting without listing each file', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const p = inertPlan(), base = p.actions[0];
  p.root = '/inert/temp'; p.systemTemp = {uid: 501, excludedRoots: []};
  p.actions = ['task-output', 'cwd-record', 'hook-output', 'installer', 'session-output'].flatMap(category => Array.from({length: 50}, (_, i) => ({
    ...base, kind: 'delete-files' as const, targetId: `${category}-${i}`,
    files: [{...base.files[0], path: `/inert/temp/${category}-${i}`, category}],
  })));
  printPlan(p);
  const text = lines.join('\n');
  assert.match(text, /System temporary files/);
  for (const label of ['Remove temporary task outputs', 'Remove temporary cwd records', 'Remove temporary hook outputs', 'Remove leftover installers', 'Remove session-created temporary outputs'])
    assert.ok(text.includes(`50.00 KiB  ${label} · 50 files`));
  assert.match(text, /250\.00 KiB\s+Total estimated savings/);
  assert.match(text, /Irreversible:.*No undo/);
  assert.doesNotMatch(text, /\/inert\/temp\/|Delete files/); assert.ok(lines.length < 25);
  lines.length = 0;
  printReceipts([{...p, actions: [], status: 'completed', rootBeforeBytes: 204800, rootAfterBytes: 0, confirmedReductionBytes: 204800, attributionComplete: true}]);
  printCleanupLog({schemaVersion: 1, operationId: 'inert', provider: 'codex', root: p.root, source: 'clean',
    scope: 'system-temp', startedAt: p.startedAt, finishedAt: p.startedAt, status: 'completed',
    beforeBytes: 204800, afterBytes: 0, savedBytes: 204800, cleanedRecords: 200, cleanupTypes: [], needsReview: false});
  assert.match(lines.join('\n'), /Matched temp files before/);
  assert.match(lines.join('\n'), /Matched temp files after/);
  assert.doesNotMatch(lines.join('\n'), /Directory before|Directory after/);
});

test('cleanup categories combine providers and temporary roots without double-counting history savings', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  const first = inertPlan(), second = {...inertPlan(), provider: 'claude' as const, root: '/inert/claude'};
  first.actions.push({...first.actions[0], estimatedSavingsBytes: null});
  const history = {...second.actions[0], kind: 'slim-history' as const,
    estimatedSavingsBytes: 3072,
    slimOptions: {removeImages: true, compactTools: true, removeRequestArchives: true, compactHooks: true, compactToolDefinitions: true, compactSkillListings: true},
    slimCounts: {images: 2, toolOutputs: 4, requestRecords: 3, hooks: 1, toolDefinitions: 14, skillListings: 1},
    slimSavingsBytes: {images: 768, toolOutputs: 256, requestRecords: 768, hooks: 256, toolDefinitions: 768, skillListings: 256}};
  second.actions = [history];
  first.actions.push({...history, estimatedSavingsBytes: 2048, slimOptions: {removeImages: true, compactTools: true, removeReasoning: true, removeOldSnapshots: true},
    slimCounts: {images: 3, toolOutputs: 2, reasoning: 2, oldSnapshots: 3}, slimSavingsBytes: {images: 512, toolOutputs: 256, reasoning: 256, oldSnapshots: 1024}});
  const temporary = ['/inert/tmp', '/inert/user-temp'].map(root => ({...inertPlan(), root,
    systemTemp: {uid: 501, excludedRoots: []}, actions: [{...first.actions[0], kind: 'delete-files' as const,
      files: [{...history.files[0], path: `${root}/task.output`, category: 'task-output'}]}],
    warnings: [`${root}/recent.jsonl: Kept unchanged`],
  }));
  temporary[1].actions.push({...temporary[1].actions[0], files: [{...history.files[0], category: 'hook-output'}]});
  for (const p of temporary) p.actions.push({...p.actions[0], files: [{...history.files[0], category: 'session-output'}]});
  const plans = [first, second, ...temporary], original = structuredClone(plans);
  printPlans(plans);
  const text = lines.join('\n');
  assert.match(text, /Claude Code/); assert.match(text, /Codex/);
  assert.match(text, /1\.25 KiB\s+Remove inline images · 5 images/);
  assert.match(text, /512 B\s+Compact shell output · 6 outputs/);
  assert.match(text, /256 B\s+Remove encrypted reasoning \(Codex\) · 2 blocks/);
  assert.match(text, /768 B\s+Remove API request archives \(Claude\) · 3 records/);
  assert.match(text, /256 B\s+Compact successful hooks \(Claude\) · 1 hooks/);
  assert.match(text, /768 B\s+Compact tool definitions \(Claude\) · 14 definitions/);
  assert.match(text, /256 B\s+Compact skill listings \(Claude\) · 1 listings/);
  assert.match(text, /1\.00 KiB\s+Remove old compaction snapshots \(Codex\) · 3 snapshots/);
  assert.match(text, /latest complete snapshot is preserved.*forks or rollbacks/);
  assert.match(text, /Historical tool definitions and skill listings.*unavailable/);
  assert.match(text, /Resume may use current definitions.*cost more/);
  assert.match(text, /exact historical requests cannot be reconstructed/);
  assert.match(text, /Resumed context may differ/);
  assert.match(text, /1\.00 KiB \+ unknown \(1 item\)\s+Compress PNGs \(lossless\) · 2 files/);
  assert.match(text, /2\.00 KiB\s+Remove temporary task outputs · 2 files/);
  assert.match(text, /1\.00 KiB\s+Remove temporary hook outputs · 1 files/);
  assert.match(text, /2\.00 KiB\s+Remove session-created temporary outputs · 2 files/);
  assert.match(text, /11\.00 KiB \+ unknown \(1 item\)\s+Total estimated savings/);
  for (const label of ['Estimated savings by operation', 'Remove inline images', 'Compact shell output', 'Remove encrypted reasoning', 'Remove old compaction snapshots', 'Remove API request archives', 'Compact successful hooks', 'Compact tool definitions', 'Compact skill listings', 'Remove temporary task outputs', 'Remove session-created temporary outputs', 'Total estimated savings', 'Scan notes ·']) {
    assert.equal(text.split(label).length - 1, 1, `${label} appears once across all roots`);
  }
  assert.match(text, /2 × Kept unchanged/);
  assert.doesNotMatch(text, /\/inert\/|Delete files|source size/);
  assert.ok(lines.length < 37);
  assert.deepEqual(plans, original, 'summarizing preserves the individual plans and JSON details');
  lines.length = 0;
  printPlans(plans, false);
  const compact = lines.join('\n');
  const estimates = (output: string) => output.slice(output.indexOf('Estimated savings by operation'), output.indexOf('Total estimated savings'));
  assert.equal(estimates(compact), estimates(text), 'folding preserves every category estimate and the unknown total');
  assert.match(compact, /Irreversible: removed content cannot be recovered/);
  assert.doesNotMatch(compact, /Scan notes|Kept unchanged|logical bytes|latest complete snapshot|historical requests/);
  assert.deepEqual(plans, original, 'folding preserves the complete plan');
  lines.length = 0;
  printReceipts(plans.map(p => ({...p, status: 'dry-run', rootBeforeBytes: null, rootAfterBytes: null,
    confirmedReductionBytes: 0, attributionComplete: false})));
  assert.ok(lines.join('\n').startsWith(text), 'text-only previews use the same combined summary');
});

test('ordinary menus keep their default selection and abort restores the terminal', async t => {
  const term = await terminal(t);
  const answer = select({ message: 'Confirm', choices: [{ name: 'Cancel', value: false }, { name: 'Confirm', value: true }] }, term.context);
  await term.key('\r'); assert.equal(await answer, false);
  const aborted = select({ message: 'Choose', choices }, term.context);
  const rejected = assert.rejects(aborted, { name: 'AbortPromptError' });
  term.abort(); await rejected;
  assert.ok(term.text().includes('\x1b[?25h'));
});

test('NO_COLOR suppresses colors even in a terminal', () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const original = process.env.NO_COLOR;
  try {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    process.env.NO_COLOR = '';
    assert.equal(paint('purple', 'Title'), 'Title');
  } finally {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty); else delete process.stdout.isTTY;
    if (original === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = original;
  }
});
