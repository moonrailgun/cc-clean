import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { recompressPng, MAX_PNG_BYTES } from '../src/png.ts';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function header(width = 32, height = 32, depth = 8, color = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = color; data[12] = interlace;
  return chunk('IHDR', data);
}
function png(chunks: Buffer[]): Buffer { return Buffer.concat([signature, ...chunks]); }
function rows(width = 32, height = 32, depth = 8): Buffer {
  const rowSize = width * 4 * depth / 8 + 1;
  const data = Buffer.alloc(rowSize * height, 42);
  for (let y = 0; y < height; y++) data[y * rowSize] = y % 5;
  return data;
}
function sample(raw = rows(), extra: Buffer[] = [], level = 0): Buffer {
  return png([header(), ...extra, chunk('IDAT', deflateSync(raw, { level })), chunk('IEND')]);
}
function readChunks(input: Buffer): {type: string; data: Buffer; raw: Buffer}[] {
  const result = [];
  for (let offset = 8; offset < input.length;) {
    const size = input.readUInt32BE(offset);
    const raw = input.subarray(offset, offset + size + 12);
    assert.equal(crc32(raw.subarray(4, -4)), raw.readUInt32BE(raw.length - 4));
    result.push({type: raw.toString('ascii', 4, 8), data: raw.subarray(8, -4), raw});
    offset += size + 12;
  }
  return result;
}
function inflated(input: Buffer): Buffer {
  return inflateSync(Buffer.concat(readChunks(input).filter(c => c.type === 'IDAT').map(c => c.data)));
}

for (const depth of [8, 16]) {
  test(`recompresses transparent ${depth}-bit PNG without changing scanlines or metadata`, async () => {
    const raw = rows(32, 32, depth);
    const compressed = deflateSync(raw, {level: 0});
    const original = png([
      header(32, 32, depth), chunk('gAMA', Buffer.from('0000b18f', 'hex')),
      chunk('tEXt', Buffer.from('Author\0synthetic fixture')),
      chunk('IDAT', compressed.subarray(0, 13)), chunk('IDAT', compressed.subarray(13)),
      chunk('iTXt', Buffer.from('Comment\0\0\0\0\0透明测试')), chunk('IEND'),
    ]);
    const snapshot = Buffer.from(original);
    const result = await recompressPng(original);
    assert.ok(result && result.length < original.length);
    assert.deepEqual(inflated(result), raw);
    assert.deepEqual(readChunks(result).filter(c => c.type !== 'IDAT').map(c => c.raw),
      readChunks(original).filter(c => c.type !== 'IDAT').map(c => c.raw));
    assert.deepEqual(original, snapshot);
  });
}

test('keeps an already compressed PNG unchanged', async () => {
  assert.equal(await recompressPng(sample(rows(), [], 9)), null);
});

test('supports indexed transparency and sub-byte grayscale data', async () => {
  const indexed = png([header(32, 32, 1, 3), chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
    chunk('tRNS', Buffer.from([0, 255])), chunk('IDAT', deflateSync(Buffer.alloc(32 * 5), {level: 0})), chunk('IEND')]);
  const result = await recompressPng(indexed);
  assert.ok(result);
  assert.deepEqual(inflated(result), Buffer.alloc(160));
  const gray = png([header(32, 32, 1, 0), chunk('IDAT', deflateSync(Buffer.alloc(160), {level: 0})), chunk('IEND')]);
  assert.ok(await recompressPng(gray));
});

test('accepts Adam7 scanlines without changing the interlace encoding', async () => {
  // An 8x8 RGBA image has pass sizes 1x1, 1x1, 2x1, 2x2, 4x2, 4x4 and 8x4.
  const raw = Buffer.alloc(5 + 5 + 9 + 18 + 34 + 68 + 132);
  const original = png([header(8, 8, 8, 6, 1), chunk('IDAT', deflateSync(raw, {level: 0})), chunk('IEND')]);
  const result = await recompressPng(original);
  assert.ok(result);
  assert.deepEqual(inflated(result), raw);
  assert.equal(readChunks(result)[0].data[12], 1);
});

for (const type of ['acTL', 'fcTL', 'fdAT', 'dSIG', 'zzZZ']) {
  test(`refuses unsupported ${type} chunks`, async () => {
    await assert.rejects(recompressPng(sample(rows(), [chunk(type)])), /unsupported|APNG|signature/i);
  });
}

test('rejects a bad PNG signature, CRC, truncated chunk, and trailing bytes', async () => {
  const original = sample();
  const badSignature = Buffer.from(original); badSignature[0] = 0;
  const badCrc = Buffer.from(original); badCrc[30] ^= 1;
  const hugeLength = Buffer.from(original); hugeLength.writeUInt32BE(0x7fffffff, 8);
  for (const malformed of [badSignature, badCrc, hugeLength, original.subarray(0, -1), Buffer.concat([original, Buffer.from('extra')])]) {
    await assert.rejects(recompressPng(malformed), /signature|CRC|truncated|length|trailing/i);
  }
});

