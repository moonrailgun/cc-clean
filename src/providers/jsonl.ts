import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { FileEntry, Provider, Usage } from '../types.ts';

export const PARSER_VERSION = 4;
const MAX_LINE = 8 * 1024 * 1024;
const METADATA_BYTES = 1024 * 1024;
const MAX_IDENTITIES = 100_000;
const MAX_GROUPS = 1024;
type Row = Record<string, any>;
type Tokens = Pick<Usage, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'reasoningTokens'>;
const tokenKeys = ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'] as const;
export const usageKeys = ['userMessages', 'toolCalls', ...tokenKeys] as const;

export function unknownUsage(): Usage { return { userMessages: null, toolCalls: null, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, verified: false }; }
export function mergeUsage(target: Usage, source: Usage): void {
  for (const key of usageKeys) if (source[key] !== null) target[key] = (target[key] ?? 0) + source[key];
  target.verified &&= source.verified;
}
export interface ParsedSession {
  id: string; project: string | null; observedProjects: string[]; parentId?: string;
  model?: string; version?: string; createdAt?: string; updatedAt?: string;
  complete: boolean; inherited: boolean; usage: Usage; byDate: Record<string, Usage>; byModel: Record<string, Usage>;
  warnings: string[]; fields: {path: string; bytes: number; count: number}[];
  recordTypes: {type: string; bytes: number; count: number}[];
  images: {digest: string; bytes: number; count: number}[];
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined; }
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return;
  return new Date(value).toISOString();
}
function codexTokens(value: Row): Tokens {
  return { inputTokens: number(value.input_tokens), outputTokens: number(value.output_tokens), cachedTokens: number(value.cached_input_tokens), reasoningTokens: number(value.reasoning_output_tokens) };
}
function claudeTokens(value: Row): Tokens {
  const input = number(value.input_tokens), read = number(value.cache_read_input_tokens), write = number(value.cache_creation_input_tokens);
  return { inputTokens: input === null ? null : input + (read ?? 0) + (write ?? 0), outputTokens: number(value.output_tokens), cachedTokens: read === null && write === null ? null : (read ?? 0) + (write ?? 0), reasoningTokens: number(value.reasoning_tokens) };
}

