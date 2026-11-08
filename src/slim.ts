import type { Provider } from './types.ts';
import { filterRtkOutput, type RtkFilter } from './vendor/rtk.ts';

export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
export interface SlimOptions { removeImages: boolean; compactTools: boolean }
export interface SlimCounts { images: number; toolOutputs: number }
type Row = Record<string, any>;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const marker = '[cc-clean: RTK output compacted; omitted content is unavailable]';
const inlineImage = (value: unknown): value is string => typeof value === 'string' && /^data:image\/[^;,]+;base64,[A-Za-z0-9+/=\s]+$/.test(value);

// Record value spans so untouched fields (including signatures and large numeric
// literals) stay byte-for-byte identical even in a modified JSONL record.
function parseLine(text: string) {
  let row: unknown;
  try { row = JSON.parse(text); } catch { throw new Error('Malformed history JSONL; original retained'); }
  if (!object(row)) throw new Error('Unsupported history record');
  const spans = new WeakMap<object, Map<string | number, [number, number]>>();
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  function stringEnd() {
    cursor++;
    while (cursor < text.length) {
      if (text[cursor++] === '"') return;
      if (text[cursor - 1] === '\\') cursor++;
    }
  }
  function visit(value: any, depth: number) {
    if (depth > 100) throw new Error('History nesting exceeds supported limit');
    if (value && typeof value === 'object') {
      const array = Array.isArray(value), fields = new Map<string | number, [number, number]>();
      spans.set(value, fields); cursor++; whitespace();
      let index = 0;
      while (text[cursor] !== (array ? ']' : '}')) {
        let key: string | number = index++;
        if (!array) {
          const start = cursor; stringEnd(); key = JSON.parse(text.slice(start, cursor));
          if (fields.has(key)) throw new Error('Duplicate history JSON key; original retained');
          whitespace(); cursor++; whitespace();
        }
        const start = cursor; visit(value[key], depth + 1); fields.set(key, [start, cursor]); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '"') stringEnd();
    else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
  }
  whitespace(); visit(row, 0);
  const edits: {start: number; end: number; value: string}[] = [];
  return {
    row,
    replace(parent: object, key: string | number, value: unknown): boolean {
      const span = spans.get(parent)?.get(key);
      if (!span) throw new Error('Unrecognized history field location');
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) >= Buffer.byteLength(text.slice(...span))) return false;
      edits.push({start: span[0], end: span[1], value: serialized}); return true;
    },
    render() {
      let result = text, boundary = text.length;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        if (edit.end > boundary) throw new Error('Overlapping history edits');
        result = result.slice(0, edit.start) + edit.value + result.slice(edit.end); boundary = edit.start;
      }
      return result;
    },
  };
}

