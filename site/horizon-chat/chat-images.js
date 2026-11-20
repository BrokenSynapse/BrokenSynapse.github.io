export function imageOptions(value = {}) {
  const quality = Number(value.quality);
  const maximum = Number(value.maximum);
  return {
    format: value.format === 'webp' ? 'webp' : 'avif',
    quality: Number.isInteger(quality) && quality >= 25 && quality <= 95 ? quality : 72,
    maximum: [0, 1280, 2048, 2560, 4096].includes(maximum) ? maximum : 2560,
  };
}

export async function isChatImage(file) {
  if (/^image\//i.test(file.type) || /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(file.name)) return true;
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const label = String.fromCharCode(...bytes);
  return label.startsWith('\x89PNG') || label.startsWith('GIF') || label.startsWith('\xff\xd8\xff') ||
    (label.startsWith('RIFF') && label.slice(8, 12) === 'WEBP') ||
    (label.slice(4, 8) === 'ftyp' && /^(avif|avis|heic|heix|mif1)$/.test(label.slice(8, 12)));
}

export function optimizeChatImage(file, options, { signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (typeof Worker !== 'function') throw new Error('Image optimization requires a browser with Web Worker support.');
    const worker = new Worker(new URL('./chat-image-worker.js', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => finish(new Error('Image optimization timed out. Try a smaller image.')), 120_000);
    const abort = () => finish(signal.reason);
    function finish(error, result) {
      clearTimeout(timer);
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    }
    signal?.addEventListener('abort', abort, { once: true });
    const { format, quality, maximum } = imageOptions(options);
    worker.onerror = () => finish(new Error('The image encoder could not start. Try reopening Horizon.'));
    worker.onmessage = ({ data }) => {
      if (data.progress) return onProgress(data.progress);
      if (data.error) return finish(new Error(data.error));
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 140) || 'image';
      finish(null, { file: new File([data.output], base + '.' + format, { type: data.output.type }), thumbnail: data.thumbnail });
    };
    onProgress('Preparing image…');
    worker.postMessage({ file, format, quality, maximum });
  });
}
