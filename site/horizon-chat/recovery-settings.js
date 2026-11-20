import { apiFetch } from './platform.js';
import { createArchive, newRecoveryKey, openChain } from './recovery-archive.js';

const base = 'recovery-archive/';

export function setupRecoverySettings(section, { onRestore, onUnauthorized }) {
  const control = name => section.querySelector('[data-recovery="' + name + '"]');
  const key = control('key');
  const files = control('files');
  const status = control('status');
  const summary = control('summary');
  const rows = control('rows');
  const restore = control('restore');
  let operation;
  let prepared;

  function invalidate() {
    prepared = null;
    summary.hidden = true;
    rows.replaceChildren();
  }

  function progress(label) {
    return (done, total) => { status.textContent = label + ' ' + done + ' of ' + total + ' images…'; };
  }

  async function request(route, { body, binary = false, signal } = {}) {
    const response = await apiFetch(base + route, body === undefined ? { signal } : {
      method: 'POST',
      headers: { 'X-Horizon-Chat': '1', 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ? body : JSON.stringify(body), signal,
    });
    if (response.ok) return response;
    const failure = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthorized();
    throw new Error(failure.error || 'Could not reach the account recovery service.');
  }

  async function run(work) {
    if (operation) return;
    const current = new AbortController();
    operation = current;
    for (const item of section.querySelectorAll('button,input')) item.disabled = true;
    control('cancel').hidden = false;
    control('cancel').disabled = false;
    try { await work(current.signal); }
    catch (error) {
      if (operation === current) status.textContent = error.name === 'AbortError' ? 'Recovery operation cancelled.' : error.message;
    } finally {
      if (operation === current) {
        operation = null;
        for (const item of section.querySelectorAll('button,input')) item.disabled = false;
        control('cancel').hidden = true;
      }
    }
  }

  async function exportArchive(incremental, signal) {
    const keyText = key.value.trim();
    if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('Generate or enter a recovery key before exporting.');
    status.textContent = 'Preparing encrypted archive…';
    const filename = 'Horizon-' + (incremental ? 'incremental-' : 'full-') + new Date().toISOString().replace(/[:.]/g, '-') + '.hca';
    let sink;
    try {
      if (typeof showSaveFilePicker === 'function') {
        try {
          const handle = await showSaveFilePicker({
            suggestedName: filename, types: [{ description: 'Horizon recovery archive', accept: { 'application/octet-stream': ['.hca'] } }],
          });
          sink = await handle.createWritable();
        } catch (error) {
          if (error.name !== 'SecurityError' && error.name !== 'NotSupportedError') throw error;
        }
      }
      const parent = incremental ? await openChain([...files.files], keyText, { signal, progress: progress('Verifying') }) : null;
      if (parent?.count >= 32) throw new Error('Create a new full archive before adding another incremental.');
      const data = await (await request('export', { signal })).json();
      const { file } = await createArchive(data, keyText, {
        parent, signal, sink, progress: progress('Archiving'),
        loadAsset: async asset => (await request('export/' + data.ticket + '/' + asset.id, { signal })).arrayBuffer(),
      });
      signal.throwIfAborted();
      if (sink) await sink.close();
      else {
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      status.textContent = 'Archive exported. Keep the recovery key separately from the archive files.';
    } catch (error) {
      await sink?.abort().catch(() => {});
      throw error;
    }
  }

  control('generate').onclick = () => {
    key.value = newRecoveryKey();
    key.type = 'text';
    key.select();
    invalidate();
    status.textContent = 'Copy this recovery key to a safe place. Horizon does not keep a copy.';
  };
  key.oninput = files.onchange = invalidate;
  control('full').onclick = () => void run(signal => exportArchive(false, signal));
  control('incremental').onclick = () => void run(signal => exportArchive(true, signal));
  control('cancel').onclick = () => operation?.abort();
  control('preview').onclick = () => void run(async signal => {
    invalidate();
    const chain = await openChain([...files.files], key.value.trim(), { signal, progress: progress('Verifying') });
    const { characters, assets, theme } = chain.manifest;
    const plan = { characters, assets, theme };
    const preview = await (await request('preview', { body: plan, signal })).json();
    signal.throwIfAborted();
    prepared = { chain, plan };
    control('theme').checked = false;
    control('theme').parentElement.hidden = !theme;
    control('details').textContent = assets.length + ' verified images in ' + chain.count + ' archive file(s). Existing characters with matching names and triggers are skipped.';
    for (const row of preview.characters) {
      const item = document.createElement('li');
      item.textContent = row.name + ' (' + row.variants + ' variants)' + (row.conflict ? ' · Existing character, skip' : '');
      rows.append(item);
    }
    summary.hidden = false;
    summary.focus();
    status.textContent = 'Archive verified. Review the preview before restoring.';
  });
  restore.onclick = () => void run(async signal => {
    if (!prepared) throw new Error('Preview the archive before restoring.');
    const { chain, plan } = prepared;
    const { ticket } = await (await request('restore', {
      body: { ...plan, restoreTheme: control('theme').checked }, signal,
    })).json();
    const route = 'restore/' + ticket + '/';
    function report(result) {
      invalidate();
      status.textContent = 'Restored ' + result.restored + ' characters. Skipped ' + result.skipped + ' existing characters.';
      void onRestore().catch(() => {});
    }
    try {
      for (const [index, asset] of plan.assets.entries()) {
        progress('Staging')(index, plan.assets.length);
        const bytes = await chain.readAsset(asset, signal);
        await request(route + asset.id, { body: bytes, binary: true, signal });
      }
      signal.throwIfAborted();
      control('cancel').disabled = true;
      status.textContent = 'Committing verified characters…';
      const result = await (await request(route + 'commit', { body: {} })).json();
      report(result);
    } catch (error) {
      const outcome = await request(route + 'cancel', { body: {} }).then(response => response.json()).catch(() => null);
      if (Number.isInteger(outcome?.restored)) return report(outcome);
      throw error;
    }
  });

  return { reset() {
    operation?.abort();
    operation = null;
    invalidate();
    key.value = files.value = status.textContent = '';
    key.type = 'password';
    for (const item of section.querySelectorAll('button,input')) item.disabled = false;
    control('cancel').hidden = true;
  } };
}
