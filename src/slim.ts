import type { Provider } from './types.ts';
import { filterRtkOutput, type RtkFilter } from './vendor/rtk.ts';
import { knownCompactionSnapshot, completeCompactionSnapshot } from './providers/codex-snapshots.ts';

export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
export interface SlimOptions { removeImages: boolean; compactTools: boolean; removeReasoning?: boolean; removeRequestArchives?: boolean; compactHooks?: boolean; compactToolDefinitions?: boolean; compactSkillListings?: boolean; removeOldSnapshots?: boolean }
export interface SlimCounts { images: number; toolOutputs: number; reasoning?: number; requestRecords?: number; hooks?: number; toolDefinitions?: number; skillListings?: number; oldSnapshots?: number }
export interface SlimSavingsBytes { images: number; toolOutputs: number; reasoning?: number; requestRecords?: number; hooks?: number; toolDefinitions?: number; skillListings?: number; oldSnapshots?: number }
type Row = Record<string, any>;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const marker = '[cc-clean: RTK output compacted; omitted content is unavailable]';
const inlineImage = (value: unknown): value is string => typeof value === 'string' && /^data:image\/[^;,]+;base64,[A-Za-z0-9+/=\s]+$/.test(value);

function knownRequestArchive(row: Row): boolean {
  const fields: Record<string, string[]> = {
    'api-request-blob': ['hash', 'message'],
    'api-request-shape': ['shapeHash', 'shape'],
    'api-request': ['id', 'querySource', 'shapeHash', 'params', 'base', 'keep', 'tail', 'cacheControl', 'requestDigest'],
  };
  const allowed = fields[row.type];
  if (!allowed || typeof row.sessionId !== 'string' || !row.sessionId ||
      Object.keys(row).some(key => !['type', 'sessionId', 'agentId', 'timestamp', 'version', ...allowed].includes(key))) return false;
  if (row.type === 'api-request-blob') return typeof row.hash === 'string' && object(row.message);
  if (row.type === 'api-request-shape') return typeof row.shapeHash === 'string' && object(row.shape);
  return ['id', 'shapeHash', 'requestDigest'].every(key => typeof row[key] === 'string') &&
    (row.base === undefined || typeof row.base === 'string') && object(row.params) &&
    Number.isSafeInteger(row.keep) && row.keep >= 0 && Array.isArray(row.tail) && row.tail.every((hash: unknown) => typeof hash === 'string') && Array.isArray(row.cacheControl);
}

function knownSuccessfulHook(row: Row): boolean {
  const hook = row.attachment;
  return row.type === 'attachment' && object(hook) && hook.type === 'hook_success' && hook.exitCode === 0 &&
    typeof row.uuid === 'string' && !!row.uuid && typeof row.sessionId === 'string' && !!row.sessionId &&
    (row.parentUuid === null || typeof row.parentUuid === 'string') &&
    ['hookName', 'hookEvent', 'toolUseID', 'command', 'content', 'stdout', 'stderr'].every(key => typeof hook[key] === 'string') &&
    Object.keys(hook).every(key => ['type', 'hookName', 'hookEvent', 'toolUseID', 'command', 'content', 'stdout', 'stderr', 'exitCode', 'durationMs'].includes(key)) &&
    (row.rendered === undefined || Array.isArray(row.rendered) && row.rendered.every((item: unknown) =>
      object(item) && Object.keys(item).every(key => key === 'content') && typeof item.content === 'string'));
}

function knownContextAttachment(row: Row): boolean {
  return row.type === 'attachment' && object(row.attachment) &&
    typeof row.uuid === 'string' && !!row.uuid && typeof row.sessionId === 'string' && !!row.sessionId &&
    (row.parentUuid === null || typeof row.parentUuid === 'string') &&
    (row.rendered === undefined || Array.isArray(row.rendered) && row.rendered.every((item: unknown) =>
      object(item) && Object.keys(item).every(key => key === 'content') && typeof item.content === 'string'));
}