test('requires one first IHDR, consecutive IDAT, and one final IEND', async () => {
  const idat = chunk('IDAT', deflateSync(rows()));
  const cases = [
    [idat, header(), chunk('IEND')], [header(), header(), idat, chunk('IEND')],
    [header(), chunk('IEND')], [header(), idat], [header(), idat, chunk('IEND'), chunk('IEND')],
    [header(), idat, chunk('tEXt', Buffer.from('Key\0value')), idat, chunk('IEND')],
  ];
  for (const malformed of cases) await assert.rejects(recompressPng(png(malformed)), /IHDR|IDAT|IEND|trailing/i);
});

test('rejects invalid dimensions, depth/color combinations, and header methods', async () => {
  const headers = [header(0), header(32, 0), header(32, 32, 4, 6), header(32, 32, 8, 5), header(32, 32, 8, 6, 2)];
  for (const index of [10, 11]) {
    const data = header().subarray(8, -4); data[index] = 1; headers.push(chunk('IHDR', data));
  }
  for (const ihdr of headers) {
    await assert.rejects(recompressPng(png([ihdr, chunk('IDAT', deflateSync(rows())), chunk('IEND')])), /IHDR|dimension|depth|color|method|interlace/i);
  }
});

test('rejects missing palette and invalid metadata sizes or ordering', async () => {
  const idat = chunk('IDAT', deflateSync(rows()));
  for (const parts of [
    [header(32, 32, 8, 3), idat],
    [header(), chunk('gAMA', Buffer.alloc(3)), idat],
    [header(), idat, chunk('gAMA', Buffer.from('0000b18f', 'hex'))],
    [header(), chunk('pHYs', Buffer.alloc(9)), chunk('pHYs', Buffer.alloc(9)), idat],
    [header(), chunk('tRNS', Buffer.from([1])), idat],
  ]) await assert.rejects(recompressPng(png([...parts, chunk('IEND')])), /palette|PLTE|gAMA|pHYs|tRNS/i);
});

test('rejects a damaged, truncated, or trailing zlib stream', async () => {
  const compressed = deflateSync(rows());
  const badChecksum = Buffer.from(compressed); badChecksum[badChecksum.length - 1] ^= 1;
  for (const bad of [badChecksum, compressed.subarray(0, -1), Buffer.concat([compressed, Buffer.from('extra')]), Buffer.concat([compressed, compressed])]) {
    await assert.rejects(recompressPng(png([header(), chunk('IDAT', bad), chunk('IEND')])), /IDAT|zlib|trailing/i);
  }
});

test('rejects incorrect scanline lengths, illegal filters, and inflated data bombs', async () => {
  const badFilter = rows(); badFilter[0] = 5;
  for (const raw of [rows().subarray(1), Buffer.concat([rows(), Buffer.from([0])]), badFilter, Buffer.alloc(1024 * 1024)]) {
    await assert.rejects(recompressPng(sample(raw)), /scanline|filter|limit|IDAT|length/i);
  }
});

test('rejects input and declared decompression sizes above the resource limits', async () => {
  await assert.rejects(recompressPng(Buffer.alloc(MAX_PNG_BYTES + 1)), /limit|large/i);
  await assert.rejects(recompressPng(png([header(100_000, 100_000), chunk('IDAT', deflateSync(Buffer.from([0]))), chunk('IEND')])), /limit|large/i);
});

test('bounds chunk-count overhead for tiny chunk floods', async () => {
  const emptyIdats = Array.from({length: 10_001}, () => chunk('IDAT'));
  await assert.rejects(recompressPng(png([header(), ...emptyIdats, chunk('IEND')])), /chunk.*limit|many chunks/i);
});

test('preserves ICC, EXIF, and compressed text chunks byte for byte', async () => {
  const metadata = [
    chunk('iCCP', Buffer.concat([Buffer.from('Profile\0\0'), deflateSync(Buffer.alloc(128))])),
    chunk('zTXt', Buffer.concat([Buffer.from('Author\0\0'), deflateSync(Buffer.from('synthetic'))])),
    chunk('iTXt', Buffer.concat([Buffer.from('Comment\0\x01\0\0\0'), deflateSync(Buffer.from('透明'))])),
    chunk('eXIf', Buffer.from('49492a0008000000000000000000', 'hex')),
  ];
  const original = sample(rows(), metadata);
  const result = await recompressPng(original);
  assert.ok(result);
  assert.deepEqual(readChunks(result).filter(c => c.type !== 'IDAT').map(c => c.raw),
    readChunks(original).filter(c => c.type !== 'IDAT').map(c => c.raw));
});

test('rejects malformed compressed metadata and bounds its total expansion', async () => {
  const invalid = chunk('zTXt', Buffer.concat([Buffer.from('Author\0\0'), Buffer.from('broken zlib')]));
  await assert.rejects(recompressPng(sample(rows(), [invalid])), /zTXt|metadata|zlib/i);
  const bomb = chunk('zTXt', Buffer.concat([Buffer.from('Author\0\0'), deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1))]));
  await assert.rejects(recompressPng(sample(rows(), [bomb])), /limit|metadata/i);
});
