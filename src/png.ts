import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, deflate, inflate } from 'node:zlib';

export const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const ALLOWED = new Set('IHDR PLTE IDAT IEND cHRM gAMA iCCP sBIT sRGB bKGD hIST tRNS pHYs eXIf tIME tEXt zTXt iTXt'.split(' '));
const BEFORE_PALETTE = new Set('cHRM gAMA iCCP sBIT sRGB'.split(' '));
const BEFORE_DATA = new Set('PLTE bKGD hIST tRNS pHYs'.split(' '));
const REPEATED = new Set(['IDAT', 'tEXt', 'zTXt', 'iTXt']);
const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

interface Chunk { type: string; data: Buffer; raw: Buffer }
interface Pass { rows: number; rowBytes: number }

function requirePng(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`PNG: ${reason}`);
}

function parse(input: Buffer): { chunks: Chunk[]; passes: Pass[]; inflatedBytes: number } {
  requirePng(input.length <= MAX_PNG_BYTES, 'input exceeds 64 MiB resource limit');
  requirePng(input.subarray(0, 8).equals(SIGNATURE), 'invalid signature');
  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  let afterData = false;
  let color = 0;
  let depth = 0;
  let paletteEntries = 0;
  let passes: Pass[] = [];
  let inflatedBytes = 0;
  for (let offset = 8; offset < input.length;) {
    requirePng(chunks.length < 10_000, 'chunk count exceeds resource limit');
    requirePng(input.length - offset >= 12, 'truncated chunk header');
    const length = input.readUInt32BE(offset);
    requirePng(length <= 0x7fffffff && length <= input.length - offset - 12, 'invalid or truncated chunk length');
    const raw = input.subarray(offset, offset + length + 12);
    const type = raw.toString('latin1', 4, 8);
    requirePng(ALLOWED.has(type), `unsupported chunk ${JSON.stringify(type)}`);
    requirePng(crc32(raw.subarray(4, -4)) === raw.readUInt32BE(raw.length - 4), `CRC mismatch in ${type}`);
    requirePng(chunks.length > 0 || type === 'IHDR', 'IHDR must be first');
    requirePng(!seen.has(type) || REPEATED.has(type), `duplicate ${type}`);
    requirePng(!BEFORE_PALETTE.has(type) || (!seen.has('PLTE') && !seen.has('IDAT')), `${type} must precede PLTE and IDAT`);
    requirePng(!BEFORE_DATA.has(type) || !seen.has('IDAT'), `${type} must precede IDAT`);
    const data = raw.subarray(8, -4);
    if (seen.has('IDAT') && type !== 'IDAT') afterData = true;
    switch (type) {
      case 'IHDR': {
        requirePng(length === 13, 'invalid IHDR length');
        const width = data.readUInt32BE(0);
        const height = data.readUInt32BE(4);
        depth = data[8]; color = data[9];
        requirePng(width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff, 'invalid IHDR dimensions');
        const depths: Record<number, number[]> = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
        requirePng(depths[color]?.includes(depth), 'invalid IHDR color type or bit depth');
        requirePng(data[10] === 0 && data[11] === 0 && data[12] <= 1, 'unsupported IHDR compression/filter method or interlace');
        const channels: Record<number, number> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
        const layouts = data[12] === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
        passes = layouts.flatMap(([x, y, dx, dy]) => {
          const columns = Math.max(0, Math.ceil((width - x) / dx));
          const rows = Math.max(0, Math.ceil((height - y) / dy));
          return columns && rows ? [{rows, rowBytes: Math.ceil(columns * channels[color] * depth / 8) + 1}] : [];
        });
        inflatedBytes = passes.reduce((total, pass) => total + pass.rows * pass.rowBytes, 0);
        requirePng(Number.isSafeInteger(inflatedBytes) && inflatedBytes <= MAX_INFLATED_BYTES, 'inflated image exceeds 128 MiB resource limit');
        break;
      }
      case 'PLTE':
        requirePng(color !== 0 && color !== 4 && length > 0 && length % 3 === 0 && length <= 768, 'invalid PLTE palette');
        requirePng(!seen.has('tRNS') && !seen.has('bKGD') && !seen.has('hIST'), 'PLTE must precede palette-dependent metadata');
        paletteEntries = length / 3;
        requirePng(color !== 3 || paletteEntries <= 2 ** depth, 'PLTE exceeds bit depth');
        break;
      case 'IDAT':
        requirePng(!afterData, 'IDAT chunks must be consecutive');
        requirePng(color !== 3 || paletteEntries > 0, 'indexed PNG requires PLTE palette');
        break;
      case 'IEND':
        requirePng(length === 0, 'invalid IEND length');
        requirePng(seen.has('IDAT'), 'missing IDAT');
        requirePng(offset + 12 === input.length, 'trailing data after IEND');
        break;
      case 'gAMA': requirePng(length === 4 && data.readUInt32BE(0) > 0, 'invalid gAMA'); break;
      case 'cHRM': requirePng(length === 32, 'invalid cHRM length'); break;
      case 'sRGB': requirePng(length === 1 && data[0] <= 3 && !seen.has('iCCP'), 'invalid or conflicting sRGB'); break;
      case 'sBIT': {
        const sizes: Record<number, number> = {0: 1, 2: 3, 3: 3, 4: 2, 6: 4};
        requirePng(length === sizes[color] && data.every(value => value > 0 && value <= (color === 3 ? 8 : depth)), 'invalid sBIT');
        break;
      }
      case 'tRNS':
        requirePng((color === 0 && length === 2 && data.readUInt16BE(0) < 2 ** depth) ||
          (color === 2 && length === 6 && [0, 2, 4].every(i => data.readUInt16BE(i) < 2 ** depth)) ||
          (color === 3 && paletteEntries > 0 && length > 0 && length <= paletteEntries), 'invalid tRNS transparency');
        break;
      case 'bKGD':
        requirePng((color === 3 && length === 1 && data[0] < paletteEntries) ||
          ([0, 4].includes(color) && length === 2 && data.readUInt16BE(0) < 2 ** depth) ||
          ([2, 6].includes(color) && length === 6 && [0, 2, 4].every(i => data.readUInt16BE(i) < 2 ** depth)), 'invalid bKGD');
        break;
      case 'hIST': requirePng(paletteEntries > 0 && length === paletteEntries * 2, 'invalid hIST palette histogram'); break;
      case 'pHYs': requirePng(length === 9 && data[8] <= 1, 'invalid pHYs'); break;
      case 'tIME':
        requirePng(length === 7 && data[2] >= 1 && data[2] <= 12 && data[3] >= 1 && data[3] <= 31 && data[4] <= 23 && data[5] <= 59 && data[6] <= 60, 'invalid tIME');
        break;
      case 'eXIf':
        requirePng(length >= 8 && ['49492a00', '4d4d002a'].includes(data.subarray(0, 4).toString('hex')), 'invalid eXIf header');
        break;
      case 'tEXt': case 'zTXt': case 'iTXt': case 'iCCP': {
        const end = data.indexOf(0);
        requirePng(end >= 1 && end <= 79, `invalid ${type} keyword`);
        const keyword = data.subarray(0, end);
        requirePng(keyword.every(v => (v >= 32 && v <= 126) || v >= 161) && keyword[0] !== 32 && keyword[end - 1] !== 32 && !keyword.includes(Buffer.from('  ')), `invalid ${type} keyword`);
        if (type === 'zTXt' || type === 'iCCP') requirePng(end + 2 < length && data[end + 1] === 0, `invalid ${type} compression`);
        if (type === 'iCCP') requirePng(!seen.has('sRGB'), 'conflicting iCCP and sRGB');
        if (type === 'iTXt') {
          const languageEnd = data.indexOf(0, end + 3);
          const translatedEnd = data.indexOf(0, languageEnd + 1);
          requirePng(end + 4 < length && data[end + 1] <= 1 && data[end + 2] === 0 && languageEnd >= end + 3 && translatedEnd > languageEnd, 'invalid iTXt header');
        }
        break;
      }
    }
    seen.add(type);
    chunks.push({type, data, raw});
    offset += length + 12;
  }
  requirePng(seen.has('IEND'), 'missing IEND');
  return {chunks, passes, inflatedBytes};
}

