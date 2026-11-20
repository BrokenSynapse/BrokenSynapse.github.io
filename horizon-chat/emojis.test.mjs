import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

const gif = 'data:image/gif;base64,R0lGODdhAgACAIEAAABu3QAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkyLvLwMDAxMDAwMDAAAAO0QFPdZFT9wAAAABJRU5ErkJggg==';

test('custom emoji references preserve generations, artwork and permissions across contexts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'horizon-emoji-test-'));
  const database = join(directory, 'test.sqlite');
  let db = new DatabaseSync(database);
  const options = {
    secure: false,
    json(response, status, data) {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    },
  };
  let messenger = createMessenger(db, options);
  const server = createServer((request, response) => {
    void messenger(request, response, new URL(request.url, 'http://localhost')).catch(error => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    unlinkSync(database);
    rmdirSync(directory);
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/horizon-chat/api/';
  function request(route, payload, cookie) {
    return fetch(base + route, {
      method: payload ? 'POST' : 'GET',
      headers: { Cookie: cookie || '', 'Content-Type': 'application/json', 'X-Horizon-Chat': '1' },
      body: payload && JSON.stringify(payload),
    });
  }
  async function call(route, payload, cookie, status = 200) {
    const response = await request(route, payload, cookie);
    const text = await response.text();
    assert.equal(response.status, status, text);
    return JSON.parse(text);
  }
  async function account(username) {
    const response = await request('register', { username, password: 'abcde', displayName: username + ' Member' });
    assert.equal(response.status, 201);
    return { ...(await response.json()).account, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const owner = await account('Owner');
  const member = await account('Member');
  const { server: source } = await call('servers', { name: 'Source' }, owner.cookie, 201);
  const { server: destination } = await call('servers', { name: 'Destination' }, member.cookie, 201);
  const manage = 'servers/' + source.id + '/emojis';
  const upload = (name, image = gif) => call(manage, { name, image }, owner.cookie);
  const find = async (name, serverId = source.id, cookie = owner.cookie) => {
    const { servers } = await call('conversations', null, cookie);
    return servers.find(server => server.id === serverId).emojis.find(emoji => emoji.name === name);
  };
  await call('servers/join', { code: source.inviteCode }, member.cookie);
  await call(manage, { name: 'denied', image: gif }, member.cookie, 403);
  await call(manage, { name: 'invalid', image: gif.replace('image/gif', 'image/png') }, owner.cookie, 400);
  await upload('heart');
  const old = await find('heart');
  assert.equal(old.ref, '<e:1>');
  await call(manage, { name: 'heart', image: gif }, owner.cookie, 409);
  await call('servers/' + destination.id + '/emojis', { name: 'heart', image: gif }, member.cookie);
  assert.equal((await find('heart', destination.id, member.cookie)).ref, '<e:2>');
  await Promise.all([upload('third'), upload('fourth')]);
  const third = await find('third');
  const fourth = await find('fourth');
  assert.deepEqual([third.ref, fourth.ref].sort(), ['<e:3>', '<e:4>']);
  assert.equal(db.prepare('SELECT count(*) AS count FROM emoji_assets').get().count, 1);

  const { id } = await call('conversations', { handle: owner.displayName + '#' + owner.publicTag }, member.cookie);
  const dm = 'conversations/' + id + '/messages';
  const crossServer = 'conversations/' + destination.conversationId + '/messages';
  const message = {
    body: '💀 ' + old.ref,
    format: { kind: 'rich', nodes: [{ tag: 'strong', children: ['💀 ', { tag: 'emoji', ref: old.ref }] }] },
  };
  await call(dm, message, member.cookie, 201);
  await call(crossServer, message, member.cookie, 201);
  const { messages } = await call(dm, null, member.cookie);
  assert.deepEqual(JSON.parse(messages[0].format), message.format);
  const edit = dm + '/' + messages[0].id + '/edit';
  await call(manage, { ref: old.ref, name: 'renamed' }, member.cookie, 403);
  await call(manage, { ref: old.ref, name: 'renamed' }, owner.cookie);
  assert.equal((await find('renamed')).ref, old.ref);

  await call('servers/' + source.id + '/kick/' + member.id, {}, owner.cookie);
  await call(dm, message, member.cookie, 403);
  await call(edit, message, member.cookie);
  const duplicated = { body: old.ref + old.ref, format: { kind: 'rich', nodes: [
    { tag: 'emoji', ref: old.ref }, { tag: 'emoji', ref: old.ref },
  ] } };
  await call(edit, duplicated, member.cookie, 403);
  const art = await request('emoji-art/1', null, member.cookie);
  assert.equal(art.headers.get('content-type'), 'image/gif');
  assert.equal(Buffer.from(await art.arrayBuffer()).toString('base64'), gif.split(',')[1]);

  await call(manage, { ref: old.ref, remove: true }, owner.cookie);
  await call(manage, { ref: fourth.ref, remove: true }, owner.cookie);
  db.close();
  db = new DatabaseSync(database);
  messenger = createMessenger(db, options);
  await upload('replacement', png);
  await upload('recycled_other');
  const replacement = await find('replacement');
  assert.equal(replacement.ref, '<e:1.1>');
  assert.equal((await find('recycled_other')).ref, fourth.ref.slice(0, -1) + '.1>');
  assert.equal((await request('emoji-art/1', null, member.cookie)).headers.get('content-type'), 'image/gif');
  assert.equal((await request('emoji-art/1.1', null, member.cookie)).headers.get('content-type'), 'image/png');
  await call(manage, { ref: replacement.ref, remove: true }, owner.cookie);
  await upload('third_generation');
  assert.equal((await find('third_generation')).ref, '<e:1.2>');
  await call(manage, { ref: old.ref, purge: true }, member.cookie, 403);
  await call(manage, { ref: old.ref, purge: true }, owner.cookie);
  assert.equal((await request('emoji-art/1', null, member.cookie)).status, 404);
  assert.equal((await request('emoji-art/1.2', null, member.cookie)).status, 200);
  assert.deepEqual(JSON.parse((await call(dm, null, member.cookie)).messages[0].format), message.format);

  const legacyArt = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+7c7f/srH0rH0rH7JH/zYGqLN8tAA', 'base64');
  const hash = createHash('sha256').update(legacyArt).digest('hex');
  db.prepare('INSERT INTO profile_media(id, body) VALUES (?, ?)').run(hash, legacyArt);
  db.prepare('INSERT INTO server_emojis VALUES (?, ?, ?)').run(source.id, 'legacy', '/horizon-chat/api/profile-media/' + hash);
  const legacyChannel = 'conversations/' + source.conversationId + '/messages';
  db.prepare('INSERT INTO direct_messages(conversation_id, sender_id, body, sent) VALUES (?, ?, ?, ?)')
    .run(source.conversationId, owner.id, ':legacy:', Date.now());
  messenger = createMessenger(db, options);
  const migrated = await find('legacy');
  const { servers } = await call('conversations', null, owner.cookie);
  assert.deepEqual(servers.find(server => server.id === source.id).legacyEmojis, [migrated]);
  assert.equal(Buffer.from(await (await fetch(new URL(migrated.url, base), { headers: { Cookie: owner.cookie } })).arrayBuffer())
    .toString('base64'), legacyArt.toString('base64'));
  await call(legacyChannel, { body: ':legacy:' }, owner.cookie, 201);
  const legacyMessages = (await call(legacyChannel, null, owner.cookie)).messages;
  assert.equal(legacyMessages.at(-2).format, null);
  assert.equal(JSON.parse(legacyMessages.at(-1).format).emojiVersion, 1);
  await call(manage, { ref: migrated.ref, name: 'updated_legacy' }, owner.cookie);
  assert.equal((await call('conversations', null, owner.cookie)).servers.find(server => server.id === source.id).legacyEmojis[0].name, 'legacy');
});
