const magic = new TextEncoder().encode('HORIZHCA');
const version = 1;
const headerLength = magic.length + 1 + 16;
const maxManifest = 6 * 1024 * 1024;
const maxAsset = 4 * 1024 * 1024;
const maxTotal = 1536 * 1024 * 1024;
const maxAssets = 4096;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async data => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
const digest = /^[a-f0-9]{64}$/;
const archiveId = /^[a-f0-9]{32}$/;
const fail = message => { throw new Error(message); };

export function newRecoveryKey() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

async function importKey(value) {
  if (!/^[a-f\d]{64}$/i.test(value)) fail('Enter the 64-character recovery key.');
  return crypto.subtle.importKey('raw', Uint8Array.from(value.match(/../g), part => parseInt(part, 16)),
    'AES-GCM', false, ['encrypt', 'decrypt']);
}

function recordContext(header, index) {
  const aad = new Uint8Array(headerLength + 4);
  aad.set(header);
  new DataView(aad.buffer).setUint32(headerLength, index);
  return aad;
}

function u32(value) {
  const chunk = new Uint8Array(4);
  new DataView(chunk.buffer).setUint32(0, value);
  return chunk;
}

async function collect(stream, limit, signal) {
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('Recovery record exceeds its decoded limit.');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

async function seal(key, header, index, bytes, signal) {
  const input = new Blob([bytes]);
  const zipped = await collect(input.stream().pipeThrough(new CompressionStream('gzip')), input.size + 65536, signal);
  const compressed = zipped.length < input.size;
  const payload = await new Blob([Uint8Array.of(Number(compressed)), compressed ? zipped : input]).arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: recordContext(header, index) }, key, payload);
  return new Blob([u32(iv.length + body.byteLength), iv, body]);
}

async function openRecord(key, header, index, file, entry, limit, signal) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.slice(entry.start, entry.end).arrayBuffer());
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: recordContext(header, index),
    }, key, bytes.subarray(12)));
  } catch {
    fail('Wrong recovery key, or the archive is corrupted.');
  }
  if (plain[0] === 1) return collect(new Blob([plain.subarray(1)]).stream()
    .pipeThrough(new DecompressionStream('gzip')), limit, signal);
  if (plain[0] !== 0 || plain.length - 1 > limit) fail('Invalid recovery record.');
  return plain.subarray(1);
}

function validate(manifest, id) {
  if (manifest?.id !== id || !(manifest.parent === null || (typeof manifest.parent === 'string' && archiveId.test(manifest.parent))) ||
      !Array.isArray(manifest.assets) || manifest.assets.length > maxAssets ||
      !Array.isArray(manifest.characters) || manifest.characters.length > 500 ||
      !Array.isArray(manifest.present) || manifest.present.length > maxAssets) fail('Invalid recovery manifest.');
  const assets = new Map();
  let size = 0;
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || !digest.test(asset.id) || assets.has(asset.id) || !Number.isInteger(asset.size) ||
        asset.size < 1 || asset.size > maxAsset) fail('Invalid recovery image descriptor.');
    size += asset.size;
    assets.set(asset.id, asset);
  }
  if (size > maxTotal || new Set(manifest.present).size !== manifest.present.length ||
      manifest.present.some(id => !assets.has(id)) ||
      (manifest.parent === null && manifest.present.length !== assets.size)) fail('Invalid recovery records.');
  return assets;
}

export async function createArchive(snapshot, keyText, {
  parent = null, loadAsset, signal, sink, progress = () => {},
} = {}) {
  const header = new Uint8Array(headerLength);
  header.set(magic);
  header[magic.length] = version;
  crypto.getRandomValues(header.subarray(magic.length + 1));
  const id = hex(header.subarray(magic.length + 1));
  const previous = new Set(parent?.manifest.assets.map(asset => asset.id));
  const manifest = { id, parent: parent?.manifest.id ?? null, created: new Date().toISOString(),
    characters: snapshot.characters, theme: snapshot.theme, assets: snapshot.assets,
    present: snapshot.assets.filter(asset => !previous.has(asset.id)).map(asset => asset.id) };
  const assets = validate(manifest, id);
  const key = await importKey(keyText);
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  if (metadata.length > maxManifest) fail('The character metadata is too large.');
  if (parent) {
    for (const asset of snapshot.assets) {
      const prior = parent.assets.get(asset.id);
      if (prior && (prior.size !== asset.size || prior.mime !== asset.mime)) fail('An earlier image descriptor does not match.');
    }
  }
  const parts = [];
  const write = async part => { if (sink) await sink.write(part); else parts.push(part); };
  await write(header);
  await write(await seal(key, header, 0, metadata, signal));
  for (const [index, id] of manifest.present.entries()) {
    signal?.throwIfAborted();
    progress(index, manifest.present.length);
    const bytes = await loadAsset(assets.get(id));
    if (bytes.byteLength !== assets.get(id).size || await hash(bytes) !== id) fail('A character image failed SHA-256 verification.');
    await write(await seal(key, header, index + 1, bytes, signal));
  }
  progress(manifest.present.length, manifest.present.length);
  return { manifest, file: sink ? null : new Blob(parts, { type: 'application/octet-stream' }) };
}

