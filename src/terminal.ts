import { stripVTControlCharacters } from 'node:util';
import { Writable } from 'node:stream';
import measure from 'fast-string-truncated-width';
import { createPrompt, useState, useEffect, useMemo, useKeypress, isEnterKey } from '@inquirer/core';
import type { ScanProgress } from './types.ts';

export function safe(value: unknown): string {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}
export function size(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let n = Math.abs(bytes), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${bytes < 0 ? '-' : ''}${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}
export const columns = () => Math.max(1, (process.stdout.columns || 80) - 1);
export const hasColor = () => !!process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
const colors = { cyan: '36', purple: '1;35', plain: '39', green: '32', yellow: '33', bold: '1' };
export function paint(color: keyof typeof colors, value: unknown, enabled = hasColor()): string {
  const text = safe(value);
  return enabled ? `\x1b[${colors[color]}m${text}\x1b[0m` : text;
}
export function fit(value: unknown, width: number, fromEnd = false): string {
  const text = safe(value), limit = Math.max(0, width);
  if (measure(text).width <= limit) return text;
  if (limit < 1) return '';
  const segments = [...new Intl.Segmenter().segment(text)];
  if (fromEnd) segments.reverse();
  let fitted = '', used = 1;
  // Clip whole graphemes; the width library's slice index can overrun after punctuation.
  for (const { segment } of segments) {
    used += measure(segment).width;
    if (used > limit) break;
    fitted = fromEnd ? segment + fitted : fitted + segment;
  }
  return fromEnd ? '…' + fitted : fitted + '…';
}
function pad(value: string, width: number): string {
  const text = fit(value, width);
  return text + ' '.repeat(Math.max(0, width - measure(text).width));
}
export function table(headers: string[], records: string[][], width = columns()): string[] {
  const cells = [headers, ...records].map(row => row.map(safe));
  const widths = headers.map((_, i) => cells.reduce((max, row) => Math.max(max, measure(row[i]).width), 0));
  const labelWidth = Math.min(28, widths[0]);
  const lines: string[] = [];
  for (let start = 1; start < headers.length;) {
    let end = start, used = 2 + Math.min(16, labelWidth);
    while (end < headers.length && (end === start || used + 2 + widths[end] <= width)) {
      used += 2 + widths[end++];
    }
    const nameWidth = Math.max(1, Math.min(labelWidth, width - 2 - widths.slice(start, end).reduce((sum, n) => sum + n + 2, 0)));
    if (lines.length) lines.push('');
    for (const [index, row] of cells.entries()) {
      const text = `  ${pad(row[0], nameWidth)}${row.slice(start, end).map((cell, i) => `  ${cell.padStart(widths[start + i])}`).join('')}`;
      lines.push(index === 0 ? paint('plain', text) : text);
    }
    start = end;
  }
  return lines;
}
export function screen() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
}

export interface Choice<T> { name: string; value: T; description?: string; detail?: string; bytes?: number }
interface Menu<T> {
  message: string;
  subtitle?: string;
  summary?: (width: number) => string[];
  emptyMessage?: string;
  choices: Choice<T>[];
  total?: number;
  searchable?: boolean;
  multiple?: boolean;
  brand?: boolean;
  clear?: boolean;
  cancelLabel?: string;
  requireEnter?: boolean;
}

