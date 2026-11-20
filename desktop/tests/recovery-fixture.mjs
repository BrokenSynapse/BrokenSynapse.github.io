import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const mediaPath = '/horizon-chat/api/profile-media/';
const control = name => `document.querySelector('[data-recovery="${name}"]')`;

export async function exerciseRecovery(evaluate, until, fixture) {
  const pngs = await evaluate(`(async () => {
    const images = [];
    for (const color of ['red', 'green', 'blue', 'purple']) {
      const canvas = new OffscreenCanvas(32, 48);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(2, 2, 25, 35);
      const blob = await canvas.convertToBlob();
      images.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
    }
    return images;
  })()`);
  const bytes = pngs.map(value => Buffer.from(value));
  const ids = bytes.map(value => createHash('sha256').update(value).digest('hex'));
  for (const [index, id] of ids.entries()) fixture.db.prepare('INSERT INTO profile_media VALUES(?,?,?)').run(id, bytes[index], 'image/png');
  fixture.db.prepare('UPDATE proxies SET avatar_url=?,banner=? WHERE id=?').run(mediaPath + ids[0], mediaPath + ids[1], fixture.proxy);
  fixture.db.prepare("INSERT INTO character_variants(proxy_id,name,avatar_url) VALUES(?,'Alternate',?)").run(fixture.proxy, mediaPath + ids[0]);
  const variant = fixture.db.prepare('SELECT id FROM character_variants WHERE proxy_id=?').get(fixture.proxy).id;
  fixture.db.prepare('INSERT INTO character_profiles VALUES(?,?,?)').run(fixture.proxy, mediaPath + ids[2], variant);
  const testTheme = 'basic-dark';
  const writer = fixture.db.prepare('SELECT account_id FROM proxies WHERE id=?').get(fixture.proxy).account_id;
  fixture.db.prepare('INSERT OR REPLACE INTO account_themes VALUES(?,?)').run(writer, testTheme);

  const login = async username => {
    await evaluate(`(() => {
      const form = document.getElementById('authentication');
      form.elements.username.value = '${username}';
      form.elements.password.value = 'horizon-fixture';
      form.requestSubmit();
    })()`);
    await until(() => evaluate("!document.getElementById('app').hidden"));
    await evaluate("document.getElementById('settings').click(); document.querySelector('[data-settings-page=account]').click()");
  };
  const status = text => until(() => evaluate(`${control('status')}.textContent.includes(${JSON.stringify(text)})`));
  const selectFiles = names => evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const item of ${JSON.stringify(names)}) transfer.items.add(window.recoveryFiles[item]);
    ${control('files')}.files = transfer.files;
    ${control('files')}.dispatchEvent(new Event('change'));
  })()`);

  await login('FixtureWriter');
  // Replace only the OS save destination. The packaged UI still writes every archive record.
  await evaluate(`(() => {
    window.recoveryFiles = [];
    window.showSaveFilePicker = async ({ suggestedName }) => ({ createWritable: async () => {
      const parts = [];
      return { write: async bytes => parts.push(bytes),
        close: async () => window.recoveryFiles.push(new File(parts, suggestedName)),
        abort: async () => {} };
    } });
    ${control('generate')}.click();
    window.fixtureRecoveryKey = ${control('key')}.value;
    ${control('full')}.click();
  })()`);
  await status('Archive exported');
  fixture.db.prepare('UPDATE character_profiles SET body_url=? WHERE proxy_id=?').run(mediaPath + ids[3], fixture.proxy);
  await selectFiles([0]);
  await evaluate(`${control('incremental')}.click()`);
  try { await until(() => evaluate('window.recoveryFiles.length === 2')); }
  catch (error) { throw new Error(await evaluate(`${control('status')}.textContent`), { cause: error }); }
  await status('Archive exported');

  const chainResult = await evaluate(`(async () => {
    const { openChain } = await import('./recovery-archive.js');
    const [full, incremental] = window.recoveryFiles;
    const key = window.fixtureRecoveryKey;
    const base = await openChain([full], key);
    const chain = await openChain([incremental, full], key);
    const corrupt = new Uint8Array(await full.arrayBuffer());
    corrupt[corrupt.length - 1] ^= 1;
    const tampered = new File([corrupt], 'tampered.hca');
    const rejected = async (files, password) => openChain(files, password).then(() => false, () => true);
    return {
      full: full.size, incremental: incremental.size, fullCount: base.manifest.present.length,
      deltaCount: chain.manifest.present.length,
      missing: await rejected([incremental], key),
      wrongKey: await rejected([full], '0'.repeat(64)),
      corrupt: await rejected([tampered, incremental], key),
      encrypted: !(await full.text()).includes('Fixture Character'),
    };
  })()`);
  assert.equal(chainResult.fullCount, 3);
  assert.equal(chainResult.deltaCount, 1);
  assert.ok(chainResult.incremental < chainResult.full);
  assert.ok(chainResult.missing && chainResult.wrongKey && chainResult.corrupt && chainResult.encrypted);
  const exportTicket = await evaluate(`(async () => {
    const { apiFetch } = await import('./platform.js');
    return (await (await apiFetch('recovery-archive/export')).json()).ticket;
  })()`);

  await evaluate("document.getElementById('logout').click()");
  await until(() => evaluate("!document.getElementById('welcome').hidden"));
  await login('FixtureReader');
  const denied = await evaluate(`(async () => {
    const { apiFetch } = await import('./platform.js');
    return (await apiFetch('recovery-archive/export/${exportTicket}/${ids[0]}')).status;
  })()`);
  assert.equal(denied, 404);
  await evaluate(`${control('key')}.value = window.fixtureRecoveryKey;`);
  await selectFiles([0, 1]);
  await evaluate(`${control('preview')}.click()`);
  await status('Review the preview');
  assert.match(await evaluate(`${control('rows')}.textContent`), /Fixture Character/);
  const invalidRestore = await evaluate(`(async () => {
    const { apiFetch } = await import('./platform.js');
    const { openChain } = await import('./recovery-archive.js');
    const { manifest } = await openChain(window.recoveryFiles, window.fixtureRecoveryKey);
    const post = (route, body, type = 'application/json') => apiFetch('recovery-archive/' + route, {
      method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': type },
      body: type === 'application/json' ? JSON.stringify(body) : body,
    });
    const opened = await post('restore', manifest);
    const { ticket } = await opened.json();
    const asset = manifest.assets[0];
    const bad = await post('restore/' + ticket + '/' + asset.id, new Uint8Array(asset.size), 'application/octet-stream');
    const incomplete = await post('restore/' + ticket + '/commit', {});
    const cancelled = await post('restore/' + ticket + '/cancel', {});
    return [opened.status, bad.status, incomplete.status, cancelled.status];
  })()`);
  assert.deepEqual(invalidRestore, [201, 400, 400, 200]);
  const before = fixture.db.prepare('SELECT count(*) AS n FROM proxies').get().n;
  assert.equal(before, 1);
  const remove = fixture.db.prepare('DELETE FROM profile_media WHERE id=?');
  for (const id of ids) remove.run(id);
  await evaluate(`${control('theme')}.checked = true; ${control('restore')}.click()`);
  await status('Restored 1 characters');
  const restored = fixture.db.prepare('SELECT * FROM proxies WHERE account_id<>?').get(writer);
  assert.equal(restored.name, 'Fixture Character');
  assert.equal(restored.avatar_url, mediaPath + ids[0]);
  assert.equal(restored.banner, mediaPath + ids[1]);
  const look = fixture.db.prepare('SELECT * FROM character_profiles WHERE proxy_id=?').get(restored.id);
  assert.equal(look.body_url, mediaPath + ids[3]);
  const restoredVariant = fixture.db.prepare('SELECT * FROM character_variants WHERE id=?').get(look.active_variant);
  assert.equal(restoredVariant.name, 'Alternate');
  assert.equal(restoredVariant.avatar_url, mediaPath + ids[0]);
  assert.equal(fixture.db.prepare('SELECT theme FROM account_themes WHERE account_id=?').get(restored.account_id).theme, testTheme);
  for (const index of [0, 1, 3]) {
    const stored = fixture.db.prepare('SELECT body,mime FROM profile_media WHERE id=?').get(ids[index]);
    assert.equal(stored.mime, 'image/png');
    assert.deepEqual(Buffer.from(stored.body), bytes[index]);
    const served = await evaluate(`(async () => {
      const { apiFetch } = await import('./platform.js');
      const reply = await apiFetch('profile-media/${ids[index]}');
      return Array.from(new Uint8Array(await reply.arrayBuffer()));
    })()`);
    assert.deepEqual(Buffer.from(served), bytes[index]);
  }
  assert.equal(fixture.db.prepare('SELECT 1 FROM profile_media WHERE id=?').get(ids[2]), undefined);
  await evaluate(`${control('preview')}.click()`);
  await status('Review the preview');
  assert.match(await evaluate(`${control('rows')}.textContent`), /Existing character, skip/);
  console.log('Recovery fixture passed:', JSON.stringify(chainResult), 'three restored PNGs match byte-for-byte');
}
