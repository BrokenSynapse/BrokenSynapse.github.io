const maxPixels = 32_000_000;
const maxEdge = 12_000;

function inspect(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const label = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const animated = () => { throw new Error('This animated image cannot be optimized without losing frames. Choose a still image.'); };
  if (label(0, 8) === '\x89PNG\r\n\x1a\n' && bytes.length >= 33) {
    for (let pos = 8; pos + 12 <= bytes.length;) {
      const length = view.getUint32(pos);
      if (pos + length + 12 > bytes.length) throw new Error('The PNG is incomplete.');
      if (label(pos + 4, 4) === 'acTL') animated();
      pos += length + 12;
    }
    return ['image/png', view.getUint32(16), view.getUint32(20)];
  }
  if (label(0, 3) === 'GIF') animated();
  if (label(0, 4) === 'RIFF' && label(8, 4) === 'WEBP') {
    let dimensions;
    for (let pos = 12; pos + 8 <= bytes.length;) {
      const kind = label(pos, 4);
      const length = view.getUint32(pos + 4, true);
      const start = pos + 8;
      if (start + length > bytes.length) throw new Error('The WebP is incomplete.');
      const u24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      if (kind === 'ANIM' || kind === 'ANMF') animated();
      if (kind === 'VP8X' && length >= 10) {
        if (bytes[start] & 2) animated();
        dimensions = [1 + u24(start + 4), 1 + u24(start + 7)];
      } else if (!dimensions && kind === 'VP8 ' && length >= 10) {
        dimensions = [view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383];
      } else if (!dimensions && kind === 'VP8L' && length >= 5) {
        const bits = view.getUint32(start + 1, true);
        dimensions = [1 + (bits & 16383), 1 + ((bits >>> 14) & 16383)];
      }
      pos = start + length + (length & 1);
    }
    if (dimensions) return ['image/webp', ...dimensions];
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let dimensions;
    for (let pos = 2; pos + 4 <= bytes.length;) {
      if (bytes[pos++] !== 255) break;
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 218 || marker === 217) break;
      if (pos + 2 > bytes.length) break;
      const length = view.getUint16(pos);
      if (length < 2 || pos + length > bytes.length) break;
      if (marker === 226 && label(pos + 2, 4) === 'MPF\0') animated();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        dimensions = [view.getUint16(pos + 5), view.getUint16(pos + 3)];
      }
      pos += length;
    }
    if (dimensions) return ['image/jpeg', ...dimensions];
  }
  throw new Error('Choose a still PNG, JPEG, or WebP image.');
}

async function thumbnail(canvas) {
  const scale = Math.min(1, 240 / Math.max(canvas.width, canvas.height));
  const preview = new OffscreenCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
  preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
  for (const quality of [0.55, 0.35, 0.20]) {
    const blob = await preview.convertToBlob({ type: 'image/webp', quality });
    if (blob.type === 'image/webp' && blob.size <= 4800) return blob;
  }
  return null;
}

self.onmessage = async ({ data: { file, format, quality, maximum } }) => {
  let bitmap;
  try {
    const [type, width, height] = inspect(await file.arrayBuffer());
    if (!width || !height || width > maxEdge || height > maxEdge || width * height > maxPixels) {
      throw new Error('Choose an image under 32 megapixels and 12,000 pixels per side.');
    }
    bitmap = await createImageBitmap(file.slice(0, file.size, type), { imageOrientation: 'from-image' });
    const ratio = maximum ? Math.min(1, maximum / Math.max(bitmap.width, bitmap.height)) : 1;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
    const context = canvas.getContext('2d', { alpha: true });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    self.postMessage({ progress: 'Encoding ' + format.toUpperCase() + '…' });
    let output;
    if (format === 'avif') {
      const [{ default: createEncoder }, { defaultOptions }] = await Promise.all([
        import('./vendor/avif/avif_enc.js'), import('./vendor/avif/meta.js'),
      ]);
      const encoder = await createEncoder({ noInitialRun: true });
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const bytes = encoder.encode(new Uint8Array(rgba.buffer), canvas.width, canvas.height,
        { ...defaultOptions, quality, qualityAlpha: 100, speed: 7 });
      if (!bytes?.length) throw new Error('The AVIF encoder could not create an image.');
      output = new Blob([bytes], { type: 'image/avif' });
    } else {
      output = await canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 });
      if (output.type !== 'image/webp') throw new Error('WebP encoding is unavailable. Select AVIF in Settings.');
    }
    if (output.size > 10 * 1024 * 1024) throw new Error('The optimized image exceeds 10 MB. Try a smaller maximum size or lower quality.');
    self.postMessage({ output, thumbnail: await thumbnail(canvas).catch(() => null) });
  } catch (error) {
    self.postMessage({ error: error.message || 'Image optimization failed.' });
  } finally {
    bitmap?.close();
  }
};