export function storageRow(item: { name: string; bytes: number }, options: {
  width: number; total: number; max: number; prefix?: string; selected?: boolean; color?: boolean;
}): string {
  const { width, total, max, selected = false, color = hasColor(), prefix = '  ' } = options;
  const amount = size(item.bytes), prefixWidth = measure(prefix).width;
  const barWidth = width >= 65 ? Math.min(24, Math.floor((width - 42) / 2)) : 0;
  const percent = `${(total > 0 ? item.bytes / total * 100 : 0).toFixed(1)}%`.padStart(6);
  const filled = max > 0 ? Math.min(barWidth, Math.max(item.bytes > 0 ? 1 : 0, Math.round(item.bytes / max * barWidth))) : 0;
  const bar = '█'.repeat(filled) + ' '.repeat(barWidth - filled);
  const graph = barWidth ? `${bar} ${percent}  |  ` : '';
  const nameWidth = width - prefixWidth - measure(graph).width - amount.length - 2;
  if (nameWidth < 4) return paint(selected ? 'cyan' : 'bold', fit(`${prefix}${item.name}  ${amount}`, width), color);
  const label = `${pad(item.name, nameWidth)}  ${amount}`;
  if (selected) return paint('cyan', prefix + graph + label, color);
  return prefix + (barWidth ? `${paint(total > 0 && item.bytes / total > 0.6 ? 'yellow' : 'green', bar, color)} ${paint('plain', percent + '  |  ', color)}` : '') + safe(label);
}

export function menuRow(item: Choice<unknown>, index: number, selected: boolean, width: number, options: {
  total: number; max: number; multiple?: boolean; checked?: boolean; labelWidth: number; color?: boolean;
}): string {
  const color = options.color ?? hasColor();
  const prefix = ` ${selected ? '➤' : ' '} ${String(index + 1).padStart(2)}. ${options.multiple ? (options.checked ? '● ' : '○ ') : ''}`;
  if (item.bytes !== undefined) return storageRow({ name: item.name, bytes: item.bytes }, { ...options, width, prefix, selected, color });
  const available = width - measure(prefix).width;
  const name = fit(item.name, available);
  const description = item.description && available - options.labelWidth > 12 ? fit(item.description, available - options.labelWidth - 2) : '';
  const text = description ? `${pad(name, options.labelWidth)}  ${description}` : name;
  return selected ? paint('cyan', prefix + text, color) : prefix + (description ? `${pad(name, options.labelWidth)}  ${paint('plain', description, color)}` : name);
}

function helpLines(hints: string[], width: number): string[] {
  const lines: string[] = [];
  for (const hint of hints) {
    const previous = lines.at(-1);
    if (previous && measure(`${previous}  |  ${hint}`).width <= width - 2) lines[lines.length - 1] += `  |  ${hint}`;
    else lines.push(fit(hint, width - 2));
  }
  return lines.map(text => paint('plain', `  ${text}`));
}

