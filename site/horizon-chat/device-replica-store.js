const limit = 2 * 1024 ** 3;
const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
const keyFor = (owner, id) => owner + ':' + id;
let database;

function db() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('horizon-trusted-replicas', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('identities');
      request.result.createObjectStore('manifests');
      request.result.createObjectStore('blocks');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
}

async function query(table, mode, action) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(table, mode);
    let request;
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onabort = () => reject(transaction.error ?? new Error('Device replica storage was interrupted.'));
    request = action(transaction.objectStore(table));
  });
}

const get = (table, key) => query(table, 'readonly', store => store.get(key));
const put = (table, key, value) => query(table, 'readwrite', store => store.put(value, key));
const remove = (table, key) => query(table, 'readwrite', store => store.delete(key));
export const loadDevice = owner => get('identities', owner);
export const saveDevice = (owner, data) => put('identities', owner, data);
export const localManifests = () => query('manifests', 'readonly', store => store.getAll());

export async function createDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))));
  return { id: crypto.randomUUID(), privateKey: pair.privateKey, publicKey };
}

export async function signDeviceChallenge(device, challenge) {
  return hex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey,
    new TextEncoder().encode('Horizon device v1:' + challenge)));
}

export function checkReplicaManifest(manifest) {
  if (!manifest || !/^[a-f0-9-]{36}$/.test(manifest.id) || !/^[a-f0-9]{64}$/.test(manifest.hash) ||
      manifest.version !== 1 || !Number.isSafeInteger(manifest.size) || manifest.size < 58 ||
      manifest.size > 1537 * 1024 ** 2 || manifest.blockBytes !== 1024 ** 2 ||
      !Array.isArray(manifest.tags) || manifest.tags.length !== Math.ceil(manifest.size / manifest.blockBytes) ||
      manifest.tags.some(tag => typeof tag !== 'string' || !/^[a-f0-9]{64}$/.test(tag))) {
    throw new Error('The replica manifest is invalid.');
  }
  return manifest;
}

async function validBlock(bytes, manifest, index) {
  return bytes && bytes.byteLength === Math.min(manifest.blockBytes, manifest.size - index * manifest.blockBytes) &&
    await sha256(bytes) === manifest.tags[index];
}

export async function replicaFile(owner, id, signal) {
  const key = keyFor(owner, id);
  const record = await get('manifests', key);
  if (!record?.complete) return null;
  const manifest = checkReplicaManifest(record);
  const parts = [];
  for (const index of manifest.tags.keys()) {
    signal?.throwIfAborted();
    const bytes = await get('blocks', key + ':' + index);
    if (!await validBlock(bytes, manifest, index)) {
      await put('manifests', key, { ...record, complete: false });
      return null;
    }
    parts.push(bytes);
  }
  return new File(parts, manifest.label, { type: 'application/octet-stream' });
}

export async function fetchReplica(owner, manifest, fetchBlock, signal, progress, persist) {
  checkReplicaManifest(manifest);
  const key = keyFor(owner, manifest.id);
  if (persist) {
    const records = await localManifests();
    const reserved = records.filter(item => item.owner !== owner || item.id !== manifest.id)
      .reduce((sum, item) => sum + item.size, 0);
    if (reserved + manifest.size > limit) throw new Error('The 2 GiB device replica limit has been reached.');
    await put('manifests', key, { ...manifest, owner, complete: false });
  }
  const parts = [];
  for (const index of manifest.tags.keys()) {
    signal?.throwIfAborted();
    progress?.(index + 1, manifest.tags.length);
    let bytes = persist ? await get('blocks', key + ':' + index) : null;
    if (!await validBlock(bytes, manifest, index)) {
      bytes = await fetchBlock(index);
      if (!await validBlock(bytes, manifest, index)) throw new Error('An encrypted replica block failed SHA-256 verification.');
      signal?.throwIfAborted();
      if (persist) await put('blocks', key + ':' + index, bytes);
    }
    if (!persist) parts.push(bytes);
  }
  signal?.throwIfAborted();
  if (persist) {
    await put('manifests', key, { ...manifest, owner, complete: true });
    return null;
  }
  return new File(parts, manifest.label, { type: 'application/octet-stream' });
}

export async function removeReplica(owner, id) {
  const key = keyFor(owner, id);
  const record = await get('manifests', key);
  if (!record) return;
  // Leave the invalid marker until all blocks are deleted so an interrupted
  // cleanup can be retried without orphaning storage.
  await put('manifests', key, { ...record, complete: false });
  for (const index of record.tags.keys()) await remove('blocks', key + ':' + index);
  await remove('manifests', key);
}