// No shell evaluation. Reject composition, substitution and wrappers whose actual
// command cannot be established from one simple invocation.
export function commandFilter(command: unknown): RtkFilter | undefined {
  if (typeof command !== 'string' || command.length > 16_384 || /[\n\r;&|<>`$\\]/.test(command)) return;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g);
  if (!tokens || tokens.join(' ').replace(/\s/g, '') !== command.replace(/\s/g, '')) return;
  const args = tokens.map(token => /^['"]/.test(token) ? token.slice(1, -1) : token);
  const [exe, ...rest] = args;
  if (exe === 'rg' && rest.includes('--files') && rest.every(arg => !arg.startsWith('-') || ['--files', '--hidden', '--no-ignore', '-g', '--glob'].includes(arg))) return 'find';
  if (['rg', 'grep'].includes(exe) && !rest.some(arg => /^(?:--(?:json|files|count|replace|passthru|context|before-context|after-context)|-[AclLqUoz])/.test(arg))) return 'grep';
  if (exe === 'find' && rest.every(arg => !arg.startsWith('-') || ['-type', '-name', '-iname', '-path', '-maxdepth', '-mindepth', '-print', '-not'].includes(arg))) return 'find';
  if (exe === 'fd' && rest.every(arg => !arg.startsWith('-') || ['--hidden', '--no-ignore', '--type', '-t', '--extension', '-e', '--max-depth', '-d', '--absolute-path', '-a'].includes(arg))) return 'find';
  if (exe === 'cargo' && rest[0] === 'test') return 'cargo-test';
  if (exe === 'pytest' || ['python', 'python3'].includes(exe) && rest[0] === '-m' && rest[1] === 'pytest') return 'pytest';
}

function compact(filter: RtkFilter | undefined, output: unknown): string | undefined {
  if (!filter || typeof output !== 'string' || output.includes(marker)) return;
  const filtered = filterRtkOutput(filter, output);
  if (filtered === output) return;
  const result = `${marker}\n${filtered}`;
  if (Buffer.byteLength(result) < Buffer.byteLength(output)) return result;
}

function compactCodexOutput(filter: RtkFilter | undefined, output: string): string | undefined {
  const envelope = /^((?:Chunk ID: [^\n]+\n)?Wall time: [^\n]+\nProcess exited with code 0\n(?:Original token count: \d+\n)?(?:Final output:|Output:)\n)([\s\S]*)$/.exec(output);
  if (envelope) {
    const result = compact(filter, envelope[2]);
    return result && envelope[1] + result;
  }
  if (output.startsWith('{')) {
    try {
      const parsed = parseLine(output), row = parsed.row;
      if (row.metadata?.exit_code !== 0 || row.metadata?.session_id != null) return;
      const result = compact(filter, row.output);
      if (result && parsed.replace(row, 'output', result)) return parsed.render();
    } catch { /* Unknown envelopes remain intact. */ }
  }
}

export function assertLegacyCodexMeta(row: Row) {
  const meta = row.payload;
  if (row.type !== 'session_meta' || !object(meta) || typeof meta.id !== 'string' || meta.cli_version !== '0.167.0')
    throw new Error('Only Codex 0.167.0 plain legacy histories are supported');
  if (row.ordinal !== undefined || meta.history_mode !== undefined && meta.history_mode !== 'legacy' ||
      meta.history_base != null || meta.subagent_history_start_ordinal != null || meta.forked_from_id || meta.forked_from ||
      meta.attached_thread || meta.forked_from_ordinal_exclusive != null || meta.imported)
    throw new Error('Paginated, shared or imported Codex history cannot be rewritten');
}

export function slimHistory(input: Buffer, provider: Provider, options: SlimOptions): {output: Buffer | null; counts: SlimCounts} {
  if (input.length > MAX_HISTORY_BYTES) throw new Error('History exceeds the 64 MiB rewrite limit');
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input); }
  catch { throw new Error('History is not valid UTF-8'); }
  const lines = text.split('\n'), counts: SlimCounts = {images: 0, toolOutputs: 0};
  const calls = new Map<string, RtkFilter | undefined>();
  let session: string | undefined, versionSeen = false, records = 0;
  function remember(id: unknown, command: unknown) {
    if (typeof id !== 'string') return;
    if (calls.has(id)) throw new Error('Duplicate tool call identity; original retained');
    calls.set(id, commandFilter(command));
  }
  for (let n = 0; n < lines.length; n++) {
    if (!lines[n].trim()) continue;
    const parsed = parseLine(lines[n]), row = parsed.row;
    const replaceImages = (content: unknown, codex: boolean) => {
      if (!Array.isArray(content)) return;
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!object(block)) continue;
        const image = codex ? block.type === 'input_image' && inlineImage(block.image_url) :
          block.type === 'image' && block.source?.type === 'base64' && typeof block.source.media_type === 'string' && block.source.media_type.startsWith('image/') && typeof block.source.data === 'string';
        if (options.removeImages && image && parsed.replace(content, i, {type: codex ? 'input_text' : 'text', text: '[image removed]'})) counts.images++;
      }
    };
    const replaceToolText = (parent: Row | any[], key: string | number, filter: RtkFilter | undefined) => {
      const result = compact(filter, (parent as any)[key]);
      if (result && parsed.replace(parent, key, result)) counts.toolOutputs++;
    };
    if (provider === 'claude') {
      if (row.version !== undefined) {
        if (row.version !== '2.1.319') throw new Error('Only Claude Code 2.1.319 histories are supported');
        versionSeen = true;
      }
      if (row.forkedFrom || row.forkedFromSessionId || row.isImported) throw new Error('Imported or forked Claude history is unsupported');
      if (typeof row.sessionId === 'string') {
        if (session && session !== row.sessionId) throw new Error('Mixed history session identities');
        session = row.sessionId;
      }
      if (['user', 'assistant'].includes(row.type) && object(row.message) && Array.isArray(row.message.content)) {
        const content = row.message.content;
        replaceImages(content, false);
        for (const block of content) {
          if (!object(block)) continue;
          if (options.compactTools && row.type === 'assistant' && block.type === 'tool_use') remember(block.id, block.name === 'Bash' ? block.input?.command : undefined);
          if (row.type === 'user' && block.type === 'tool_result') {
            replaceImages(block.content, false);
            if (!options.compactTools || block.is_error !== false) continue;
            const filter = calls.get(block.tool_use_id);
            if (typeof block.content === 'string') replaceToolText(block, 'content', filter);
            else if (Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === 'text') replaceToolText(block.content[0], 'text', filter);
          }
        }
      }
    } else {
      if (records === 0) { assertLegacyCodexMeta(row); session = row.payload.id; versionSeen = true; }
      else if (row.type === 'session_meta') throw new Error('Multiple Codex history headers');
      if (row.ordinal !== undefined || object(row.payload) && row.payload.history_base != null) throw new Error('History byte offsets or shared records are unsupported');
      const payload = row.payload;
      if (options.removeImages && row.type === 'event_msg' && payload?.type === 'user_message' && Array.isArray(payload.images)) {
        const urls: unknown[] = payload.images, details = payload.image_details, order = payload.image_order;
        const removed = urls.map(inlineImage), count = removed.filter(Boolean).length;
        // UI events duplicate model images. Keep parallel hints and mixed file/URL
        // ordering aligned; leave unfamiliar shapes intact.
        const knownDetails = details === undefined || Array.isArray(details) && details.length <= urls.length;
        const knownOrder = order === undefined || Array.isArray(order) && (!order.length ||
          order.every(kind => kind === 'inline' || kind === 'file') &&
          order.filter(kind => kind === 'inline').length === urls.length &&
          order.filter(kind => kind === 'file').length === (payload.file_ids?.length ?? 0));
        if (count && urls.every(url => typeof url === 'string') && knownDetails && knownOrder &&
            parsed.replace(payload, 'images', urls.filter((_, i) => !removed[i]))) {
          if (Array.isArray(details) && details.some((_, i) => removed[i]))
            parsed.replace(payload, 'image_details', details.filter((_, i) => !removed[i]));
          if (Array.isArray(order) && order.length) {
            let index = 0;
            parsed.replace(payload, 'image_order', order.filter(kind => kind === 'file' || !removed[index++]));
          }
          counts.images += count;
        }
      }
      // shortcut: only top-level legacy response items are rewritten; extend this
      // after verifying native replay of compacted replacement histories.
      if (row.type === 'response_item' && object(payload)) {
        if (payload.type === 'message') replaceImages(payload.content, true);
        if (options.compactTools && payload.type === 'function_call') {
          let args: Row = {};
          try { const decoded = JSON.parse(payload.arguments); if (object(decoded)) args = decoded; } catch { /* Unknown arguments remain untouched. */ }
          const name = String(payload.name).replace(/^functions\./, '');
          remember(payload.call_id, name === 'exec_command' ? args.cmd : name === 'shell_command' ? args.command : undefined);
        }
        if (options.compactTools && payload.type === 'function_call_output' && typeof payload.output === 'string') {
          // Preserve the native execution envelope and exit status verbatim. Live
          // process chunks, unknown envelopes and failures cannot be filtered.
          const result = compactCodexOutput(calls.get(payload.call_id), payload.output);
          if (result && parsed.replace(payload, 'output', result)) counts.toolOutputs++;
        }
      }
    }
    lines[n] = parsed.render(); records++;
  }
  if (!records || !session || !versionSeen) throw new Error('History format or session identity could not be established');
  return {output: counts.images || counts.toolOutputs ? Buffer.from(lines.join('\n')) : null, counts};
}