function knownToolSnapshot(row: Row): boolean {
  if (!knownContextAttachment(row)) return false;
  const snapshot = row.attachment;
  const flags = ['reminderFold', 'systemTurns', 'toolChangeHeader', 'inlineTools', 'keptReminders', 'echoWireToolInputs'];
  return snapshot.type === 'prompt_snapshot' &&
    Object.keys(snapshot).every(key => ['type', 'systemPrompt', 'tools', 'cliPrefix', 'contextRendering', ...flags].includes(key)) &&
    flags.every(key => snapshot[key] === undefined || typeof snapshot[key] === 'boolean') &&
    ['cliPrefix', 'contextRendering'].every(key => snapshot[key] === undefined || typeof snapshot[key] === 'string') &&
    Array.isArray(snapshot.systemPrompt) && snapshot.systemPrompt.every((part: unknown) => typeof part === 'string') &&
    Array.isArray(snapshot.tools) && snapshot.tools.length > 0 && snapshot.tools.every((tool: unknown) =>
      object(tool) && Object.keys(tool).every(key => ['name', 'description', 'schema'].includes(key)) &&
      typeof tool.name === 'string' && !!tool.name && typeof tool.description === 'string' && object(tool.schema) &&
      tool.schema.name === tool.name && typeof tool.schema.description === 'string' && object(tool.schema.input_schema) &&
      (tool.schema.eager_input_streaming === undefined || typeof tool.schema.eager_input_streaming === 'boolean') &&
      Object.keys(tool.schema).every(key => ['name', 'description', 'input_schema', 'eager_input_streaming'].includes(key)));
}

function knownSkillListing(row: Row): boolean {
  if (!knownContextAttachment(row)) return false;
  const listing = row.attachment;
  return listing.type === 'skill_listing' &&
    Object.keys(listing).every(key => ['type', 'content', 'names', 'skillCount', 'isInitial'].includes(key)) &&
    typeof listing.content === 'string' && typeof listing.isInitial === 'boolean' &&
    Array.isArray(listing.names) && listing.names.every((name: unknown) => typeof name === 'string') &&
    Number.isSafeInteger(listing.skillCount) && listing.skillCount === listing.names.length;
}

// Record value spans so untouched fields (including signatures and large numeric
// literals) stay byte-for-byte identical even in a modified JSONL record.
function parseLine(text: string) {
  let row: unknown;
  try { row = JSON.parse(text); } catch { throw new Error('Malformed history JSONL; original retained'); }
  if (!object(row)) throw new Error('Unsupported history record');
  const spans = new WeakMap<object, Map<string | number, [number, number]>>();
  const members = new WeakMap<object, Map<string | number, [number, number]>>();
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
      const deletions = new Map<string | number, [number, number]>();
      if (!array) members.set(value, deletions);
      let index = 0, comma: number | undefined;
      while (text[cursor] !== (array ? ']' : '}')) {
        const memberStart = cursor;
        let key: string | number = index++;
        if (!array) {
          const start = cursor; stringEnd(); key = JSON.parse(text.slice(start, cursor));
          if (fields.has(key)) throw new Error('Duplicate history JSON key; original retained');
          whitespace(); cursor++; whitespace();
        }
        const start = cursor; visit(value[key], depth + 1); fields.set(key, [start, cursor]);
        const end = cursor; whitespace();
        if (!array) deletions.set(key, comma === undefined
          ? [memberStart, text[cursor] === ',' ? cursor + 1 : end] : [comma, end]);
        if (text[cursor] !== ',') break;
        comma = cursor; cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '"') stringEnd();
    else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
  }
  whitespace(); visit(row, 0);
  const edits: {start: number; end: number; value: string}[] = [];
  const savingsBytes: SlimSavingsBytes = {images: 0, toolOutputs: 0};
  return {
    row, savingsBytes,
    replace(parent: object, key: string | number, value: unknown, category: keyof SlimSavingsBytes, allowEqual = false): boolean {
      const span = spans.get(parent)?.get(key);
      if (!span) throw new Error('Unrecognized history field location');
      const serialized = JSON.stringify(value);
      const saved = Buffer.byteLength(text.slice(...span)) - Buffer.byteLength(serialized);
      if (saved < 0 || saved === 0 && (!allowEqual || text.slice(...span) === serialized)) return false;
      savingsBytes[category] = (savingsBytes[category] ?? 0) + saved;
      edits.push({start: span[0], end: span[1], value: serialized}); return true;
    },
    remove(parent: object, key: string, category: keyof SlimSavingsBytes) {
      const span = members.get(parent)?.get(key);
      if (!span) throw new Error('Unrecognized history member location');
      savingsBytes[category] = (savingsBytes[category] ?? 0) + Buffer.byteLength(text.slice(...span));
      edits.push({start: span[0], end: span[1], value: ''});
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
      if (result && parsed.replace(row, 'output', result, 'toolOutputs')) return parsed.render();
    } catch { /* Unknown envelopes remain intact. */ }
  }
}