export async function parseSession(file: FileEntry, provider: Provider, deep: boolean, signal?: AbortSignal, onBytes?: (processed: number) => void, onRecord?: (row: Row) => void): Promise<ParsedSession> {
  const child = file.relative.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/);
  const result: ParsedSession = { id: child?.[2] ?? basename(file.path, '.jsonl'), project: null, observedProjects: [], parentId: child?.[1], complete: true, inherited: false, usage: unknownUsage(), byDate: Object.create(null), byModel: Object.create(null), warnings: [], fields: [], recordTypes: [], images: [] };
  const fields = new Map<string, {path: string; bytes: number; count: number}>();
  const types = new Map<string, {type: string; bytes: number; count: number}>();
  const images = new Map<string, {digest: string; bytes: number; count: number}>();
  const userEvents = new Map<string, {date: string; model: string}>();
  const fallbackUsers = new Map<string, {date: string; model: string}>();
  const toolEvents = new Map<string, {date: string; model: string}>();
  const requests = new Map<string, {tokens: Tokens; date: string; model: string}>();
  const tokenEvents = new Map<string, {tokens: Tokens; date: string; model: string}>();
  let previousTokens: Tokens | undefined, malformed = 0, oversized = 0, validRecords = 0, identified = false;
  let model = 'unknown', lineNumber = 0;
  const warn = (message: string) => { if (!result.warnings.includes(message)) result.warnings.push(message); };
  const incomplete = (message: string) => { result.complete = false; warn(message); };
  function addIdentity(map: Map<string, {date: string; model: string}>, id: string, date: string) {
    if (map.size >= MAX_IDENTITIES && !map.has(id)) { incomplete('Event identity limit reached; counts are partial'); return; }
    map.set(id, { date, model });
  }
  function addProject(value: unknown) {
    const cwd = string(value);
    if (!cwd || !isAbsolute(cwd)) return;
    if (!result.observedProjects.includes(cwd)) result.observedProjects.push(cwd);
    result.project ??= cwd;
  }
  function addImages(value: unknown, depth = 0): void {
    if (depth > 20 || !value || typeof value !== 'object') return;
    const obj = value as Row;
    let data: string | undefined;
    if (obj.type === 'base64' && typeof obj.data === 'string' && typeof obj.media_type === 'string' && obj.media_type.startsWith('image/')) data = obj.data;
    const url = typeof obj.image_url === 'string' ? obj.image_url : obj.image_url?.url;
    if (typeof url === 'string' && /^data:image\/[^;,]+;base64,/.test(url)) data = url.slice(url.indexOf(',') + 1);
    if (typeof obj.url === 'string' && /^data:image\/[^;,]+;base64,/.test(obj.url)) data = obj.url.slice(obj.url.indexOf(',') + 1);
    if (data) {
      const normalized = data.replace(/\s/g, '');
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) && normalized.length % 4 === 0) {
        const digest = createHash('sha256').update(Buffer.from(normalized, 'base64')).digest('hex');
        if (images.size < MAX_GROUPS || images.has(digest)) {
          const item = images.get(digest) ?? { digest, bytes: 0, count: 0 };
          item.bytes += Buffer.byteLength(data); item.count++; images.set(digest, item);
        } else incomplete('Image digest limit reached; duplicate analysis is partial');
      }
      return;
    }
    for (const childValue of Object.values(obj)) addImages(childValue, depth + 1);
  }
  function fieldsFor(row: Row) {
    for (const [key, value] of Object.entries(row)) {
      const children = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([name, item]) => [`${key}.${name}`, item] as const) : [[key, value] as const];
      for (const [path, item] of children) {
        if (fields.size >= MAX_GROUPS && !fields.has(path)) { incomplete('Field group limit reached'); continue; }
        const existing = fields.get(path) ?? { path, bytes: 0, count: 0 };
        existing.bytes += Buffer.byteLength(JSON.stringify(item)); existing.count++; fields.set(path, existing);
      }
    }
  }
  function record(row: Row, bytes: number) {
    onRecord?.(row);
    validRecords++;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Row : {};
    const time = timestamp(row.timestamp) ?? timestamp(payload.timestamp);
    if (time) { result.createdAt = !result.createdAt || time < result.createdAt ? time : result.createdAt; result.updatedAt = !result.updatedAt || time > result.updatedAt ? time : result.updatedAt; }
    const date = time?.slice(0, 10) ?? 'unknown';
    if (provider === 'claude') {
      if (!child && string(row.sessionId)) {
        if (result.id !== row.sessionId) incomplete('Session identity conflicts with file name or prior records');
        result.id = row.sessionId; identified = true;
      } else if (child && string(row.sessionId)) {
        if (row.sessionId !== child[1]) incomplete('Subagent session identity conflicts with owner directory');
        result.id = string(row.agentId) ?? result.id; identified = true;
      }
      addProject(row.cwd);
      if (string(row.version) && result.version && row.version !== result.version) incomplete('Mixed session format versions require unverified compatibility');
      result.version = string(row.version) ?? result.version;
      result.inherited ||= Boolean(row.forkedFrom || row.forkedFromSessionId || row.isImported);
      model = string(row.message?.model) ?? model;
    } else {
      if (row.type === 'session_meta') {
        if (identified && string(payload.id) && result.id !== payload.id) incomplete('Multiple session identities in one rollout');
        result.id = string(payload.id) ?? result.id; identified ||= Boolean(string(payload.id));
        if (string(payload.cli_version) && result.version && payload.cli_version !== result.version) incomplete('Mixed session format versions require unverified compatibility');
        result.version = string(payload.cli_version) ?? result.version;
        result.parentId = string(payload.parent_thread_id) ?? string(payload.source?.subagent?.thread_spawn?.parent_thread_id) ?? result.parentId;
        result.inherited ||= Boolean(payload.forked_from_id || payload.forked_from || payload.imported);
      }
      addProject(payload.cwd);
      model = string(payload.model) ?? model;
    }
    if (model !== 'unknown') result.model = model;
    if (!deep) return;
    const type = String(row.type ?? 'unknown') + (provider === 'codex' && typeof payload.type === 'string' ? `/${payload.type}` : '');
    if (types.size < MAX_GROUPS || types.has(type)) {
      const item = types.get(type) ?? { type, bytes: 0, count: 0 }; item.bytes += bytes; item.count++; types.set(type, item);
    } else incomplete('Record type limit reached');
    fieldsFor(row); addImages(row);
    const identity = string(row.uuid) ?? string(row.id) ?? hash(JSON.stringify(row));
    if (provider === 'claude') {
      const message = row.message && typeof row.message === 'object' ? row.message as Row : {};
      const content = message.content;
      if (row.type === 'user' && (typeof content === 'string' || Array.isArray(content) && content.some(item => item?.type !== 'tool_result'))) addIdentity(userEvents, identity, date);
      if (Array.isArray(content)) for (const item of content) if (item?.type === 'tool_use') addIdentity(toolEvents, string(item.id) ?? `${identity}:${hash(JSON.stringify(item))}`, date);
      if (row.type === 'assistant' && message.usage && typeof message.usage === 'object') {
        const key = string(row.requestId) ?? string(message.id);
        if (!key) incomplete('Usage has no request/message identity; totals are uncertain');
        const id = key ?? identity;
        if (requests.size >= MAX_IDENTITIES && !requests.has(id)) { incomplete('Usage identity limit reached'); return; }
        const tokens = claudeTokens(message.usage);
        const prior = requests.get(id);
        if (prior) for (const key of tokenKeys) if (prior.tokens[key] !== null) tokens[key] = Math.max(tokens[key] ?? 0, prior.tokens[key]);
        requests.set(id, { tokens, date: prior?.date ?? date, model });
      }
    } else {
      if (row.type === 'event_msg' && payload.type === 'user_message') addIdentity(userEvents, string(payload.id) ?? identity, date);
      if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') addIdentity(fallbackUsers, string(payload.id) ?? identity, date);
      if (row.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(payload.type)) addIdentity(toolEvents, string(payload.call_id) ?? string(payload.id) ?? identity, date);
      if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
        const total = payload.info.total_token_usage;
        if (total && typeof total === 'object') {
          const tokens = codexTokens(total);
          const reset = previousTokens && (['inputTokens', 'outputTokens'] as const).some(key => tokens[key] !== null && previousTokens![key] !== null && tokens[key]! < previousTokens![key]!);
          const delta = { ...tokens };
          if (previousTokens && !reset) for (const key of tokenKeys) if (tokens[key] !== null && previousTokens[key] !== null) delta[key] = tokens[key]! - previousTokens[key]!;
          previousTokens = tokens;
          const key = `${date}\0${model}`;
          if (tokenEvents.size >= MAX_GROUPS && !tokenEvents.has(key)) { incomplete('Usage group limit reached'); return; }
          const event = tokenEvents.get(key);
          if (event) for (const name of tokenKeys) { if (delta[name] !== null) event.tokens[name] = (event.tokens[name] ?? 0) + delta[name]; }
          else tokenEvents.set(key, { tokens: delta, date, model });
        } else if (payload.info.last_token_usage && typeof payload.info.last_token_usage === 'object') {
          if (requests.size >= MAX_IDENTITIES && !requests.has(identity)) { incomplete('Usage identity limit reached'); return; }
          requests.set(identity, { tokens: codexTokens(payload.info.last_token_usage), date, model });
        }
      }
    }
  }
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== file.dev || before.ino !== file.ino || before.size !== file.size || before.mtimeMs !== file.mtimeMs || before.ctimeMs !== file.ctimeMs || await realpath(file.path) !== file.path) throw Object.assign(new Error(), { code: 'FILE_CHANGED' });
    const stream = handle.createReadStream({ autoClose: false, signal, highWaterMark: 64 * 1024, ...(deep || onRecord ? {} : { end: METADATA_BYTES - 1 }) });
    let pieces: Buffer[] = [], length = 0, skipping = false, processed = 0;
    const consume = (newline: boolean) => {
      lineNumber++;
      if (!skipping && length) {
        const text = Buffer.concat(pieces, length).toString('utf8').replace(/\r$/, '');
        if (text.trim()) {
          try {
            const row: unknown = JSON.parse(text);
            if (!row || typeof row !== 'object' || Array.isArray(row)) malformed++;
            else record(row as Row, length + (newline ? 1 : 0));
          } catch { malformed++; }
        }
      }
      pieces = []; length = 0; skipping = false;
    };
    for await (const chunk of stream) {
      if (signal?.aborted) { incomplete('Analysis interrupted'); break; }
      const data = chunk as Buffer;
      processed += data.length;
      let start = 0;
      for (let i = 0; i <= data.length; i++) {
        if (i !== data.length && data[i] !== 10) continue;
        if (!skipping) {
          const part = data.subarray(start, i); length += part.length;
          if (length > MAX_LINE) { oversized++; skipping = true; pieces = []; }
          else if (part.length) pieces.push(part);
        }
        if (i < data.length) consume(true);
        start = i + 1;
      }
      onBytes?.(processed);
      // Buffered reads can otherwise starve keyboard and signal handlers.
      await setImmediate();
    }
    if (!signal?.aborted && (deep || onRecord || processed < METADATA_BYTES || file.size <= METADATA_BYTES) && (length || skipping)) consume(false);
    if (!deep && !onRecord && file.size > METADATA_BYTES) incomplete('Metadata sample covers first 1 MiB only; full session structure is unverified');
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) incomplete('File changed during analysis');
  } catch (error) { incomplete(`Cannot read session: ${(error as NodeJS.ErrnoException).code ?? 'read failed'}`); }
  finally { await handle?.close().catch(() => {}); }
  if (signal?.aborted) { incomplete('Analysis interrupted'); return result; }
  if (malformed) incomplete(`${malformed} malformed JSONL line(s)`);
  if (oversized) incomplete(`${oversized} oversized JSONL line(s) skipped (8 MiB limit)`);
  if (!validRecords) incomplete('No readable session records');
  if (!identified) incomplete('No recognized provider session identity');
  for (let i = 0; i < result.observedProjects.length; i++) result.observedProjects[i] = await realpath(result.observedProjects[i]).catch(() => result.observedProjects[i]);
  result.observedProjects = [...new Set(result.observedProjects)];
  result.project = result.observedProjects[0] ?? null;
  if (result.inherited) warn('Forked/imported usage may include inherited records; excluded from verified totals');
  if (deep) {
    const users = userEvents.size ? userEvents : fallbackUsers;
    result.usage = { ...unknownUsage(), userMessages: users.size, toolCalls: toolEvents.size, verified: true };
    const group = (groups: Record<string, Usage>, key: string) => {
      if (!Object.hasOwn(groups, key) && Object.keys(groups).length >= MAX_GROUPS) { incomplete('Usage group limit reached'); key = 'unknown'; }
      return groups[key] ??= { ...unknownUsage(), userMessages: 0, toolCalls: 0, verified: true };
    };
    for (const [events, key] of [[users, 'userMessages'], [toolEvents, 'toolCalls']] as const) for (const event of events.values()) {
      group(result.byDate, event.date)[key]!++; group(result.byModel, event.model)[key]!++;
    }
    const usageEvents = provider === 'codex' && previousTokens ? tokenEvents.values() : requests.values();
    for (const event of usageEvents) {
      const usage = { ...unknownUsage(), ...event.tokens, verified: true };
      mergeUsage(result.usage, usage); mergeUsage(group(result.byDate, event.date), usage); mergeUsage(group(result.byModel, event.model), usage);
    }
    result.usage.verified = result.complete && !result.inherited && result.usage.inputTokens !== null && result.usage.outputTokens !== null;
    for (const usage of [...Object.values(result.byDate), ...Object.values(result.byModel)]) usage.verified = result.usage.verified;
  }
  result.fields = [...fields.values()]; result.recordTypes = [...types.values()]; result.images = [...images.values()];
  return result;
}