async function readBundle(file, key, signal) {
  const header = new Uint8Array(await file.slice(0, headerLength).arrayBuffer());
  if (header.length !== headerLength || !magic.every((byte, index) => header[index] === byte)) fail('This is not a Horizon recovery archive.');
  if (header[magic.length] !== version) fail('This recovery archive uses an unsupported version.');
  const id = hex(header.subarray(magic.length + 1));
  let offset = headerLength;
  async function next(maximum) {
    const prefix = await file.slice(offset, offset + 4).arrayBuffer();
    if (prefix.byteLength !== 4) fail('The recovery archive is incomplete.');
    const length = new DataView(prefix).getUint32(0);
    const start = offset + 4;
    const end = start + length;
    if (length < 29 || length > maximum + 65565 || end > file.size) fail('Invalid recovery record length.');
    offset = end;
    return { start, end };
  }
  const first = await openRecord(key, header, 0, file, await next(maxManifest), maxManifest, signal);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(first));
  const assets = validate(manifest, id);
  const entries = new Map();
  for (const [index, id] of manifest.present.entries()) {
    entries.set(id, { ...(await next(maxAsset)), index: index + 1 });
  }
  if (offset !== file.size) fail('Unexpected data after the recovery archive.');
  return { manifest, assets, entries, header, file };
}

export async function inspectArchive(file, keyText, signal) {
  const { manifest } = await readBundle(file, await importKey(keyText), signal);
  return { archive: manifest.id, parent: manifest.parent, version };
}

export async function openChain(files, keyText, { signal, progress = () => {} } = {}) {
  if (!files.length || files.length > 32) fail('Choose a full archive and up to 31 incremental archives.');
  const key = await importKey(keyText);
  const bundles = new Map();
  for (const file of files) {
    const bundle = await readBundle(file, key, signal);
    if (bundles.has(bundle.manifest.id)) fail('Select each archive only once.');
    bundles.set(bundle.manifest.id, bundle);
  }
  const parents = new Set(Array.from(bundles.values(), item => item.manifest.parent));
  const tips = Array.from(bundles.values()).filter(item => !parents.has(item.manifest.id));
  if (tips.length !== 1) fail('Choose one complete recovery chain.');
  const latest = tips[0];
  const order = [];
  const seen = new Set();
  for (let current = latest; current;) {
    if (seen.has(current.manifest.id)) fail('The recovery chain has a cycle.');
    seen.add(current.manifest.id);
    order.unshift(current);
    if (current.manifest.parent && !bundles.has(current.manifest.parent)) fail('An earlier archive in this chain is missing.');
    current = bundles.get(current.manifest.parent);
  }
  if (seen.size !== bundles.size) fail('Choose only files in the same recovery chain.');
  const locations = new Map();
  for (const bundle of order) {
    for (const asset of bundle.assets.values()) {
      const entry = bundle.entries.get(asset.id);
      if (entry) {
        locations.set(asset.id, { bundle, entry, asset });
      } else {
        const earlier = locations.get(asset.id)?.asset;
        if (!earlier || earlier.size !== asset.size || earlier.mime !== asset.mime) fail('A referenced archive image is missing or inconsistent.');
      }
    }
  }
  async function readAsset(asset, currentSignal = signal) {
    const { bundle, entry } = locations.get(asset.id);
    const bytes = await openRecord(key, bundle.header, entry.index, bundle.file, entry, asset.size, currentSignal);
    if (bytes.length !== asset.size || await hash(bytes) !== asset.id) fail('A recovery image failed SHA-256 verification.');
    return bytes;
  }
  const total = order.reduce((count, bundle) => count + bundle.entries.size, 0);
  let index = 0;
  for (const bundle of order) {
    for (const [id, entry] of bundle.entries) {
      progress(index++, total);
      const asset = bundle.assets.get(id);
      const bytes = await openRecord(key, bundle.header, entry.index, bundle.file, entry, asset.size, signal);
      if (bytes.length !== asset.size || await hash(bytes) !== asset.id) fail('A recovery image failed SHA-256 verification.');
    }
  }
  progress(index, total);
  return { manifest: latest.manifest, assets: latest.assets, readAsset, count: order.length };
}
