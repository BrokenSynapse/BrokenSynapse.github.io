import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const el = name => `document.querySelector('[data-device="${name}"]')`;
async function toast(until, page, text) {
  try { return await until(() => page(`${el('status')}.textContent.includes(${JSON.stringify(text)})`)); }
  catch (error) { throw new Error('Expected ' + text + ', got ' + await page(`${el('status')}.textContent`), { cause: error }); }
}

async function signIn(page, until) {
  await page(`(() => {
    const form = document.getElementById('authentication');
    form.elements.username.value = 'FixtureWriter';
    form.elements.password.value = 'horizon-fixture';
    form.requestSubmit();
  })()`);
  await until(() => page(`!document.getElementById('app').hidden && ${el('current')}.textContent.includes('This device')`));
  await page("document.getElementById('settings').click(); document.querySelector('[data-settings-page=account]').click()");
}

function register(page, label) {
  return page(`${el('label')}.value = ${JSON.stringify(label)}; ${el('register')}.click()`);
}

async function baseArchives(page, until) {
  const info = await page(`(async () => {
    const { createArchive, newRecoveryKey } = await import('./recovery-archive.js');
    const key = newRecoveryKey();
    const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    const images = [];
    for (const color of ['red', 'blue']) {
      const canvas = new OffscreenCanvas(48, 32);
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(1, 1, 20, 20);
      const bytes = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
      images.push({ bytes, asset: { id: hex(await crypto.subtle.digest('SHA-256', bytes)), size: bytes.byteLength, mime: 'image/png' } });
    }
    const profile = { name: 'Replica Fixture Character', prefix: 'rf:', suffix: '', group_name: '',
      description: 'Recovered from an encrypted chain.', designation: 'R123', status_text: '',
      created_at: '2026-01-01T00:00:00.000Z', avatar_url: images[0].asset.id, banner_url: images[0].asset.id,
      body_url: images[0].asset.id, active: 0, variants: [] };
    const loadAsset = async asset => images.find(image => image.asset.id === asset.id).bytes;
    const full = await createArchive({ characters: [profile], assets: [images[0].asset], theme: null }, key, { loadAsset });
    const parent = { manifest: full.manifest, assets: new Map([[images[0].asset.id, images[0].asset]]) };
    const delta = await createArchive({ characters: [{ ...profile, body_url: images[1].asset.id }],
      assets: images.map(image => image.asset), theme: null }, key, { loadAsset, parent });
    window.deviceFixtureFiles = [new File([full.file], 'replica-full.hca'), new File([delta.file], 'replica-incremental.hca')];
    document.querySelector('[data-recovery=key]').value = key;
    return { key, images: images.map(({ bytes, asset }) => ({ id: asset.id, bytes: Array.from(new Uint8Array(bytes)) })) };
  })()`);
  for (const index of [0, 1]) {
    await page(`(() => {
      document.querySelector('[data-hosted=status]').textContent = '';
      const transfer = new DataTransfer();
      transfer.items.add(window.deviceFixtureFiles[${index}]);
      document.querySelector('[data-hosted=file]').files = transfer.files;
      document.querySelector('[data-hosted=upload]').click();
    })()`);
    await until(() => page("document.querySelector('[data-hosted=status]').textContent.includes('archive verified')"));
  }
  return info;
}

