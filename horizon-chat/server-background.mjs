const maxBytes = 12_000_000;
export const backgroundJsonLimit = Math.ceil(maxBytes / 3) * 4 + 310_000;

function jpegSize(body) {
  let offset = 2;
  let orientation = 1;
  let size;
  while (offset + 4 < body.length && body[offset++] === 0xff) {
    while (body[offset] === 0xff) offset++;
    const marker = body[offset++];
    if (marker === 0xda) break;
    if (offset + 2 > body.length) return null;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) return null;
    const data = body.subarray(offset + 2, offset + length);
    if (marker === 0xe1 && data.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) orientation = exifOrientation(data.subarray(6));
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && data.length >= 6) {
      size = [data.readUInt16BE(3), data.readUInt16BE(1)];
    }
    offset += length;
  }
  return orientation >= 5 ? size?.reverse() : size;
}

function exifOrientation(data) {
  if (data.length < 8) return 1;
  const order = data.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const word = order === 'II' ? offset => data.readUInt16LE(offset) : offset => data.readUInt16BE(offset);
  const long = order === 'II' ? offset => data.readUInt32LE(offset) : offset => data.readUInt32BE(offset);
  if (word(2) !== 42) return 1;
  const table = long(4);
  if (table + 2 > data.length) return 1;
  const count = word(table);
  for (let i = 0; i < count; i++) {
    const offset = table + 2 + i * 12;
    if (offset + 12 > data.length) break;
    if (word(offset) === 0x112 && word(offset + 2) === 3 && long(offset + 4) === 1) {
      const value = word(offset + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function imageInfo(body) {
  if (body.length < 25) return null;
  const signature = body.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    if (body.at(-1) === 0x3b) return ['image/gif', [body.readUInt16LE(6), body.readUInt16LE(8)]];
  } else if (body.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    if (body.readUInt32BE(8) !== 13 || body.toString('ascii', 12, 16) !== 'IHDR' ||
        body.toString('ascii', body.length - 8, body.length - 4) !== 'IEND') return null;
    const size = [body.readUInt32BE(16), body.readUInt32BE(20)];
    for (let offset = 8; offset + 12 <= body.length;) {
      const length = body.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > body.length) return null;
      if (body.toString('ascii', offset + 4, offset + 8) === 'eXIf' &&
          exifOrientation(body.subarray(offset + 8, end - 4)) >= 5) size.reverse();
      offset = end;
    }
    return ['image/png', size];
  } else if (body[0] === 0xff && body[1] === 0xd8 && body.at(-2) === 0xff && body.at(-1) === 0xd9) {
    return ['image/jpeg', jpegSize(body)];
  } else if (body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP' &&
      body.readUInt32LE(4) === body.length - 8) {
    let size;
    let orientation = 1;
    for (let offset = 12; offset + 8 <= body.length;) {
      const type = body.toString('ascii', offset, offset + 4);
      const length = body.readUInt32LE(offset + 4);
      const end = offset + 8 + length;
      if (end + length % 2 > body.length) return null;
      const data = body.subarray(offset + 8, end);
      if (type === 'VP8X' && length === 10) size = [data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1];
      if (!size && type === 'VP8L' && length > 5 && data[0] === 0x2f) {
        const bits = data.readUInt32LE(1);
        size = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      }
      if (!size && type === 'VP8 ' && length > 10 && data.subarray(3, 6).toString('hex') === '9d012a') {
        size = [data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff];
      }
      if (type === 'EXIF') {
        const tiff = data.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? data.subarray(6) : data;
        orientation = exifOrientation(tiff);
      }
      offset = end + length % 2;
    }
    return ['image/webp', orientation >= 5 ? size?.reverse() : size];
  }
  return null;
}

export function decodeServerBackground(value) {
  if (value === '') return null;
  if (typeof value !== 'string' || value.length > backgroundJsonLimit) {
    throw new Error('Choose a server background up to 12 MB.');
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match) {
    const [, mime, encoded] = match;
    const body = Buffer.from(encoded, 'base64');
    if (body.length > maxBytes) throw new Error('Choose a server background up to 12 MB.');
    if (body.toString('base64') === encoded) {
      const [detected, size] = imageInfo(body) || [];
      if (detected === mime && size?.every(Number.isInteger) && size[0] > 0 && size[1] > 0) {
        if (size[0] > 1920 || size[1] > 1080) throw new Error('Server backgrounds must fit within 1920 × 1080 pixels.');
        return { body, mime };
      }
    }
  }
  throw new Error('Choose a valid PNG, JPEG, WebP, or GIF server background.');
}