// Let Inquirer own raw mode, input and cursor restoration, including on abort.
const prompt = createPrompt<number[] | null, Menu<unknown>>((config, done) => {
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [checked, setChecked] = useState<number[]>([]);
  const [dimensions, setDimensions] = useState({ width: columns(), height: process.stdout.rows || 24 });
  useEffect(() => {
    const resize = () => setDimensions({ width: columns(), height: process.stdout.rows || 24 });
    process.stdout.on('resize', resize);
    return () => { process.stdout.off('resize', resize); };
  }, []);
  const entries = useMemo(() => config.choices.map((item, index) => ({ item, index, text: safe(`${item.name} ${item.description ?? ''} ${item.detail ?? ''}`).toLowerCase() })), [config.choices]);
  const visible = useMemo(() => entries.filter(entry => entry.text.includes(query.toLowerCase())), [entries, query]);
  const metrics = useMemo(() => ({
    max: config.choices.reduce((max, item) => Math.max(max, item.bytes ?? 0), 0),
    total: config.total ?? config.choices.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    labelWidth: config.choices.reduce((max, item) => Math.min(32, Math.max(max, measure(safe(item.name)).width)), 0),
  }), [config.choices, config.total]);
  const banner = config.brand && dimensions.width >= 52 && dimensions.height >= 22;
  const summary = config.summary?.(dimensions.width) ?? [];
  const hints = filtering ? ['Type to filter', 'Enter Done', 'Esc Clear'] : [
    '↑↓/jk Move', `Enter ${config.multiple ? 'Continue' : 'Select'}`, `Q/Esc ${config.cancelLabel ?? 'Back'}`,
    ...(config.searchable ? ['/ Filter'] : []), ...(config.multiple ? ['Space Toggle'] : []),
    ...(visible.length ? [visible.length <= 9 ? config.requireEnter ? '1–9 Move' : '1–9 Select' : 'PgUp/PgDn Page'] : []),
  ];
  const footer = helpLines(hints, dimensions.width);
  const hasDetails = config.choices.some(item => item.detail);
  const reserved = 5 + Number(hasDetails) + Number(!!config.subtitle) + Number(!!config.searchable) + (banner ? 3 : 0) + summary.length + footer.length;
  const pageSize = Math.max(1, Math.min(14, dimensions.height - reserved));
  const start = Math.floor(active / pageSize) * pageSize;
  const toggle = (index: number) => setChecked(previous => previous.includes(index) ? previous.filter(value => value !== index) : [...previous, index]);
  useKeypress((key, rl) => {
    const input = rl.line; rl.line = '';
    if (filtering) {
      if (key.name === 'escape') { setFiltering(false); setQuery(''); setActive(0); }
      else if (isEnterKey(key)) setFiltering(false);
      else if (key.name === 'backspace') { setQuery(Array.from(query).slice(0, -1).join('')); setActive(0); }
      else if (!key.ctrl && input) { setQuery(query + safe(input)); setActive(0); }
      return;
    }
    if (key.name === 'escape' || key.name === 'q' || key.name === 'left' || key.name === 'backspace') { done(null); return; }
    if (config.searchable && input === '/') { setFiltering(true); return; }
    if (key.name === 'up' || key.name === 'k') setActive((active - 1 + visible.length) % (visible.length || 1));
    else if (key.name === 'down' || key.name === 'j') setActive((active + 1) % (visible.length || 1));
    else if (key.name === 'home') setActive(0);
    else if (key.name === 'end') setActive(Math.max(0, visible.length - 1));
    else if (key.name === 'pageup') setActive(Math.max(0, active - pageSize));
    else if (key.name === 'pagedown') setActive(Math.min(Math.max(0, visible.length - 1), active + pageSize));
    else if (key.name === 'space' && config.multiple && visible[active]) toggle(visible[active].index);
    else if (isEnterKey(key)) {
      if (config.multiple) done(checked);
      else if (visible[active]) done([visible[active].index]);
    } else if (!key.ctrl && /^[1-9]$/.test(input) && visible.length <= 9 && visible[Number(input) - 1]) {
      if (config.multiple) toggle(visible[Number(input) - 1].index);
      else if (config.requireEnter) setActive(Number(input) - 1);
      else done([visible[Number(input) - 1].index]);
    }
  });
  const width = dimensions.width, lines = [''];
  if (banner) lines.push(...[
    '  ▄▀▀ ▄▀▀   ▄▀▀ █   █▀▀ ▄▀█ █▄ █',
    '  ▀▄▄ ▀▄▄   ▀▄▄ █▄▄ ██▄ █▀█ █ ▀█',
  ].map(text => paint('cyan', text)), '');
  lines.push(paint('purple', fit(`  ${config.message}`, width)));
  if (config.subtitle) lines.push(paint('plain', fit(`  ${config.subtitle}`, width)));
  lines.push(...summary.map(text => fit(text, width)));
  lines.push('');
  if (!visible.length) lines.push(paint('plain', `  ${!query && config.emptyMessage ? config.emptyMessage : 'No matching items.'}`));
  for (const [offset, entry] of visible.slice(start, start + pageSize).entries()) {
    lines.push(menuRow(entry.item, start + offset, start + offset === active, width, { ...metrics, multiple: config.multiple, checked: checked.includes(entry.index) }));
  }
  lines.push('');
  const item = visible[active]?.item;
  if (hasDetails) lines.push(paint('plain', fit(`  ${item?.detail ?? ''}`, width)));
  if (config.searchable) lines.push(paint('plain', fit(`  ${filtering || query ? `Filter: ${query}${filtering ? '▌' : ''}  ·  ` : ''}${visible.length} items${visible.length > pageSize ? `  ·  ${start + 1}–${Math.min(start + pageSize, visible.length)}` : ''}${config.multiple ? `  ·  ${checked.length} selected` : ''}`, width)));
  lines.push(...footer);
  return '\x1b[?25l' + lines.join('\n');
});