export async function testDeviceReplicas(run, until, fixture) {
  const root = resolve(tmpdir());
  const profile = await mkdtemp(join(root, 'horizon-replica-retained-'));
  assert.equal(dirname(profile), root);
  const primaryReady = Promise.withResolvers();
  const primaryDone = Promise.withResolvers();
  const primary = run(false, fixture, false, async page => {
    try {
      await signIn(page, until);
      await register(page, 'Primary test device');
      await toast(until, page, 'Device registered');
      await page(`${el('password')}.value = 'horizon-fixture'; ${el('bootstrap')}.click()`);
      await toast(until, page, 'First trusted device approved');
      primaryReady.resolve({ page, ...(await baseArchives(page, until)) });
      await primaryDone.promise;
    } catch (error) { primaryReady.reject(error); throw error; }
  });
  primary.catch(primaryReady.reject);
  try {
    const first = await primaryReady.promise;
    const tip = fixture.db.prepare("SELECT id FROM hosted_archives WHERE label='replica-incremental.hca'").get().id;
    await run(false, fixture, false, async page => {
      await signIn(page, until);
      await register(page, 'Second test device');
      await toast(until, page, 'Device registered');
      const code = await page(`${el('code')}.textContent`);
      assert.match(code, /^[a-f0-9]{10}$/);
      const pending = await page(`(async () => {
        const { apiFetch } = await import('./platform.js');
        const response = await apiFetch('trusted-devices/replica');
        return response.status;
      })()`);
      assert.equal(pending, 403);
      assert.equal(await page(`${el('automatic')}.checked`), false);
      await first.page(`${el('refresh')}.click()`);
      await toast(until, first.page, 'list updated');
      const click = text => first.page(`[...${el('list')}.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(text)}).click()`);
      await first.page(`${el('approval-code')}.value = ${JSON.stringify(code === '0000000000' ? '1111111111' : '0000000000')}`);
      await click('Approve Second test device');
      await toast(until, first.page, 'code did not match');
      await first.page(`${el('approval-code')}.value = ${JSON.stringify(code)}`);
      await click('Approve Second test device');
      await toast(until, first.page, 'Device approved');
      await page(`${el('refresh')}.click()`);
      await toast(until, page, 'list updated');
      assert.equal(await page(`${el('local-status')}.textContent.startsWith('0')`), true);
      await page(`${el('automatic')}.click()`);
      await toast(until, page, 'Verified 2 new encrypted device copies');
      const id = fixture.db.prepare("SELECT id FROM recovery_devices WHERE label='Second test device'").get().id;
      assert.equal(fixture.db.prepare('SELECT count(*) AS count FROM recovery_device_replicas WHERE device=?').get(id).count, 2);
      const leaseReady = await page(`(async () => {
        const { apiFetch } = await import('./platform.js');
        const { loadDevice, signDeviceChallenge } = await import('./device-replica-store.js');
        const account = (await (await apiFetch('session')).json()).account;
        const device = await loadDevice(account.id);
        const post = (action, body) => apiFetch('trusted-devices/' + action, {
          method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const { challenge } = await (await post('challenge', { id: device.id })).json();
        const signature = await signDeviceChallenge(device, challenge);
        const { lease } = await (await post('lease', { challenge, signature })).json();
        window.fixtureLease = lease;
        return typeof lease === 'string';
      })()`);
      assert.equal(leaseReady, true);
      await first.page('window.confirm = () => true');
      await click('Revoke Second test device');
      await toast(until, first.page, 'Device access revoked');
      const revoked = await page(`(async () => {
        const { apiFetch } = await import('./platform.js');
        return (await apiFetch('trusted-devices/replica/${tip}/block/0', {
          headers: { 'X-Horizon-Device': window.fixtureLease },
        })).status;
      })()`);
      assert.equal(revoked, 403);
      assert.equal(fixture.db.prepare('SELECT count(*) AS count FROM recovery_device_replicas WHERE device=?').get(id).count, 0);
    }, profile);
    primaryDone.resolve();
    await primary;

    // No trusted device is online. A fresh session recovers the full chain from hosted storage.
    await run(false, fixture, false, async page => {
      await signIn(page, until);
      await page(`document.querySelector('[data-recovery=key]').value = ${JSON.stringify(first.key)};
        ${el('archives')}.value = ${JSON.stringify(tip)}; ${el('prepare')}.click()`);
      await toast(until, page, 'Hosted fallback used for 2 file(s)');
      assert.equal(await page("document.querySelector('[data-recovery=files]').files.length"), 2);
      await page("document.querySelector('[data-recovery=preview]').click()");
      await until(() => page("document.querySelector('[data-recovery=rows]').textContent.includes('Replica Fixture Character')"));
      await page("document.querySelector('[data-recovery=restore]').click()");
      await until(() => page("document.querySelector('[data-recovery=status]').textContent.includes('Restored 1 characters')"));
    });
    for (const image of first.images) {
      const row = fixture.db.prepare('SELECT body FROM profile_media WHERE id=?').get(image.id);
      const actual = createHash('sha256').update(row.body).digest('hex');
      assert.equal(actual, image.id);
      assert.deepEqual(Buffer.from(row.body), Buffer.from(image.bytes));
    }

    await delay(500);
    await run(true, fixture, false, async page => {
      await page("document.getElementById('open-offline-replicas').click()");
      await until(() => page("document.querySelector('[data-offline-replica=archives]').options.length === 3"));
      await page(`document.querySelector('[data-offline-replica=archives]').value = ${JSON.stringify(tip)};
        document.querySelector('[data-offline-replica=key]').value = ${JSON.stringify(first.key)};
        document.querySelector('[data-offline-replica=verify]').click()`);
      await until(() => page("document.querySelector('[data-offline-replica=status]').textContent.includes('Encrypted chain verified')"));
      assert.equal(await page("document.querySelectorAll('[data-offline-replica=downloads] button').length"), 2);
    }, profile);
    console.log('Packaged device approval, opt-in replication, immediate revocation, offline restart, hosted fallback with both devices offline, and byte-exact PNG restoration passed');
  } finally {
    primaryDone.resolve();
    await primary.catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
