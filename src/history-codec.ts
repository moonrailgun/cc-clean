import { constants, createZstdDecompress, zstdCompress } from 'node:zlib';
import { Readable, addAbortSignal } from 'node:stream';
import { promisify } from 'node:util';
import type { Provider } from './types.ts';
import { slimHistory, historyByteLimit, MAX_CODEX_HISTORY_BYTES, type SlimOptions } from './slim.ts';

const compress = promisify(zstdCompress);

export async function decodeHistory(input: Buffer, originalPath: string, limit = MAX_CODEX_HISTORY_BYTES, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!input.length || input.length > MAX_CODEX_HISTORY_BYTES || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CODEX_HISTORY_BYTES)
    throw new Error('History exceeds the decode limit or is empty');
  if (!originalPath.endsWith('.zst')) {
    if (input.length > limit) throw new Error('History exceeds the decoded size limit');
    return input;
  }
  const chunks: Buffer[] = [];
  let offset = 0, size = 0;
  // Node stops at the first zstd frame; validate all frames, including trailing data.
  while (offset < input.length) {
    signal?.throwIfAborted();
    const decoder = createZstdDecompress(), source = Readable.from([input.subarray(offset)]);
    if (signal) addAbortSignal(signal, decoder);
    source.on('error', error => decoder.destroy(error));
    source.pipe(decoder);
    try {
      for await (const chunk of decoder) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > limit) throw new Error('Compressed history exceeds the decoded size limit');
        chunks.push(chunk);
      }
      if (!decoder.bytesWritten) throw new Error('Compressed history contains an invalid frame');
      offset += decoder.bytesWritten;
    } finally { source.destroy(); decoder.destroy(); }
  }
  return Buffer.concat(chunks, size);
}

export async function slimStoredHistory(input: Buffer, provider: Provider, originalPath: string, options: SlimOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const decodedInput = await decodeHistory(input, originalPath, historyByteLimit(provider), signal);
  const result = slimHistory(decodedInput, provider, options), decodedOutput = result.output;
  if (!decodedOutput || !originalPath.endsWith('.zst')) return {...result, decodedInput, decodedOutput};
  const output = await compress(decodedOutput, {params: {[constants.ZSTD_c_compressionLevel]: 3}, maxOutputLength: MAX_CODEX_HISTORY_BYTES});
  signal?.throwIfAborted();
  const saved = Math.max(0, input.length - output.length);
  // Compressed categories are proportional estimates; their sum is the actual stored reduction.
  const total = Object.values(result.savingsBytes).reduce((sum, bytes) => sum + bytes, 0);
  let cumulative = 0, allocated = 0;
  for (const key of Object.keys(result.savingsBytes) as (keyof typeof result.savingsBytes)[]) {
    cumulative += result.savingsBytes[key]!;
    const next = total > 0 ? Number(BigInt(saved) * BigInt(cumulative) / BigInt(total)) : 0;
    result.savingsBytes[key] = next - allocated; allocated = next;
  }
  if (!saved) {
    for (const key of Object.keys(result.counts) as (keyof typeof result.counts)[]) result.counts[key] = 0;
    return {...result, output: null, decodedInput, decodedOutput: null};
  }
  return {...result, output, decodedInput, decodedOutput};
}