type Context = Parameters<typeof prompt>[1];

function promptContext(context: Context = {}): Context {
  const destination = context.output ?? process.stdout;
  let previous: string[] | undefined, dimensions = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      let text = chunk.toString();
      // Our frames start with cursor-hide; accept only Inquirer's known framing and SGR styles.
      const frame = /^(?:\x1b\[\d*[ABGK])*\x1b\[\?25l((?:[^\x1b]|\x1b\[[\d;]*m)*)(\x1b\[\d*G)$/.exec(text);
      if (frame) {
        const lines = frame[1].split('\n');
        const height = Reflect.get(destination, 'rows') || process.stdout.rows || 24;
        const currentDimensions = `${Reflect.get(destination, 'columns')}:${columns()}:${height}`;
        if (previous && dimensions === currentDimensions && lines.length <= height) {
          let row = previous.length - 1;
          text = '';
          const move = (next: number) => {
            text += next < row ? `\x1b[${row - next}A` : '\n'.repeat(next - row);
            row = next;
          };
          for (let i = 0; i < Math.max(previous.length, lines.length); i++) {
            if (previous[i] === lines[i]) continue;
            move(i);
            // Overwrite first, then clear the old suffix; never blank the frame before painting.
            text += `\r${lines[i] ?? ''}\x1b[K`;
          }
          move(lines.length - 1);
          text += frame[2];
        }
        previous = lines.length <= height ? lines : undefined;
        dimensions = currentDimensions;
      } else if (!/^(?:\x1b\[\d*G)*$/.test(text)) {
        // Cleanup, resize and unfamiliar control sequences retain Inquirer's normal behavior.
        previous = undefined;
      }
      // Queue directly on the destination so cleanup precedes the next prompt's output.
      destination.write(text);
      callback();
    },
  });
  for (const key of ['isTTY', 'columns', 'rows']) {
    Object.defineProperty(output, key, { get: () => Reflect.get(destination, key) });
  }
  return { ...context, output, clearPromptOnDone: true };
}

export interface TreeNode { name: string; bytes?: number | null; detail?: string; children?: TreeNode[]; expanded?: boolean; truncateStart?: boolean }
function wrap(value: string, width: number): string[] {
  const lines = [''];
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(safe(value))) {
    const length = measure(segment).width;
    if (used && used + length > width) { lines.push(''); used = 0; }
    lines[lines.length - 1] += length > width ? fit(segment, width) : segment;
    used += Math.min(length, width);
  }
  return lines;
}
const treePrompt = createPrompt<void, { message: string; subtitle?: string; nodes: TreeNode[] }>((config, done) => {
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(new Set(config.nodes.filter(node => node.expanded)));
  const [inspecting, setInspecting] = useState(false);
  const [offset, setOffset] = useState(0);
  const [dimensions, setDimensions] = useState({ width: columns(), height: process.stdout.rows || 24 });
  useEffect(() => {
    const resize = () => setDimensions({ width: columns(), height: process.stdout.rows || 24 });
    process.stdout.on('resize', resize);
    return () => { process.stdout.off('resize', resize); };
  }, []);
  const visible = useMemo(() => {
    const entries: { node: TreeNode; depth: number; parent: number }[] = [];
    const visit = (nodes: TreeNode[], depth: number, parent: number) => {
      for (const node of nodes) {
        const index = entries.length;
        entries.push({ node, depth, parent });
        if (expanded.has(node) && node.children) visit(node.children, depth + 1, index);
      }
    };
    visit(config.nodes, 0, -1);
    return entries;
  }, [config.nodes, expanded]);
  const current = visible[active], width = dimensions.width;
  const footer = helpLines(inspecting ? ['↑↓/jk Scroll', 'PgUp/PgDn Page', 'Q/Esc Back'] : [
    '↑↓/jk Move', '←/→ Fold/Expand', 'Enter Open', 'Q/Esc Back', 'PgUp/PgDn Page',
  ], width);
  const pageSize = Math.max(1, dimensions.height - 7 - Number(!!config.subtitle) - footer.length);
  const detail = (current?.node.detail ?? current?.node.name ?? 'No items found.').split('\n')
    .flatMap(line => wrap(line, Math.max(1, width - 2)));
  const detailStart = Math.min(offset, Math.max(0, detail.length - pageSize));
  const toggle = () => {
    if (!current?.node.children?.length) { setInspecting(true); setOffset(0); return; }
    const next = new Set(expanded);
    if (next.has(current.node)) next.delete(current.node); else next.add(current.node);
    setExpanded(next);
  };
  useKeypress((key, rl) => {
    rl.line = '';
    if (inspecting) {
      if (['q', 'escape', 'left', 'backspace'].includes(key.name) || isEnterKey(key)) setInspecting(false);
      else if (['down', 'j', 'pagedown', 'up', 'k', 'pageup', 'home', 'end'].includes(key.name)) {
        const delta = ['up', 'k', 'pageup'].includes(key.name) ? -1 : 1;
        setOffset(key.name === 'home' ? 0 : key.name === 'end' ? Math.max(0, detail.length - pageSize)
          : Math.max(0, Math.min(detail.length - pageSize, detailStart + delta * (key.name.startsWith('page') ? pageSize : 1))));
      }
      return;
    }
    if (key.name === 'q' || key.name === 'escape') { done(); return; }
    if (!current) return;
    if (key.name === 'up' || key.name === 'k') setActive(Math.max(0, active - 1));
    else if (key.name === 'down' || key.name === 'j') setActive(Math.min(visible.length - 1, active + 1));
    else if (key.name === 'home') setActive(0);
    else if (key.name === 'end') setActive(visible.length - 1);
    else if (key.name === 'pageup') setActive(Math.max(0, active - pageSize));
    else if (key.name === 'pagedown') setActive(Math.min(visible.length - 1, active + pageSize));
    else if (key.name === 'left' || key.name === 'h' || key.name === 'backspace') {
      if (expanded.has(current.node)) toggle();
      else if (current.parent >= 0) setActive(current.parent);
    } else if (key.name === 'right' || key.name === 'l') {
      if (current.node.children?.length) {
        if (expanded.has(current.node)) setActive(active + 1); else toggle();
      }
    } else if (isEnterKey(key) || key.name === 'space') toggle();
  });
  const start = Math.floor(active / pageSize) * pageSize;
  const lines = ['', paint('purple', fit(`  ${config.message}`, width))];
  if (config.subtitle) lines.push(paint('plain', fit(`  ${config.subtitle}`, width)));
  lines.push('');
  if (inspecting) lines.push(...detail.slice(detailStart, detailStart + pageSize).map(text => `  ${text}`));
  else if (!visible.length) lines.push(fit('  No items found.', width));
  else for (const [index, { node, depth }] of visible.slice(start, start + pageSize).entries()) {
    const selected = start + index === active;
    const prefix = ` ${selected ? '➤' : ' '} ${'  '.repeat(depth)}${node.children?.length ? expanded.has(node) ? '▾' : '▸' : '·'} `;
    const amount = node.bytes === undefined ? '' : `  ${size(node.bytes)}`;
    const labelWidth = Math.max(1, width - amount.length - measure(prefix).width);
    const text = prefix + pad(fit(node.name, labelWidth, node.truncateStart), labelWidth) + amount;
    lines.push(paint(selected ? 'cyan' : 'bold', fit(text, width)));
  }
  lines.push('', paint('plain', fit(`  ${inspecting ? `${detailStart + 1}–${Math.min(detailStart + pageSize, detail.length)} / ${detail.length} lines`
    : `${visible.length ? start + 1 : 0}–${Math.min(start + pageSize, visible.length)} / ${visible.length} items · ${current?.node.detail ?? ''}`}`, width)), ...footer);
  return '\x1b[?25l' + lines.join('\n');
});

export async function tree(config: { message: string; subtitle?: string; nodes: TreeNode[] }, context?: Context): Promise<void> {
  screen();
  await treePrompt(config, promptContext(context));
}

interface Pager {
  message: string;
  subtitle?: string;
  pages: { name: string; content: (width: number) => string[] }[];
}
const pagerPrompt = createPrompt<void, Pager>((config, done) => {
  const [active, setActive] = useState(0);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [dimensions, setDimensions] = useState({ width: columns(), height: process.stdout.rows || 24 });
  useEffect(() => {
    const resize = () => setDimensions({ width: columns(), height: process.stdout.rows || 24 });
    process.stdout.on('resize', resize);
    return () => { process.stdout.off('resize', resize); };
  }, []);
  const { width, height } = dimensions;
  const content = useMemo(() => (config.pages[active]?.content(width) ?? ['  No data available.'])
    .flatMap(line => measure(safe(line)).width > width ? wrap(line, width) : [line]), [config.pages, active, width]);
  const tabs = config.pages.map((page, i) => i === active ? `[${safe(page.name)}]` : safe(page.name)).join('  ');
  const tabLine = measure(tabs).width <= width - 2 ? tabs : `← [${config.pages[active]?.name ?? ''}] →`;
  const header = ['', paint('purple', fit(`  ${config.message}`, width))];
  if (config.subtitle) header.push(paint('plain', fit(`  ${config.subtitle}`, width)));
  header.push('', paint('cyan', fit(`  ${tabLine}`, width)), '');
  const footer = helpLines(['←/→ Tabs', '↑↓/jk Scroll', 'PgUp/PgDn Page', 'Home/End', 'Q/Esc Back'], width);
  // Keep a content row even when the terminal is too short for the full chrome.
  if (header.length + footer.length + 3 >= height) {
    header.splice(0, header.length, paint('cyan', fit(`  ${tabLine}`, width)));
    footer.splice(0, footer.length, ...helpLines(['←→ Tabs · ↑↓ Scroll · Q Back'], width));
  }
  const pageSize = Math.max(1, height - header.length - footer.length - 2);
  const end = Math.max(0, content.length - pageSize), start = Math.min(offsets[active] ?? 0, end);
  useKeypress((key, rl) => {
    rl.line = '';
    if (key.name === 'q' || key.name === 'escape') { done(); return; }
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
      const delta = key.name === 'left' || key.shift ? -1 : 1;
      setActive((active + delta + config.pages.length) % (config.pages.length || 1));
    } else if (['up', 'k', 'down', 'j', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
      const delta = ['up', 'k', 'pageup'].includes(key.name) ? -1 : 1;
      const next = key.name === 'home' ? 0 : key.name === 'end' ? end
        : Math.max(0, Math.min(end, start + delta * (key.name.startsWith('page') ? pageSize : 1)));
      setOffsets(previous => { const values = [...previous]; values[active] = next; return values; });
    }
  });
  const body = content.slice(start, start + pageSize);
  while (body.length < pageSize) body.push('');
  return '\x1b[?25l' + [...header, ...body, '',
    paint('plain', fit(`  ${content.length ? start + 1 : 0}–${Math.min(start + pageSize, content.length)} / ${content.length} lines`, width)),
    ...footer].join('\n');
});

export async function pager(config: Pager, context?: Context): Promise<void> {
  screen();
  await pagerPrompt(config, promptContext(context));
}

const progressPrompt = createPrompt<void, {
  message: string; subtitle?: string;
  run: (update: (progress: ScanProgress) => void) => Promise<void>;
  cancel: () => void;
}>((config, done) => {
  const [progress, setProgress] = useState<ScanProgress>({ phase: 'discovering', completed: 0, total: null });
  const [stopping, setStopping] = useState(false);
  const [width, setWidth] = useState(columns());
  useEffect(() => {
    let active = true, latest: ScanProgress | undefined;
    const timer = setInterval(() => { if (latest) { setProgress(latest); latest = undefined; } }, 80);
    const resize = () => setWidth(columns());
    process.stdout.on('resize', resize);
    // Keep task errors on its promise so the caller can rethrow after terminal restoration.
    const finish = () => { if (active) done(); };
    void config.run(value => { latest = value; }).then(finish, finish);
    return () => { active = false; clearInterval(timer); process.stdout.off('resize', resize); };
  }, []);
  useKeypress((key, rl) => {
    rl.line = '';
    if (key.name === 'q' || key.name === 'escape') { setStopping(true); config.cancel(); }
  });
  const labels = { discovering: 'Discovering files…', sessions: 'Scanning sessions…', index: 'Reading session index…', finalizing: 'Building report…', activity: 'Checking for open sessions…', estimating: 'Estimating cleanup savings…', cleaning: 'Applying cleanup…' };
  const lines = ['', paint('purple', fit(`  ${config.message}`, width))];
  if (config.subtitle) lines.push(paint('plain', fit(`  ${config.subtitle}`, width)));
  lines.push('', paint('cyan', fit(`  ${stopping ? 'Stopping…' : labels[progress.phase]}`, width)));
  lines.push(fit(`  ${progress.total === null ? `${progress.completed} files found · total pending` : `${progress.completed} / ${progress.total} ${progress.phase === 'cleaning' ? 'cleanup items started' : progress.phase === 'estimating' ? 'cleanup items estimated' : progress.phase === 'activity' ? 'candidate paths checked' : 'session files scanned'}`}`, width));
  const bytes = progress.totalBytes !== undefined && progress.processedBytes !== undefined;
  if (bytes || progress.total !== null) {
    const [part, whole] = bytes ? [progress.processedBytes!, progress.totalBytes!] : [progress.completed, progress.total!];
    const ratio = whole ? Math.min(1, part / whole) : 1;
    const barWidth = Math.min(30, Math.max(0, width - 14));
    const filled = Math.round(ratio * barWidth);
    lines.push(paint('green', fit(`  ${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}  ${(ratio * 100).toFixed(1)}%`, width)));
    if (bytes) lines.push(fit(`  ${size(progress.processedBytes!)} / ${size(progress.totalBytes!)}`, width));
  }
  if (progress.currentFile) lines.push(paint('plain', fit(`  ${progress.currentFile}`, width)));
  lines.push('', ...helpLines(['Q / Esc / Ctrl+C Cancel'], width));
  return '\x1b[?25l' + lines.join('\n');
});

export async function withProgress<T>(config: { message: string; subtitle?: string }, work: (signal: AbortSignal, update: (progress: ScanProgress) => void) => Promise<T>, context?: Context): Promise<T | null> {
  const controller = new AbortController();
  const signal = context?.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
  let task: Promise<T> | undefined;
  try {
    await progressPrompt({ ...config, cancel: () => controller.abort(), run(update) {
      task = Promise.resolve().then(() => work(signal, update));
      return task.then(() => undefined);
    } }, promptContext({ output: process.stderr, ...context }));
    if (signal.aborted) return null;
    return await task!;
  } catch (error) {
    if (!context?.signal?.aborted && error instanceof Error && error.name === 'ExitPromptError') return null;
    throw error;
  } finally {
    controller.abort();
    // Cancellation must finish closing readers before the next menu takes input.
    await task?.catch(() => {});
  }
}

export async function select<T>(config: Menu<T>, context?: Context): Promise<T | null> {
  if (config.clear !== false) screen();
  const selected = await prompt(config, promptContext(context));
  return selected?.length ? config.choices[selected[0]].value : null;
}
export async function checkbox<T>(config: Menu<T>, context?: Context): Promise<T[]> {
  if (config.clear !== false) screen();
  const selected = await prompt({ ...config, multiple: true, searchable: true }, promptContext(context));
  return (selected ?? []).map(index => config.choices[index].value);
}
