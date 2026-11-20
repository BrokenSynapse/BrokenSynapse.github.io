import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function login(evaluate, until, user) {
  await evaluate(`(() => {
    const form = document.getElementById('authentication');
    form.elements.username.value = '${user}';
    form.elements.password.value = 'horizon-fixture';
    form.requestSubmit();
  })()`);
  await until(() => evaluate("!document.getElementById('app').hidden"));
}

const sum = (rows, field) => rows.reduce((total, item) => total + item[field], 0);
const sha = data => createHash('sha256').update(data).digest('hex');

export async function testPeers(run, until, fixture) {
  const attachment = await fixture.seedAttachment();
  const route = `conversations/${fixture.dm}/messages/${attachment.id}/document`;
  const read = (evaluate, offset) => evaluate(`(async () => {
    const [{ readChunk }, { apiUrl }] = await Promise.all([import('./documents.js?v=media-preferences'), import('./platform.js')]);
    const data = await readChunk(apiUrl('${route}'), ${offset}, ${attachment.payload.length}, undefined, true);
    const bytes = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
  })()`);
  const setMode = (evaluate, mode) => evaluate(`(() => {
    const field = document.getElementById('peer-mode');
    field.value = '${mode}';
    field.dispatchEvent(new Event('change'));
  })()`);
  const sourceReady = Promise.withResolvers();
  const done = Promise.withResolvers();
  const source = run(false, fixture, false, async evaluate => {
    try {
      await login(evaluate, until, 'FixtureWriter');
      await setMode(evaluate, 'tray');
      await until(async () => fixture.traffic.some(row => row.route.endsWith('/hello') && row.status === 200));
      await evaluate("window.dispatchEvent(new Event('horizon-tray-hidden'))");
      for (const offset of [0, 262144, 524288]) {
        assert.equal(await read(evaluate, offset), sha(attachment.payload.subarray(offset, offset + 262144)));
      }
      await until(async () => fixture.traffic.filter(row => row.route.endsWith('/advertise') && row.status === 200).length >= 3);
      sourceReady.resolve(evaluate);
      await done.promise;
    } catch (error) { sourceReady.reject(error); throw error; }
  });
  source.catch(sourceReady.reject);
  try {
    const sender = await sourceReady.promise;
    const baseline = fixture.traffic.find(row => row.route.endsWith('/document') && row.status === 200).sent;
    await run(false, fixture, false, async evaluate => {
      await login(evaluate, until, 'FixtureReader');
      await setMode(evaluate, 'tray');
      await until(async () => fixture.traffic.filter(row => row.route.endsWith('/hello') && row.status === 200).length >= 2);
      const start = fixture.traffic.length;
      assert.equal(await read(evaluate, 0), sha(attachment.payload.subarray(0, 262144)));
      const direct = fixture.traffic.slice(start);
      assert.ok(direct.some(row => row.route.endsWith('/store') && row.status === 200), JSON.stringify(direct));
      assert.equal(direct.filter(row => row.route.endsWith('/document') && row.status === 200).length, 0);
      const signaling = direct.filter(row => row.route.includes('/peers/'));
      const directSent = sum(signaling, 'sent');
      const control = directSent + sum(signaling, 'received');
      console.log('Peer server measurement:', JSON.stringify({
        httpPayload: baseline, peerAttachmentPayload: 0, signalingBodyBytes: control,
        signalingResponseBodyBytes: directSent, serverPayloadDifferenceAfterResponseBodies: baseline - directSent,
      }));
      const registration = await fetch(fixture.base + 'register', {
        method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'FixtureOutsider', displayName: 'Fixture Outsider', tag: 'O111', password: 'horizon-fixture' }),
      });
      assert.equal(registration.status, 201);
      const cookie = registration.headers.get('set-cookie').split(';')[0];
      const peer = randomUUID();
      const peerCall = (action, body) => fetch(fixture.base + 'peers/' + action, { method: 'POST',
        headers: { Cookie: cookie, 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ peer, ...body }) });
      assert.equal((await peerCall('hello', {})).status, 200);
      assert.equal((await peerCall('discover', { conversation: fixture.dm, message: attachment.id, offset: 0 })).status, 404);
      assert.equal((await fetch(fixture.base + route + '?offset=0&encoding=gzip', { headers: { Cookie: cookie } })).status, 404);
      await setMode(sender, 'active');
      await until(async () => fixture.traffic.some(row => row.route.endsWith('/leave') && row.status === 200));
      let checkpoint = fixture.traffic.length;
      assert.equal(await read(evaluate, 262144), sha(attachment.payload.subarray(262144, 524288)));
      assert.ok(fixture.traffic.slice(checkpoint).some(row => row.route.endsWith('/document') && row.status === 200));
      checkpoint = fixture.traffic.length;
      await setMode(sender, 'tray');
      await until(async () => fixture.traffic.slice(checkpoint).some(row => row.route.endsWith('/hello') && row.status === 200));
      await read(sender, 524288);
      await until(async () => fixture.traffic.slice(checkpoint).some(row => row.route.endsWith('/advertise') && row.status === 200));
      done.resolve();
      await source;
      checkpoint = fixture.traffic.length;
      assert.equal(await read(evaluate, 524288), sha(attachment.payload.subarray(524288)));
      assert.ok(fixture.traffic.slice(checkpoint).some(row => row.route.endsWith('/document') && row.status === 200));
      assert.ok(fixture.traffic.slice(checkpoint).some(row => row.route.endsWith('/offer') && row.status === 200), 'the offline seed was tried before fallback');
    });
    console.log('Packaged direct transfer, opt-in tray mode, hidden active-mode pause, and exited-peer HTTP fallback passed');
  } finally { done.resolve(); await source; }
}