async function inflateBounded(input: Buffer, limit: number, label: string): Promise<Buffer> {
  try {
    const result = await inflateAsync(input, {info: true, maxOutputLength: limit}) as unknown as {buffer: Buffer; engine: {bytesWritten: number}};
    requirePng(result.engine.bytesWritten === input.length, `trailing data in ${label} zlib stream`);
    return result.buffer;
  } catch (error) {
    throw new Error(`PNG: invalid ${label} or decompression limit: ${(error as Error).message}`);
  }
}

/** Recompress only IDAT; return null when the validated PNG cannot be made smaller. */
export async function recompressPng(input: Buffer): Promise<Buffer | null> {
  const {chunks, passes, inflatedBytes} = parse(input);
  let metadataBudget = 16 * 1024 * 1024;
  for (const {type, data} of chunks) {
    let start = -1;
    if (type === 'iCCP' || type === 'zTXt') start = data.indexOf(0) + 2;
    if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      if (data[keywordEnd + 1] === 1) start = data.indexOf(0, data.indexOf(0, keywordEnd + 3) + 1) + 1;
    }
    if (start >= 0) {
      requirePng(metadataBudget > 0, 'metadata decompression resource limit');
      const decoded = await inflateBounded(data.subarray(start), metadataBudget, type);
      metadataBudget -= decoded.length;
    }
  }
  const originalIdat = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data));
  const scanlines = await inflateBounded(originalIdat, inflatedBytes, 'IDAT');
  requirePng(scanlines.length === inflatedBytes, 'incorrect inflated scanline length');
  let offset = 0;
  for (const pass of passes) {
    for (let row = 0; row < pass.rows; row++) {
      requirePng(scanlines[offset] <= 4, 'invalid scanline filter');
      offset += pass.rowBytes;
    }
  }
  const compressed = await deflateAsync(scanlines, {level: 9});
  const size = input.length - chunks.filter(chunk => chunk.type === 'IDAT').reduce((total, chunk) => total + chunk.raw.length, 0) + compressed.length + 12;
  if (size >= input.length) return null;
  const verified = await inflateBounded(compressed, inflatedBytes, 'IDAT');
  requirePng(createHash('sha256').update(scanlines).digest().equals(createHash('sha256').update(verified).digest()), 'recompression scanline verification failed');
  const idat = Buffer.alloc(compressed.length + 12);
  idat.writeUInt32BE(compressed.length);
  idat.write('IDAT', 4, 'ascii');
  compressed.copy(idat, 8);
  idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
  let inserted = false;
  return Buffer.concat([SIGNATURE, ...chunks.flatMap(chunk => {
    if (chunk.type !== 'IDAT') return [chunk.raw];
    if (inserted) return [];
    inserted = true;
    return [idat];
  })]);
}