// Canonical events and the SQLite UI cache use different casing for the same items.
function rewriteCodexItem(parsed: ReturnType<typeof parseLine>, item: unknown, options: SlimOptions, counts: SlimCounts) {
  if (!object(item)) return;
  if (options.removeImages && ['UserMessage', 'userMessage'].includes(item.type) && Array.isArray(item.content)) {
    for (let i = 0; i < item.content.length; i++) {
      const block = item.content[i];
      if (block?.type === 'image' && inlineImage(block.url) &&
          parsed.replace(item.content, i, {type: 'text', text: '[image removed]', text_elements: []}, 'images')) counts.images++;
    }
  }
  if (options.compactTools && ['CommandExecution', 'commandExecution'].includes(item.type) && item.status === 'completed') {
    const canonical = item.type === 'CommandExecution';
    if (item[canonical ? 'exit_code' : 'exitCode'] !== 0) return;
    let command = item.command;
    if (canonical) {
      // Only an exact shell invocation has a known command string; never execute it.
      if (!Array.isArray(command) || command.length !== 3 || !['/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'].includes(command[0]) ||
          !['-c', '-lc'].includes(command[1])) return;
      command = command[2];
    }
    const key = canonical ? 'aggregated_output' : 'aggregatedOutput';
    const result = compact(commandFilter(command), item[key]);
    if (result && parsed.replace(item, key, result, 'toolOutputs')) counts.toolOutputs++;
  }
}

export function slimCodexItem(text: string, options: SlimOptions): string {
  const parsed = parseLine(text);
  rewriteCodexItem(parsed, parsed.row, options, {images: 0, toolOutputs: 0});
  return parsed.render();
}

export function assertCodexMeta(row: Row) {
  const meta = row.payload;
  if (row.type !== 'session_meta' || !object(meta) || typeof meta.id !== 'string' || !meta.id)
    throw new Error('Codex history requires a recognized session header and identity');
  if (meta.history_mode !== undefined && !['legacy', 'paginated'].includes(meta.history_mode) ||
      meta.history_base != null || meta.subagent_history_start_ordinal != null || meta.forked_from_id || meta.forked_from ||
      meta.attached_thread || meta.forked_from_ordinal_exclusive != null || meta.imported)
    throw new Error('Shared or imported Codex history requires coordinated dependent-history updates; file retained');
}