export async function testHosted(evaluate, until, fixture) {
  await login(evaluate, until, 'FixtureWriter');
  await evaluate("document.getElementById('settings').click(); document.querySelector('[data-settings-page=account]').click()");
  const result = await evaluate(`(async () => {
    const { createArchive, newRecoveryKey, inspectArchive } = await import('./recovery-archive.js');
    const { apiFetch } = await import('./platform.js');
    const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
    const hash = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
    const raw = new Uint8Array(1200000);
    for (let i = 0; i < raw.length; i += 60000) crypto.getRandomValues(raw.subarray(i, i + 60000));
    const key = newRecoveryKey();
    const asset = { id: await hash(raw), size: raw.length, mime: 'image/png' };
    const { file } = await createArchive({ characters: [], assets: [asset], theme: null }, key, { loadAsset: async () => raw });
    const destination = new File([file], 'hosted-fixture.hca');
    window.hostedFixtureHash = await hash(await file.arrayBuffer());
    const metadata = await inspectArchive(file, key);
    const tags = [];
    for (let offset = 0; offset < file.size; offset += 1048576) {
      tags.push(await hash(await file.slice(offset, offset + 1048576).arrayBuffer()));
    }
    const post = async (route, body, binary = false) => apiFetch('hosted-archives/' + route, {
      method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ? body : JSON.stringify(body),
    });
    const begin = await (await post('begin', { ...metadata, size: file.size, tags, label: destination.name })).json();
    const bad = await post(begin.id + '/block/0', new Uint8Array(1048576), true);
    await post(begin.id + '/block/0', file.slice(0, 1048576), true);
    const transfers = new DataTransfer();
    transfers.items.add(destination);
    document.querySelector('[data-hosted=file]').files = transfers.files;
    document.querySelector('[data-recovery=key]').value = key;
    window.showSaveFilePicker = async () => ({ createWritable: async () => {
      const parts = [];
      return { write: async value => parts.push(value), abort: async () => {},
        close: async () => { window.hostedDownloadedHash = await hash(await new Blob(parts).arrayBuffer()); } };
    } });
    document.querySelector('[data-hosted=upload]').click();
    return { id: begin.id, rejected: bad.status, expected: window.hostedFixtureHash };
  })()`);
  assert.equal(result.rejected, 400);
  await until(() => evaluate("document.querySelector('[data-hosted=status]').textContent.includes('archive verified')"));
  await evaluate("[...document.querySelectorAll('[data-hosted=list] button')].find(item => item.textContent === 'Download').click()");
  await until(() => evaluate('Boolean(window.hostedDownloadedHash)'));
  assert.equal(await evaluate('window.hostedDownloadedHash'), result.expected);
  const row = fixture.db.prepare('SELECT size,uploaded,digest FROM hosted_archives WHERE id=?').get(result.id);
  assert.equal(row.uploaded, row.size);
  assert.equal(row.digest, result.expected);
  assert.equal(sha(await readFile(join(fixture.storage, result.id + '.hca'))), result.expected);
  const other = await fetch(fixture.base + 'hosted-archives/' + result.id + '/manifest', { headers: { Cookie: fixture.reader.cookie } });
  assert.equal(other.status, 404);
  console.log('Hosted encrypted upload resumed after one block; browser, server, and disk SHA-256 agree for', row.size, 'bytes');
}
