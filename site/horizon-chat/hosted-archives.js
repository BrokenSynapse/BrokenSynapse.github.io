import { apiFetch } from './platform.js';
import { inspectArchive } from './recovery-archive.js';

const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const binary = 'application/octet-stream';

export function setupHostedArchives(section) {
  const $ = name => section.querySelector('[data-hosted="' + name + '"]');
  const status = $('status');
  const list = $('list');
  let operation;
  let epoch = 0;
  async function request(path = '', options = {}) {
    const { body, isBinary, signal } = options;
    const response = await apiFetch('hosted-archives' + path, body === undefined ? { signal } : {
      method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': isBinary ? binary : 'application/json' },
      body: isBinary ? body : JSON.stringify(body), signal,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Hosted storage is unavailable.');
    return response;
  }
  async function run(work) {
    if (operation) return;
    const current = new AbortController();
    operation = current;
    $('cancel').hidden = false;
    try { await work(current.signal); }
    catch (error) {
      if (operation === current) status.textContent = error.name === 'AbortError' ? 'Hosted operation cancelled.' : error.message;
    } finally {
      if (operation === current) {
        operation = null;
        $('cancel').hidden = true;
      }
    }
  }
  async function refresh(signal) {
    const current = epoch;
    const data = await (await request('', { signal })).json();
    if (current !== epoch) return null;
    $('limit').value = data.limitMiB;
    $('days').value = data.days;
    list.replaceChildren();
    for (const item of data.archives) {
      const row = document.createElement('li');
      row.textContent = item.label + ' · ' + (item.hash ? 'Verified' : 'Upload incomplete');
      if (item.hash) {
        const download = document.createElement('button');
        download.type = 'button';
        download.textContent = 'Download';
        download.onclick = () => void run(signal => save(item, signal));
        row.append(' ', download);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove hosted copy';
      remove.onclick = () => {
        if (confirm('Remove this hosted archive?')) void run(async signal => {
          await request('/' + item.id + '/delete', { body: {}, signal });
          await refresh(signal);
          status.textContent = 'Hosted archive removed.';
        });
      };
      row.append(' ', remove);
      list.append(row);
    }
    return data;
  }
  async function save(item, signal) {
    let sink;
    try {
      if (typeof showSaveFilePicker === 'function') {
        try { sink = await (await showSaveFilePicker({ suggestedName: item.label })).createWritable(); }
        catch (error) { if (error.name !== 'SecurityError' && error.name !== 'NotSupportedError') throw error; }
      }
      const manifest = await (await request('/' + item.id + '/manifest', { signal })).json();
      const parts = [];
      for (const [index, tag] of manifest.tags.entries()) {
        signal.throwIfAborted();
        status.textContent = 'Downloading verified block ' + (index + 1) + ' of ' + manifest.tags.length + '…';
        const bytes = await (await request('/' + item.id + '/block/' + index, { signal })).arrayBuffer();
        if (bytes.byteLength !== Math.min(manifest.blockBytes, manifest.size - index * manifest.blockBytes) || await sha256(bytes) !== tag) {
          throw new Error('Downloaded archive block failed integrity verification.');
        }
        if (sink) await sink.write(bytes);
        else parts.push(bytes);
      }
      signal.throwIfAborted();
      if (sink) await sink.close();
      else {
        const link = document.createElement('a');
        const url = URL.createObjectURL(new Blob(parts, { type: binary }));
        link.href = url;
        link.download = item.label;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      status.textContent = 'Verified encrypted archive downloaded.';
    } catch (error) {
      await sink?.abort().catch(() => {});
      throw error;
    }
  }
  $('cancel').onclick = () => operation?.abort();
  $('refresh').onclick = () => void run(async signal => { await refresh(signal); status.textContent = 'Hosted archive list updated.'; });
  $('policy').onclick = () => void run(async signal => {
    await request('/settings', { body: { limitMiB: Number($('limit').value), days: Number($('days').value) }, signal });
    await refresh(signal);
    status.textContent = 'Hosted retention and quota saved.';
  });
  $('upload').onclick = () => void run(async signal => {
    const file = $('file').files[0];
    if (!file) throw new Error('Choose a local encrypted .hca file.');
    if (file.size > 1537 * 1024 * 1024) throw new Error('This archive exceeds the hosted file limit.');
    const metadata = await inspectArchive(file, document.querySelector('[data-recovery="key"]').value.trim(), signal);
    const { blockBytes } = await (await request('', { signal })).json();
    const tags = [];
    const count = Math.ceil(file.size / blockBytes);
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      status.textContent = 'Hashing encrypted block ' + (index + 1) + ' of ' + count + '…';
      tags.push(await sha256(await file.slice(index * blockBytes, (index + 1) * blockBytes).arrayBuffer()));
    }
    const title = file.name.replace(/\.hca$/i, '').replace(/[^a-zA-Z0-9 ._()-]/g, '_').slice(0, 140) || 'Horizon';
    const item = await (await request('/begin', { body: { ...metadata, label: title + '.hca', size: file.size, tags }, signal })).json();
    if (!item.hash) {
      for (let index = Math.floor(item.uploaded / blockBytes); index < count && index * blockBytes < file.size; index++) {
        if (item.uploaded === file.size) break;
        status.textContent = 'Uploading encrypted block ' + (index + 1) + ' of ' + count + '…';
        await request('/' + item.id + '/block/' + index, { body: file.slice(index * blockBytes, (index + 1) * blockBytes), isBinary: true, signal });
      }
      await request('/' + item.id + '/finish', { body: {}, signal });
    }
    await refresh(signal);
    status.textContent = 'Hosted encrypted archive verified.';
  });
  return { reset() {
    epoch++;
    operation?.abort();
    operation = null;
    $('file').value = status.textContent = '';
    $('cancel').hidden = true;
    list.replaceChildren();
  } };
}