export function slimHistory(input: Buffer, provider: Provider, options: SlimOptions): {output: Buffer | null; counts: SlimCounts; savingsBytes: SlimSavingsBytes} {
  if (input.length > MAX_HISTORY_BYTES) throw new Error('History exceeds the 64 MiB rewrite limit');
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input); }
  catch { throw new Error('History is not valid UTF-8'); }
  const lines = text.split('\n'), counts: SlimCounts = {images: 0, toolOutputs: 0};
  const savingsBytes: SlimSavingsBytes = {images: 0, toolOutputs: 0};
  if (options.removeReasoning) { counts.reasoning = 0; savingsBytes.reasoning = 0; }
  if (options.removeRequestArchives) { counts.requestRecords = 0; savingsBytes.requestRecords = 0; }
  if (options.compactHooks) { counts.hooks = 0; savingsBytes.hooks = 0; }
  if (options.compactToolDefinitions) { counts.toolDefinitions = 0; savingsBytes.toolDefinitions = 0; }
  if (options.compactSkillListings) { counts.skillListings = 0; savingsBytes.skillListings = 0; }
  if (options.removeOldSnapshots) { counts.oldSnapshots = 0; savingsBytes.oldSnapshots = 0; }
  const snapshots: number[] = [];
  let lastCompaction = -1, latestComplete = false, snapshotsKnown = true, rollback = false;
  const requestLines = new Set<number>();
  let requestsKnown = true, conversationRecords = 0;
  const calls = new Map<string, RtkFilter | undefined>();
  let session: string | undefined, records = 0, ordinal = -1;
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
        if (options.removeImages && image && parsed.replace(content, i, {type: codex ? 'input_text' : 'text', text: '[image removed]'}, 'images')) counts.images++;
      }
    };
    const replaceToolText = (parent: Row | any[], key: string | number, filter: RtkFilter | undefined) => {
      const result = compact(filter, (parent as any)[key]);
      if (result && parsed.replace(parent, key, result, 'toolOutputs')) counts.toolOutputs++;
    };
    if (provider === 'claude') {
      if (row.forkedFrom || row.forkedFromSessionId || row.isImported) throw new Error('Imported or forked Claude history is unsupported');
      if (typeof row.sessionId === 'string') {
        if (session && session !== row.sessionId) throw new Error('Mixed history session identities');
        session = row.sessionId;
      }
      if (options.removeRequestArchives && typeof row.type === 'string' && row.type.startsWith('api-request')) {
        if (knownRequestArchive(row)) requestLines.add(n);
        else requestsKnown = false;
      }
      if (['user', 'assistant'].includes(row.type) && object(row.message)) conversationRecords++;
      if (options.compactHooks && knownSuccessfulHook(row)) {
        let changed = false;
        for (const key of ['command', 'content', 'stdout', 'stderr'])
          if (parsed.replace(row.attachment, key, '', 'hooks')) changed = true;
        if (row.rendered !== undefined && parsed.replace(row, 'rendered', [], 'hooks')) changed = true;
        if (changed) counts.hooks!++;
      }
      if (options.compactToolDefinitions && knownToolSnapshot(row) && parsed.replace(row.attachment, 'tools', [], 'toolDefinitions'))
        counts.toolDefinitions! += row.attachment.tools.length;
      if (options.compactSkillListings && knownSkillListing(row)) {
        let changed = parsed.replace(row.attachment, 'content', '', 'skillListings');
        if (parsed.replace(row.attachment, 'names', [], 'skillListings')) changed = true;
        // The recorded inventory suppresses fresh discovery even after descriptions are cleared.
        if (parsed.replace(row.attachment, 'skillCount', 0, 'skillListings', true)) changed = true;
        if (row.rendered !== undefined && parsed.replace(row, 'rendered', [], 'skillListings')) changed = true;
        if (changed) counts.skillListings!++;
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
      if (records === 0) { assertCodexMeta(row); session = row.payload.id; }
      else if (row.type === 'session_meta') throw new Error('Multiple Codex history headers');
      if (row.ordinal !== undefined) {
        if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || row.ordinal <= ordinal) throw new Error('Invalid or non-increasing history ordinal');
        ordinal = row.ordinal;
      }
      if (object(row.payload) && row.payload.history_base != null) throw new Error('Shared history requires dependent-history updates');
      const payload = row.payload;
      if (row.type === 'event_msg' && ['item_started', 'item_completed'].includes(payload?.type))
        rewriteCodexItem(parsed, payload.item, options, counts);
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
            parsed.replace(payload, 'images', urls.filter((_, i) => !removed[i]), 'images')) {
          if (Array.isArray(details) && details.some((_, i) => removed[i]))
            parsed.replace(payload, 'image_details', details.filter((_, i) => !removed[i]), 'images');
          if (Array.isArray(order) && order.length) {
            let index = 0;
            parsed.replace(payload, 'image_order', order.filter(kind => kind === 'file' || !removed[index++]), 'images');
          }
          counts.images += count;
        }
      }
      if (options.removeOldSnapshots) {
        if (row.type === 'compacted') {
          lastCompaction = n;
          latestComplete = completeCompactionSnapshot(row);
          snapshotsKnown &&= knownCompactionSnapshot(row);
          if (Array.isArray(payload?.replacement_history)) snapshots.push(n);
        }
        if (row.type === 'event_msg' && payload?.type === 'thread_rolled_back') rollback = true;
      }
      if (row.type === 'response_item' && object(payload)) {
        if (options.removeReasoning && payload.type === 'reasoning' && typeof payload.encrypted_content === 'string' && payload.encrypted_content.length) {
          parsed.remove(payload, 'encrypted_content', 'reasoning');
          counts.reasoning = (counts.reasoning ?? 0) + 1;
        }
        if (payload.type === 'message') replaceImages(payload.content, true);
        if (['function_call_output', 'custom_tool_call_output'].includes(payload.type) && typeof payload.call_id === 'string' &&
            (payload.status === undefined || payload.status === 'completed') && (payload.is_error === undefined || payload.is_error === false))
          replaceImages(payload.output, true);
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
          if (result && parsed.replace(payload, 'output', result, 'toolOutputs')) counts.toolOutputs++;
        }
      }
    }
    lines[n] = parsed.render(); records++;
    savingsBytes.images += parsed.savingsBytes.images;
    savingsBytes.toolOutputs += parsed.savingsBytes.toolOutputs;
    if (options.removeReasoning) savingsBytes.reasoning! += parsed.savingsBytes.reasoning ?? 0;
    if (options.compactHooks) savingsBytes.hooks! += parsed.savingsBytes.hooks ?? 0;
    if (options.compactToolDefinitions) savingsBytes.toolDefinitions! += parsed.savingsBytes.toolDefinitions ?? 0;
    if (options.compactSkillListings) savingsBytes.skillListings! += parsed.savingsBytes.skillListings ?? 0;
  }
  if (!records || !session) throw new Error('History format or session identity could not be established');
  const oldSnapshots = snapshots.filter(n => n < lastCompaction);
  if (oldSnapshots.length) {
    if (!snapshotsKnown || !latestComplete || rollback)
      throw new Error('Old compaction snapshots retained: incomplete or unsupported checkpoint, or rollback history');
    for (const n of oldSnapshots) {
      // Remove in separate passes so adjacent members cannot overlap their comma spans.
      for (const key of ['replacement_history', 'replacement_history_metadata']) {
        const parsed = parseLine(lines[n]);
        if (!Object.hasOwn(parsed.row.payload, key)) continue;
        parsed.remove(parsed.row.payload, key, 'oldSnapshots');
        lines[n] = parsed.render();
        savingsBytes.oldSnapshots! += parsed.savingsBytes.oldSnapshots!;
      }
      counts.oldSnapshots!++;
    }
  }
  // Remove the entire known archive family together; unknown siblings may still reference it.
  if (requestsKnown && conversationRecords) {
    if (options.removeRequestArchives) counts.requestRecords = requestLines.size;
    for (const n of requestLines) savingsBytes.requestRecords! += Buffer.byteLength(lines[n]) + (n < lines.length - 1 ? 1 : 0);
  } else requestLines.clear();
  return {output: Object.values(counts).some(Boolean) ? Buffer.from(lines.map((line, n) => requestLines.has(n) ? '' : line + (n < lines.length - 1 ? '\n' : '')).join('')) : null, counts, savingsBytes};
}
