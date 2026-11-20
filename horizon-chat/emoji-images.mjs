import { crc32, inflateSync } from 'node:zlib';

const maxBytes = 220 * 1024;
const maxSide = 128;
const dimensions = (width, height) => width > 0 && width <= maxSide && height > 0 && height <= maxSide;

function png(body) {
  if (body.length < 45 || body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      body.toString('ascii', 12, 16) !== 'IHDR' || body.readUInt32BE(8) !== 13 ||
      !dimensions(body.readUInt32BE(16), body.readUInt32BE(20))) return false;
  const [depth, color, compression, filter, interlace] = body.subarray(24, 29);
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || compression || filter || interlace > 1) return false;
  const width = body.readUInt32BE(16);
  const height = body.readUInt32BE(20);
  const bits = depth * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]);
  function checkRows(data, width, height) {
    const passes = interlace
      ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
      : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => {
      const columns = Math.ceil((width - x) / dx);
      const count = Math.ceil((height - y) / dy);
      return [Math.ceil(columns * bits / 8) + 1, columns > 0 && count > 0 ? count : 0];
    });
    const length = rows.reduce((sum, [stride, count]) => sum + stride * count, 0);
    const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: length });
    if (decoded.length !== length) return false;
    let position = 0;
    for (const [stride, count] of rows) {
      for (let row = 0; row < count; row++, position += stride) if (decoded[position] > 4) return false;
    }
    return true;
  }
  const data = [];
  let frame;
  let frames = 0;
  let frameCount = 0;
  let sequence = 0;
  const finishFrame = () => !frame || (frame.default ? !frame.data.length : checkRows(frame.data, frame.width, frame.height));
  for (let offset = 8; offset + 12 <= body.length;) {
    const length = body.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > body.length || crc32(body.subarray(offset + 4, end)) !== body.readUInt32BE(end)) return false;
    const type = body.toString('ascii', offset + 4, offset + 8);
    const chunk = body.subarray(offset + 8, end);
    if (type === 'acTL') {
      if (length !== 8 || frames || data.length) return false;
      frames = chunk.readUInt32BE();
      if (!frames || frames > 300) return false;
    } else if (type === 'fcTL') {
      if (length !== 26 || !frames || ++frameCount > frames ||
          chunk.readUInt32BE() !== sequence++ || !finishFrame()) return false;
      const w = chunk.readUInt32BE(4);
      const h = chunk.readUInt32BE(8);
      const x = chunk.readUInt32BE(12);
      const y = chunk.readUInt32BE(16);
      const isDefault = !data.length;
      if (!dimensions(w, h) || w + x > width || h + y > height ||
          (isDefault && (w !== width || h !== height)) || chunk[24] > 2 || chunk[25] > 1) return false;
      frame = { width: w, height: h, data: [], default: isDefault };
    } else if (type === 'fdAT') {
      if (!frame || frame.default || length < 5 || chunk.readUInt32BE() !== sequence++) return false;
      frame.data.push(chunk.subarray(4));
    } else if (type === 'IDAT') {
      data.push(chunk);
    } else if (type === 'IEND') {
      return !length && end + 4 === body.length && data.length > 0 && frameCount === frames &&
        finishFrame() && checkRows(data, width, height);
    }
    offset = end + 4;
  }
  return false;
}

function webpFrame(type, data) {
  if (type === 'VP8L' && data.length >= 6 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1);
    return bits >>> 29 === 0 && dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (type === 'VP8 ' && data.length > 10 && !(data[0] & 1) && data.subarray(3, 6).toString('hex') === '9d012a') {
    return dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
  }
  return false;
}

function webpChunks(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end + (length % 2) > buffer.length) return [];
    chunks.push([buffer.toString('ascii', offset, offset + 4), buffer.subarray(offset + 8, end)]);
    offset = end + (length % 2);
  }
  return offset === buffer.length ? chunks : [];
}

function webp(body) {
  if (body.length < 20 || body.toString('ascii', 0, 4) !== 'RIFF' ||
      body.toString('ascii', 8, 12) !== 'WEBP' || body.readUInt32LE(4) !== body.length - 8) return false;
  const chunks = webpChunks(body.subarray(12));
  const extended = chunks.find(([type]) => type === 'VP8X')?.[1];
  if (extended && (extended.length !== 10 || !dimensions(extended.readUIntLE(4, 3) + 1, extended.readUIntLE(7, 3) + 1))) return false;
  const frames = chunks.filter(([type]) => type === 'ANMF');
  if (!frames.length) return chunks.some(([type, data]) => webpFrame(type, data));
  return Boolean(extended?.[0] & 2) && frames.length <= 300 && frames.every(([, data]) => {
    if (data.length <= 16) return false;
    const width = data.readUIntLE(6, 3) + 1;
    const height = data.readUIntLE(9, 3) + 1;
    return dimensions(width, height) &&
      width + 2 * data.readUIntLE(0, 3) <= extended.readUIntLE(4, 3) + 1 &&
      height + 2 * data.readUIntLE(3, 3) <= extended.readUIntLE(7, 3) + 1 &&
      webpChunks(data.subarray(16)).some(([type, frame]) => webpFrame(type, frame));
  });
}

function gif(body) {
  if (body.length < 14 || !['GIF87a', 'GIF89a'].includes(body.toString('ascii', 0, 6))) return false;
  const width = body.readUInt16LE(6);
  const height = body.readUInt16LE(8);
  if (!dimensions(width, height)) return false;
  const colors = flags => flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0;
  let offset = 13 + colors(body[10]);
  let frames = 0;
  function skipBlocks() {
    while (offset < body.length) {
      const size = body[offset++];
      if (!size) return true;
      offset += size;
    }
    return false;
  }
  while (offset < body.length) {
    const marker = body[offset++];
    if (marker === 0x3b) return offset === body.length && frames > 0;
    if (marker === 0x21) {
      offset++;
    } else if (marker === 0x2c && offset + 9 < body.length && ++frames <= 300) {
      const frameWidth = body.readUInt16LE(offset + 4);
      const frameHeight = body.readUInt16LE(offset + 6);
      if (!dimensions(frameWidth, frameHeight) || frameWidth + body.readUInt16LE(offset) > width ||
          frameHeight + body.readUInt16LE(offset + 2) > height) return false;
      offset += 9 + colors(body[offset + 8]);
      const codeSize = body[offset++];
      if (!(codeSize >= 2 && codeSize <= 8) || !body[offset]) return false;
    } else {
      return false;
    }
    if (!skipBlocks()) return false;
  }
  return false;
}

export function validateEmojiImage(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 30) return null;
  const match = /^data:(image\/(png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const [, mime, type, encoded] = match;
  const body = Buffer.from(encoded, 'base64');
  if (body.length > maxBytes || body.toString('base64') !== encoded) return null;
  try {
    return { png, webp, gif }[type](body) ? { mime, body } : null;
  } catch {
    return null;
  }
}
