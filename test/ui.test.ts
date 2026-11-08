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
import type { Plan } from '../src/clean.ts';
import type { Analysis, Usage } from '../src/types.ts';

// Only navigate read-only screens; never select cleanup actions or previews.
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

test('tabbed report abort restores input, cursor and resize listeners', async t => {
  const term = await terminal(t), listeners = process.stdout.listenerCount('resize');
  const answer = pager({ message: 'Usage breakdown', pages: [] }, term.context);
  const rejected = assert.rejects(answer, { name: 'AbortPromptError' });
  term.abort(); await rejected;
  assert.equal(term.context.input.listenerCount('keypress'), 0);
  assert.equal(process.stdout.listenerCount('resize'), listeners);
  assert.ok(term.text().includes('\x1b[?25h'));
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
