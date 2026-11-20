import { apiFetch, isDesktop } from './platform.js';
import { openChain } from './recovery-archive.js';
import { createDeviceKey, fetchReplica, loadDevice, localManifests, removeReplica, replicaFile, saveDevice, signDeviceChallenge } from './device-replica-store.js';

function saveFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fillArchives(select, rows) {
  const previous = select.value;
  select.replaceChildren(new Option('Choose a backup', ''));
  for (const row of rows) select.add(new Option(row.label + (row.complete ? ' · on this device' : ' · hosted'), row.id));
  if (rows.some(row => row.id === previous)) select.value = previous;
}

async function chainFiles(root, rows, open, signal) {
  const files = [];
  const seen = new Set();
  const byId = new Map(rows.map(row => [row.id, row]));
  let current = root;
  while (current) {
    signal?.throwIfAborted();
    if (seen.has(current) || seen.size >= 32) throw new Error('The replica chain is invalid or too long.');
    seen.add(current);
    const row = byId.get(current);
    if (!row) throw new Error('An earlier backup is unavailable. Recover it from a hosted or local copy.');
    files.unshift(await open(row));
    current = row.parent;
  }
  if (!files.length) throw new Error('Choose the latest backup in the chain.');
  return files;
}

export function setupTrustedDevices(panel, offline) {
  if (!isDesktop || !panel || !offline) return { account() {} };
  panel.hidden = false;
  const control = name => panel.querySelector('[data-device="' + name + '"]');
  const offlineControl = name => offline.querySelector('[data-offline-replica="' + name + '"]');
  const status = control('status');
  let owner;
  let local;
  let lease;
  let operation;
  let hosted = [];
  let timer;
  let epoch = 0;

  async function request(route, { body, token, signal } = {}) {
    const headers = {};
    if (token) headers['X-Horizon-Device'] = token;
    if (body !== undefined) Object.assign(headers, { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' });
    const response = await apiFetch(route, {
      headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (token && [401, 403].includes(response.status)) lease = null;
      throw new Error(failure.error || 'Trusted-device service is unavailable.');
    }
    return response;
  }

  const get = async (path = '', signal) => (await request('trusted-devices' + path, { signal })).json();
  const post = async (path, body, signal, token) => (await request('trusted-devices/' + path, { body, signal, token })).json();

  async function signed(path, signal, extra = {}) {
    const device = local;
    if (!device) throw new Error('Register this device first.');
    const { challenge } = await post('challenge', { id: device.id }, signal);
    const signature = await signDeviceChallenge(device, challenge);
    return post(path, { challenge, signature, ...extra }, signal);
  }

  async function access(signal) {
    if (lease && lease.expiry > Date.now() + 10_000) return lease.lease;
    const next = await signed('lease', signal);
    signal?.throwIfAborted();
    lease = next;
    return lease.lease;
  }

  async function run(work) {
    if (!owner || operation) return;
    const active = new AbortController();
    operation = active;
    control('cancel').hidden = false;
    try { await work(active.signal); }
    catch (error) {
      if (operation === active) status.textContent = error.name === 'AbortError' ? 'Replica operation cancelled.' : error.message;
    } finally {
      if (operation === active) {
        operation = null;
        control('cancel').hidden = true;
      }
    }
  }

  async function refreshChoices() {
    const current = owner;
    const records = (await localManifests()).filter(item => item.owner === current);
    if (owner !== current) return;
    const rows = new Map(hosted.map(item => [item.id, item]));
    for (const record of records) {
      if (record.complete) rows.set(record.id, record);
    }
    fillArchives(control('archives'), [...rows.values()]);
    const remove = control('remove-local');
    remove.replaceChildren(new Option('Choose a local copy', ''));
    for (const record of records) remove.add(new Option(record.label + (!record.complete ? ' · incomplete' : ''), record.id));
    control('local-status').textContent = records.filter(item => item.complete).length + ' encrypted backups on this device.';
  }

  async function refresh(signal) {
    const own = owner;
    const data = await get('', signal);
    const available = await (await request('hosted-archives', { signal })).json();
    signal?.throwIfAborted();
    if (owner !== own) return;
    hosted = available.archives.filter(row => row.hash);
    const current = data.devices.find(device => device.id === local?.id);
    if (current?.state === 'approved' && local.code) {
      local = { ...local, code: '' };
      await saveDevice(own, local);
    }
    if (current?.state === 'revoked' && local.automatic) {
      local = { ...local, automatic: false };
      control('automatic').checked = false;
      await saveDevice(own, local);
    }
    signal?.throwIfAborted();
    if (current?.state !== 'approved') lease = null;
    control('register').hidden = current?.state === 'approved' || current?.state === 'pending';
    control('bootstrap').hidden = !data.bootstrap || current?.state !== 'pending';
    control('password').parentElement.hidden = control('bootstrap').hidden;
    control('label').parentElement.hidden = control('register').hidden;
    control('approval-code').parentElement.hidden = current?.state !== 'approved' ||
      !data.devices.some(device => device.state === 'pending');
    control('automatic').parentElement.hidden = control('sync').hidden = current?.state !== 'approved';
    control('code').textContent = current?.state === 'pending' ? local.code : '';
    control('current').textContent = 'This device · ' + (current?.state ?? 'not registered');
    control('automatic').disabled = current?.state !== 'approved';
    control('sync').disabled = current?.state !== 'approved';
    const devices = control('list');
    devices.replaceChildren();
    for (const entry of data.devices) {
      const row = document.createElement('li');
      const recent = entry.lastSeen && Date.now() - entry.lastSeen < 150_000;
      row.textContent = entry.label + ' · ' + entry.state + (entry.state === 'approved' ? (recent ? ' · recently seen' : ' · offline or idle') +
        ' · ' + entry.replicas + ' verified hosted copies' : '');
      if (current?.state === 'approved' && entry.state !== 'revoked') {
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = entry.state === 'pending' ? 'Approve ' + entry.label : 'Revoke ' + entry.label;
        action.onclick = () => {
          if (entry.state !== 'pending' && !confirm('Revoke ' + entry.label + ' for future replica transfers?')) return;
          void run(async signal => {
            const accepting = entry.state === 'pending';
            await post(accepting ? 'approve' : 'revoke', {
              id: entry.id, ...(accepting ? { code: control('approval-code').value.trim() } : {}),
            }, signal, await access(signal));
            control('approval-code').value = '';
            await refresh(signal);
            status.textContent = accepting ? 'Device approved.' : 'Device access revoked.';
          });
        };
        row.append(' ', action);
      }
      devices.append(row);
    }
    await refreshChoices();
    return current;
  }

  async function sync(signal) {
    const current = owner;
    if ((await refresh(signal))?.state !== 'approved') throw new Error('An approved device is required to synchronize.');
    const read = async path => request('trusted-devices/replica' + path, { token: await access(signal), signal });
    const { archives } = await (await read('')).json();
    const known = new Map((await localManifests()).filter(item => item.owner === current && item.complete)
      .map(row => [row.id, row.hash]));
    let saved = 0;
    for (const row of archives.filter(item => item.hash).reverse()) {
      if (known.get(row.id) === row.hash) continue;
      signal.throwIfAborted();
      const manifest = await (await read('/' + row.id + '/manifest')).json();
      await fetchReplica(current, manifest, async index =>
        (await read('/' + row.id + '/block/' + index)).arrayBuffer(), signal,
      (index, total) => { status.textContent = 'Replicating ' + row.label + ' · block ' + index + ' of ' + total; }, true);
      await post('replica/receipt', { id: row.id, hash: row.hash }, signal, await access(signal));
      saved++;
    }
    await refresh(signal);
    status.textContent = saved ? 'Verified ' + saved + ' new encrypted device copies.' : 'Device replicas are up to date.';
  }

  control('register').onclick = () => void run(async signal => {
    const label = control('label').value.trim();
    if (!label) throw new Error('Enter a name for this device.');
    const device = await createDeviceKey();
    const { code } = await post('register', { id: device.id, label, publicKey: device.publicKey }, signal);
    signal.throwIfAborted();
    local = { ...device, code, automatic: false };
    await saveDevice(owner, local);
    await refresh(signal);
    status.textContent = 'Device registered. Approve it before synchronizing.';
  });
  control('bootstrap').onclick = () => void run(async signal => {
    const password = control('password').value;
    control('password').value = '';
    await signed('bootstrap', signal, { password });
    await refresh(signal);
    status.textContent = 'First trusted device approved.';
  });
  control('refresh').onclick = () => void run(async signal => {
    await refresh(signal);
    status.textContent = 'Trusted-device list updated.';
  });
  control('sync').onclick = () => void run(sync);
  control('cancel').onclick = () => operation?.abort();
  control('automatic').onchange = async () => {
    if (!local || !owner) return;
    local = { ...local, automatic: control('automatic').checked };
    try { await saveDevice(owner, local); }
    catch { status.textContent = 'Could not save the replication preference.'; return; }
    if (local.automatic) void run(sync);
    else operation?.abort();
  };
  control('remove').onclick = () => {
    const id = control('remove-local').value;
    if (id && confirm('Remove this encrypted copy from this device?')) void run(async () => {
      await removeReplica(owner, id);
      await refreshChoices();
      status.textContent = 'Local replica removed.';
    });
  };
  control('prepare').onclick = () => void run(async signal => {
    const current = owner;
    const selected = control('archives').value;
    const key = document.querySelector('[data-recovery="key"]').value.trim();
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Enter the archive recovery key above.');
    const copies = (await localManifests()).filter(item => item.owner === current && item.complete);
    const rows = new Map(hosted.map(row => [row.id, row]));
    for (const copy of copies) rows.set(copy.id, copy);
    let fallback = 0;
    const files = await chainFiles(selected, [...rows.values()], async row => {
      const cached = await replicaFile(current, row.id, signal);
      if (cached) return cached;
      fallback++;
      status.textContent = 'Using hosted fallback for ' + row.label + '…';
      const base = 'hosted-archives/' + row.id + '/';
      const manifest = await (await request(base + 'manifest', { signal })).json();
      return fetchReplica(current, manifest, async index =>
        (await request(base + 'block/' + index, { signal })).arrayBuffer(), signal, null, false);
    }, signal);
    await openChain(files, key, { signal });
    signal.throwIfAborted();
    const selection = new DataTransfer();
    for (const file of files) selection.items.add(file);
    document.getElementById('backup-file-options').open = true;
    const input = document.querySelector('[data-recovery="files"]');
    input.files = selection.files;
    input.dispatchEvent(new Event('change'));
    status.textContent = 'Verified chain prepared. Hosted fallback used for ' + fallback + ' file(s). Review the restore preview above.';
  });

  let offlineRows = [];
  let offlineOperation;
  const openOffline = document.getElementById('open-offline-replicas');
  openOffline.hidden = false;
  openOffline.onclick = async () => {
    offlineControl('status').textContent = '';
    offlineControl('downloads').replaceChildren();
    offline.showModal();
    try {
      offlineRows = (await localManifests()).filter(item => item.complete);
      // Hosted IDs are globally unique even when this OS profile has used multiple accounts.
      fillArchives(offlineControl('archives'), offlineRows);
      if (!offlineRows.length) offlineControl('status').textContent = 'This device has no complete encrypted replicas.';
    } catch { offlineControl('status').textContent = 'Could not open device replica storage.'; }
  };
  offlineControl('verify').onclick = async () => {
    if (offlineOperation) return;
    const controller = new AbortController();
    offlineOperation = controller;
    const signal = controller.signal;
    const target = offlineControl('downloads');
    target.replaceChildren();
    try {
      const files = await chainFiles(offlineControl('archives').value, offlineRows, async row => {
        const file = await replicaFile(row.owner, row.id, signal);
        if (!file) throw new Error('A local replica is missing or corrupted. Use hosted recovery when connected.');
        return file;
      }, signal);
      await openChain(files, offlineControl('key').value.trim(), { signal });
      signal.throwIfAborted();
      for (const file of files) {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Save ' + file.name;
        button.onclick = () => saveFile(file);
        row.append(button);
        target.append(row);
      }
      offlineControl('status').textContent = 'Encrypted chain verified. Save all files for recovery.';
    } catch (error) {
      if (!signal.aborted) offlineControl('status').textContent = error.message;
    } finally { if (offlineOperation === controller) offlineOperation = null; }
  };
  offlineControl('close').onclick = () => offline.close();
  offline.addEventListener('close', () => {
    offlineOperation?.abort();
    offlineOperation = null;
    offlineControl('key').value = '';
    offlineControl('downloads').replaceChildren();
  });

  return { account(id) {
    const turn = ++epoch;
    operation?.abort();
    operation = null;
    clearInterval(timer);
    owner = id;
    local = lease = null;
    hosted = [];
    control('current').textContent = '';
    control('list').replaceChildren();
    fillArchives(control('archives'), []);
    control('code').textContent = status.textContent = '';
    control('approval-code').value = control('password').value = '';
    control('automatic').checked = false;
    control('sync').disabled = control('automatic').disabled = true;
    control('bootstrap').hidden = control('password').parentElement.hidden = true;
    control('label').parentElement.hidden = control('register').hidden = false;
    control('approval-code').parentElement.hidden = true;
    control('automatic').parentElement.hidden = control('sync').hidden = true;
    control('local-status').textContent = '';
    fillArchives(control('remove-local'), []);
    control('cancel').hidden = true;
    if (!id) return;
    void run(async signal => {
      const existing = await loadDevice(id);
      signal.throwIfAborted();
      if (epoch !== turn) return;
      local = existing;
      control('automatic').checked = Boolean(local?.automatic);
      if (local?.automatic) await sync(signal);
      else {
        await refreshChoices();
        await refresh(signal);
      }
    });
    timer = setInterval(() => {
      if (local?.automatic) void run(sync);
    }, 60_000);
  } };
}
