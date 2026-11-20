import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

test('private messages require an active participant session and preserve exact text', async t => {
  const db = new DatabaseSync(':memory:');
  const options = {
    secure: false,
    json(response, status, data) {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    },
  };
  let handler = createMessenger(db, options);
  const server = createServer((request, response) => {
    void handler(request, response, new URL(request.url, 'http://localhost')).catch(error => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/horizon-chat/api/`;
  const password = 'abcde';
  const call = (route, payload, cookie, csrf = true) => fetch(base + route, {
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-Horizon-Chat': '1' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  async function signUp(username, tag, passphrase = password, displayName) {
    const result = await call('register', { username, password: passphrase, tag, displayName });
    assert.equal(result.status, 201);
    return { cookie: result.headers.get('set-cookie').split(';')[0], account: (await result.json()).account };
  }
  assert.equal((await call('register', { username: 'First', password: 'abcd' })).status, 400);
  const first = await signUp('First', '0042', password, 'First Member');
  const second = await signUp('Second', '4423', password, 'Second Member');
  const outsider = await signUp('Outsider');
  assert.equal((await call('register', { username: 'FIRST', password, tag: '0042' })).status, 409);
  const duplicate = await signUp('FIRST', '0042', 'other');
  assert.equal(first.account.username, 'First:0042');
  assert.match(duplicate.account.username, /^FIRST:[A-Z0-9]{4}$/);
  assert.notEqual(duplicate.account.username.toLowerCase(), first.account.username.toLowerCase());
  assert.equal((await call('login', { username: 'FIRST:0042', password: 'incorrect test passphrase' })).status, 401);
  const originalLogin = await call('login', { username: 'FIRST', password });
  assert.equal(originalLogin.status, 200);
  assert.equal((await originalLogin.json()).account.id, first.account.id);
  const duplicateLogin = await call('login', { username: 'first', password: 'other' });
  assert.equal(duplicateLogin.status, 200);
  assert.equal((await duplicateLogin.json()).account.id, duplicate.account.id);
  assert.equal((await call('conversations', { username: 'second' }, first.cookie)).status, 404);
  assert.equal((await call('contacts', { handle: 'second:4423' }, first.cookie)).status, 404);
  assert.equal((await call('conversations', { handle: 'second:4423' }, first.cookie)).status, 404);
  assert.equal((await call('conversations', { recipientId: second.account.id }, first.cookie)).status, 404);
  const contacts = (await (await call('contacts', { handle: 'second member#4423' }, first.cookie)).json()).contacts;
  assert.deepEqual(contacts.map(({ id, displayName, publicTag }) => [id, displayName, publicTag]),
    [[second.account.id, 'Second Member', '4423']]);
  assert.equal(Object.hasOwn(contacts[0], 'username'), false);
  const open = await call('conversations', { handle: 'second member#4423' }, first.cookie);
  assert.equal(open.status, 200);
  const { id } = await open.json();
  const contactThread = await (await call('conversations', { recipientId: second.account.id }, first.cookie)).json();
  assert.equal(contactThread.id, id);
  const { server: community } = await (await call('servers', { name: 'Public handle check' }, first.cookie)).json();
  await call('servers/join', { code: community.inviteCode }, second.cookie);
  const directory = await (await call('conversations', undefined, second.cookie)).json();
  assert.equal(directory.conversations.find(thread => thread.id === id).publicTag, '0042');
  assert.equal(directory.servers.find(server => server.id === community.id).members.find(person => person.id === first.account.id).publicTag, '0042');
  assert.doesNotMatch(JSON.stringify(directory), /"username"|First:0042|Second:4423/);
  assert.equal((await call('profile', { displayName: 'second', bio: '' }, second.cookie)).status, 400);
  const renamed = await call('profile', { displayName: 'Café: Reader', bio: '' }, second.cookie);
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).account.publicTag, '4423');
  assert.equal((await call('conversations', { handle: 'Second Member#4423' }, first.cookie)).status, 404);
  const renamedThread = await (await call('conversations', { handle: 'CAFE\u0301: READER:4423' }, first.cookie)).json();
  assert.equal(renamedThread.id, id);
  const collision = await signUp('DifferentLogin', '4423', password, 'Café: Reader');
  assert.notEqual(collision.account.publicTag, '4423');
  assert.equal(collision.account.username, 'DifferentLogin:4423');
  assert.equal(outsider.account.displayName, 'Horizon member');

  const channelRoute = 'servers/' + community.id + '/channels';
  const mapChannelSettings = { name: 'World map', kind: 'map', everyoneVisibility: 0, roleRules: [] };
  const mapChannelResponse = await call(channelRoute, mapChannelSettings, first.cookie);
  assert.equal(mapChannelResponse.status, 200);
  const mapChannelId = (await mapChannelResponse.json()).channelId;
  const privateChannel = await (await call(channelRoute, { name: 'Secret city', everyoneVisibility: -1, roleRules: [] }, first.cookie)).json();
  const mapDirectory = await (await call('conversations', undefined, first.cookie)).json();
  const mapChannels = mapDirectory.servers.find(server => server.id === community.id).channels;
  const mapId = mapChannels.find(channel => channel.id === mapChannelId).conversationId;
  const privateId = mapChannels.find(channel => channel.id === privateChannel.channelId).conversationId;
  const mapRoute = 'conversations/' + mapId + '/map';
  const mapImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkyLvLwMDAxMDAwMDAAAAO0QFPdZFT9wAAAABJRU5ErkJggg==';
  assert.equal((await call(mapRoute, undefined, outsider.cookie)).status, 404);
  assert.equal((await call(mapRoute, { action: 'background', image: mapImage }, second.cookie)).status, 403);
  assert.equal((await call(mapRoute, { action: 'background', image: mapImage }, first.cookie)).status, 200);
  const art = await call(mapRoute + '/image/background', undefined, second.cookie);
  assert.equal(art.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await art.arrayBuffer()).toString('base64'), mapImage.split(',')[1]);
  const point = { action: 'create', kind: 'pin', title: 'Settlement', points: [[.3, .4]], links: [community.conversationId], symbol: 'settlement' };
  assert.equal((await call(mapRoute, { ...point, links: [privateId] }, second.cookie)).status, 400);
  const placed = await call(mapRoute, point, second.cookie);
  assert.equal(placed.status, 200);
  const pin = (await placed.json()).itemId;
  const region = { action: 'create', kind: 'region', title: 'District', points: [[.2,.2],[.4,.2],[.4,.5]], links: [privateId], image: mapImage };
  const outlined = await call(mapRoute, region, first.cookie);
  assert.equal(outlined.status, 200);
  const area = (await outlined.json()).itemId;
  const view = await (await call(mapRoute, undefined, second.cookie)).json();
  assert.deepEqual(view.items.find(item => item.id === area).links, []);
  assert.equal(view.items.find(item => item.id === area).editable, false);
  assert.equal(view.items.find(item => item.id === pin).editable, true);
  assert.equal((await call(mapRoute, { action: 'delete', id: area }, second.cookie)).status, 403);
  assert.equal((await call(mapRoute, { action: 'move', id: area, points: region.points }, second.cookie)).status, 403);
  const newCorners = [[.1,.2],[.4,.2],[.4,.5]];
  assert.equal((await call(mapRoute, { action: 'move', id: area, points: newCorners }, first.cookie)).status, 200);
  const pointMoved = [[.6,.4]];
  assert.equal((await call(mapRoute, { action: 'move', id: pin, points: pointMoved }, second.cookie)).status, 200);
  const moved = await (await call(mapRoute, undefined, first.cookie)).json();
  assert.deepEqual(moved.items.find(item => item.id === area).points, newCorners);
  assert.deepEqual(moved.items.find(item => item.id === pin).points, pointMoved);
  assert.deepEqual(moved.items.find(item => item.id === pin).links, [community.conversationId]);

  assert.equal((await call(mapRoute, { ...point, action: 'update', id: pin, color: '#aabbcc' }, second.cookie)).status, 200);
  assert.equal((await call(mapRoute + '/image/' + area, undefined, outsider.cookie)).status, 404);
  assert.equal((await call(mapRoute + '/image/' + area, undefined, second.cookie)).status, 200);
  assert.equal((await call(mapRoute, { action: 'create', kind: 'label', title: 'North', points: [[.7,.2]] }, second.cookie)).status, 200);
  assert.equal((await call('conversations/' + mapId + '/messages', { body: 'Map channel chat' }, second.cookie)).status, 201);
  await call(channelRoute + '/' + mapChannelId, { ...mapChannelSettings, messageRules: { send: { everyone: -1, roles: [] } } }, first.cookie);
  assert.equal((await call(mapRoute, { action: 'create', kind: 'label', title: 'Blocked', points: [[.2,.7]] }, second.cookie)).status, 403);


  const separator = await (await call(channelRoute, { kind: 'separator', everyoneVisibility: 0, roleRules: [] }, first.cookie)).json();
  const chronicle = await (await call(channelRoute, { name: 'Chronicle', kind: 'timeline', parentId: mapChannelId,
    everyoneVisibility: 0, roleRules: [] }, first.cookie)).json();
  const chapter = await (await call(channelRoute, { name: 'Chapter discussion', kind: 'text', parentId: chronicle.channelId,
    everyoneVisibility: 0, roleRules: [] }, first.cookie)).json();
  async function serverChannels(viewer = first) {
    const directory = await (await call('conversations', undefined, viewer.cookie)).json();
    return directory.servers.find(server => server.id === community.id).channels;
  }
  const arranged = await serverChannels();
  const timeline = arranged.find(channel => channel.id === chronicle.channelId);
  assert.equal(timeline.depth, 1);
  const divider = arranged.find(channel => channel.id === separator.channelId);
  assert.equal((await call('conversations/' + divider.conversationId + '/messages', undefined, second.cookie)).status, 404);
  assert.equal((await call(channelRoute + '/' + separator.channelId, { move: { targetId: mapChannelId, placement: 'before' } }, second.cookie)).status, 403);
  assert.equal((await call(channelRoute + '/' + separator.channelId, { move: { targetId: mapChannelId, placement: 'before' } }, first.cookie)).status, 200);
  assert.equal((await call(channelRoute + '/' + mapChannelId, { move: { targetId: chronicle.channelId, placement: 'inside' } }, first.cookie)).status, 400);
  assert.equal((await call(channelRoute + '/' + chronicle.channelId, { move: { targetId: separator.channelId, placement: 'inside' } }, first.cookie)).status, 400);
  assert.equal((await call(channelRoute + '/' + chronicle.channelId, { move: { targetId: mapChannelId, placement: 'after' } }, first.cookie)).status, 200);
  const reordered = await serverChannels();
  assert.equal(reordered.find(channel => channel.id === chronicle.channelId).depth, 0);
  assert.equal(reordered.find(channel => channel.id === chapter.channelId).depth, 1);
  assert.ok(reordered.findIndex(channel => channel.id === separator.channelId) < reordered.findIndex(channel => channel.id === mapChannelId));
  const timelineRoute = 'conversations/' + timeline.conversationId + '/timeline';
  assert.equal((await call(timelineRoute, undefined, outsider.cookie)).status, 404);
  const timeView = async (cookie = first.cookie) => (await call(timelineRoute, undefined, cookie)).json();
  assert.equal((await timeView()).calendar.mode, 'gregorian');
  const leapEvent = { action: 'create', title: 'Leap Day', year: 2000, month: 2, day: 29 };
  assert.equal((await call(timelineRoute, { ...leapEvent, year: 1900 }, first.cookie)).status, 400);
  assert.equal((await call(timelineRoute, leapEvent, first.cookie)).status, 200);
  const customCalendar = { mode: 'custom', months: [{ name: 'First Light', days: 30 }, { name: 'Dusk', days: 30 }],
    weekdays: ['Away', 'Home'], hoursPerDay: 20, minutesPerHour: 40, eras: [{ name: 'Founding', start: 1 }] };
  assert.equal((await call(timelineRoute, { action: 'calendar', calendar: customCalendar }, second.cookie)).status, 403);
  assert.equal((await call(timelineRoute, { action: 'calendar', calendar: { ...customCalendar, months: customCalendar.months.slice(0, 1) } }, first.cookie)).status, 409);
  assert.equal((await call(timelineRoute, { action: 'calendar', calendar: customCalendar }, first.cookie)).status, 200);
  assert.equal((await call(timelineRoute, { action: 'create', title: 'First Crossing', year: 2, month: 1, day: 3 }, second.cookie)).status, 200);
  const savedTimeline = await timeView(second.cookie);
  assert.deepEqual(savedTimeline.calendar, customCalendar);
  assert.deepEqual(savedTimeline.events.map(event => [event.title, event.editable]), [['First Crossing', true], ['Leap Day', false]]);
  assert.equal((await call(timelineRoute, { action: 'delete', id: savedTimeline.events[1].id }, second.cookie)).status, 403);
  assert.equal((await call(channelRoute + '/' + separator.channelId, { remove: true }, first.cookie)).status, 200);
  assert.equal((await serverChannels()).some(channel => channel.id === separator.channelId), false);


  const serverRoute = 'servers/' + community.id;
  assert.equal((await call(serverRoute + '/leave', {}, first.cookie)).status, 403);
  assert.equal((await call(serverRoute + '/invite', { recipientId: outsider.account.id }, second.cookie)).status, 403);
  assert.equal((await call(serverRoute + '/invite', { recipientId: outsider.account.id }, first.cookie)).status, 200);
  const pending = await (await call('conversations', undefined, outsider.cookie)).json();
  const invitedConversation = pending.conversations.find(thread => thread.peerId === first.account.id && !thread.inboxProxyId);
  assert.ok(invitedConversation);
  const invitedHistory = await (await call('conversations/' + invitedConversation.id + '/messages', undefined, outsider.cookie)).json();
  const invitationCard = invitedHistory.messages.find(message => message.inviteServerName === community.name && message.inviteStatus === 'pending');
  assert.equal(invitationCard.inviteRecipientId, outsider.account.id);
  assert.equal(invitationCard.inviteStatus, 'pending');
  assert.equal(invitationCard.inviteServerName, community.name);

  assert.equal((await call('server-invites/' + invitationCard.inviteId, { accept: true }, outsider.cookie)).status, 200);
  const acceptedInvite = await (await call('conversations/' + invitedConversation.id + '/messages?at=' + invitationCard.id, undefined, outsider.cookie)).json();
  assert.equal(acceptedInvite.message.inviteStatus, 'accepted');

  assert.equal((await call(mapRoute, undefined, outsider.cookie)).status, 200);
  assert.equal((await call(serverRoute + '/leave', {}, outsider.cookie)).status, 200);
  assert.equal((await call(serverRoute + '/leave', {}, outsider.cookie)).status, 404);
  assert.equal((await call(mapRoute, undefined, outsider.cookie)).status, 404);
  const afterLeave = await (await call('conversations', undefined, first.cookie)).json();
  assert.equal(afterLeave.servers.find(server => server.id === community.id).members.some(member => member.id === outsider.account.id), false);

  const route = `conversations/${id}/messages`;
  const body = '  *literal* <img src=x>\r\n  code\n';
  assert.equal((await call(route)).status, 401);
  assert.equal((await call(route, undefined, outsider.cookie)).status, 404);
  assert.equal((await call(route, { body }, outsider.cookie)).status, 404);
  assert.equal((await call(route, { body }, first.cookie, false)).status, 403);
  assert.equal((await call(route, { body, senderId: outsider.account.id }, first.cookie)).status, 201);
  const page = await (await call(route, undefined, second.cookie)).json();
  assert.equal(page.messages[0].body, body);
  assert.equal(page.messages[0].senderId, first.account.id);
  assert.equal(page.messages[0].publicTag, '0042');
  assert.equal(Object.hasOwn(page.messages[0], 'username'), false);

  const insert = db.prepare('INSERT INTO direct_messages(conversation_id, sender_id, body, sent) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 54; i++) insert.run(id, first.account.id, 'later', i);
  const latest = await (await call(route, undefined, second.cookie)).json();
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.hasOlder, true);
  const older = await (await call(route + '?before=' + latest.messages[0].id, undefined, second.cookie)).json();
  assert.equal(older.messages.length, 5);
  const newer = await (await call(route + '?after=' + page.messages[0].id, undefined, second.cookie)).json();
  assert.equal(newer.messages[0].id, page.messages[0].id + 1);
  assert.equal(newer.hasNewer, true);
  const rosterPath = process.env.HORIZON_TEST_ROSTER;
  const roster = rosterPath ? JSON.parse((await readFile(rosterPath, 'utf8')).replace(/^\uFEFF/, '')) : {
    tuppers: [{ name: 'Ultima', brackets: ['uv:', ''], description: 'Example', group_id: 7 }],
    groups: [{ id: 7, name: 'Example group' }],
  };
  const upload = await call('proxies/import', roster, first.cookie);
  assert.equal(upload.status, 200);
  const imported = await upload.json();
  assert.equal(imported.imported, roster.tuppers.length);
  const reimported = await (await call('proxies/import', roster, first.cookie)).json();
  assert.equal(reimported.duplicates.length, roster.tuppers.length);
  assert.equal(reimported.imported, 0);
  const proxy = imported.proxies.find(entry => entry.prefix === 'uv:' && !entry.suffix);
  assert.ok(proxy.group);
  const recipientRoster = await (await call('proxies', undefined, second.cookie)).json();
  assert.deepEqual(recipientRoster.proxies, []);
  assert.equal((await call(route, { body: 'forged character', proxyId: proxy.id }, second.cookie)).status, 400);
  assert.equal((await call(route, { body: 'Selected character', proxyId: proxy.id }, first.cookie)).status, 201);
  assert.equal((await call(route, { body: 'uv:Trigger message' }, first.cookie)).status, 201);
  assert.equal((await call(route, { body: 'As myself' }, first.cookie)).status, 201);
  const proxyHistory = await (await call(route, undefined, second.cookie)).json();
  assert.deepEqual(proxyHistory.messages.slice(-3).map(row => [row.displayName, row.body]), [
    [proxy.name, 'Selected character'], [proxy.name, 'Trigger message'], ['First Member', 'As myself'],
  ]);
  const reproxy = await call(route, { body: 'uv:' }, first.cookie);
  assert.equal(reproxy.status, 200);
  const { updatedId } = await reproxy.json();
  assert.equal(updatedId, proxyHistory.messages.at(-1).id);
  const changed = await (await call(route + '?at=' + updatedId, undefined, second.cookie)).json();
  assert.equal(changed.message.displayName, proxy.name);
  assert.equal(changed.message.body, 'As myself');
  const exactCode = 'uv:  -- literal code\n  print("test")\n';
  assert.equal((await call(route, { body: exactCode, format: { kind: 'code', language: 'lua' } }, first.cookie)).status, 201);
  assert.equal((await call(route, {
    body: 'Unsafe tag', format: { kind: 'rich', nodes: [{ tag: 'script', children: ['unsafe'] }] },
  }, first.cookie)).status, 400);
  const formatted = await (await call(route, undefined, second.cookie)).json();
  assert.equal(formatted.messages.at(-1).body, exactCode);
  assert.equal(formatted.messages.at(-1).displayName, 'First Member');
  assert.deepEqual(JSON.parse(formatted.messages.at(-1).format), { kind: 'code', language: 'lua' });
  const longMessage = 'long '.repeat(4000);
  assert.equal((await call(route, { body: longMessage }, first.cookie)).status, 201);
  const fileHistory = await (await call(route, undefined, second.cookie)).json();
  const attachment = fileHistory.messages.at(-1);
  assert.equal(attachment.body, '');
  assert.equal(JSON.parse(attachment.format).bytes, Buffer.byteLength(longMessage));
  const document = route + '/' + attachment.id + '/document';
  assert.equal((await call(document, undefined, outsider.cookie)).status, 404);
  const preview = await call(document, undefined, second.cookie);
  const rest = await call(document + '?offset=16384', undefined, second.cookie);
  assert.equal((await preview.clone().arrayBuffer()).byteLength, 16384);
  assert.equal((await preview.text()) + (await rest.text()), longMessage);
  const binary = Buffer.alloc(300_000, 0xff);
  const uploadFile = await fetch(base + route, {
    method: 'POST',
    headers: {
      Cookie: first.cookie,
      'Content-Type': 'application/octet-stream',
      'X-Horizon-Chat': '1',
      'X-Horizon-Filename': 'archive.zip',
    },
    body: binary,
  });
  assert.equal(uploadFile.status, 201);
  const uploaded = (await (await call(route, undefined, second.cookie)).json()).messages.at(-1);
  assert.deepEqual(JSON.parse(uploaded.format), {
    kind: 'document', name: 'archive.zip', language: 'zip', bytes: binary.length, mime: 'application/octet-stream', chunkBytes: 262_144,
  });
  const binaryRoute = route + '/' + uploaded.id + '/document';
  assert.equal((await call(binaryRoute, undefined, outsider.cookie)).status, 404);
  const compressed = await call(binaryRoute, undefined, second.cookie);
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  const firstBatch = Buffer.from(await compressed.arrayBuffer());
  assert.equal(firstBatch.length, 262_144);
  const lastBatch = Buffer.from(await (await call(binaryRoute + '?offset=262144', undefined, second.cookie)).arrayBuffer());
  assert.deepEqual(Buffer.concat([firstBatch, lastBatch]), binary);

  const source = page.messages[0];
  assert.equal((await call(route, { body: 'Malformed', replyTo: '1' }, second.cookie)).status, 400);
  const unrelated = 'conversations/' + community.conversationId + '/messages';
  assert.equal((await call(unrelated, { body: 'Cross-chat reply', replyTo: source.id }, second.cookie)).status, 404);
  assert.equal((await call(route, { body: 'A reply', replyTo: source.id }, second.cookie)).status, 201);
  const withReply = (await (await call(route, undefined, first.cookie)).json()).messages.at(-1);
  assert.equal(withReply.isReply, 1);
  assert.equal(withReply.replyTargetId, source.id);
  assert.equal(withReply.replyAuthor, first.account.displayName);
  assert.equal(withReply.replyText, source.body);
  assert.equal((await call(route + '/' + source.id + '/edit', { body: 'Edited original' }, first.cookie)).status, 200);
  assert.equal((await (await call(route + '?at=' + withReply.id, undefined, first.cookie)).json()).message.replyText, 'Edited original');
  const attachmentMeta = Buffer.from(JSON.stringify({ body: 'Reply with attachment', replyTo: source.id }));
  const attachmentReply = await fetch(base + route, {
    method: 'POST',
    headers: { Cookie: second.cookie, 'Content-Type': 'application/octet-stream', 'X-Horizon-Chat': '1',
      'X-Horizon-Filename': 'file.txt', 'X-Horizon-Message-Bytes': String(attachmentMeta.length) },
    body: Buffer.concat([attachmentMeta, Buffer.from('test file')]),
  });
  assert.equal(attachmentReply.status, 201);
  const replyFile = (await (await call(route, undefined, first.cookie)).json()).messages.at(-1);
  assert.equal(replyFile.replyTargetId, source.id);
  assert.equal((await call(route + '/' + source.id + '/delete', {}, first.cookie)).status, 200);
  const orphaned = (await (await call(route + '?at=' + withReply.id, undefined, second.cookie)).json()).message;
  assert.equal(orphaned.isReply, 1);
  assert.equal(orphaned.replyTargetId, null);
  assert.equal(orphaned.replyText, null);
  assert.equal((await call(route, { body: 'Reply to deleted source', replyTo: source.id }, second.cookie)).status, 404);
  assert.equal((await call('logout', {}, first.cookie)).status, 200);
  assert.equal((await call(route, undefined, first.cookie)).status, 401);

  db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run('First', first.account.id);
  db.prepare("UPDATE accounts SET display_name = 'Outsider', display_key = '', public_tag = '' WHERE id = ?").run(outsider.account.id);
  handler = createMessenger(db, options);
  const migratedOutsider = await (await call('session', undefined, outsider.cookie)).json();
  assert.equal(migratedOutsider.account.displayName, 'Horizon member');
  const legacyLogin = await call('login', { username: 'First', password });
  assert.equal(legacyLogin.status, 200);
  assert.equal((await legacyLogin.json()).account.username, 'First:0000');
  const migratedHistory = await (await call(route, undefined, second.cookie)).json();
  assert.equal(migratedHistory.messages.length, 50);

  const horizon = await signUp('brokensynapsehorizon', '0000', password, 'Horizon');
  const oldDm = await call('conversations', { handle: 'Horizon#0000' }, second.cookie);
  assert.equal(oldDm.status, 200);
  const { id: oldDmId } = await oldDm.json();
  handler = createMessenger(db, options);
  async function list(viewer) {
    const response = await call('conversations', undefined, viewer.cookie);
    assert.equal(response.status, 200);
    return (await response.json()).conversations;
  }
  const writer = await list(horizon);
  const everyone = writer[0];
  assert.equal(everyone.displayName, 'Everyone');
  assert.equal(everyone.broadcastWriter, true);
  assert.equal(everyone.unread, 0);
  const shared = 'conversations/' + everyone.id;
  const sharedMessages = shared + '/messages';
  assert.equal((await list(second)).some(thread => [everyone.id, oldDmId].includes(thread.id)), false);
  assert.equal((await call('conversations', { handle: 'Horizon#0000' }, second.cookie)).status, 404);
  assert.equal((await call('contacts', { handle: 'Horizon#0000' }, second.cookie)).status, 404);
  assert.equal((await call('conversations/' + oldDmId + '/messages', { body: 'No DM' }, second.cookie)).status, 404);
  assert.equal((await call(sharedMessages, undefined, second.cookie)).status, 404);

  const savedContact = await call('contacts', { handle: 'Café: Reader#4423' }, horizon.cookie);
  assert.equal(savedContact.status, 200);
  const openedByOwner = await call('conversations', { recipientId: second.account.id }, horizon.cookie);
  assert.equal(openedByOwner.status, 200);
  assert.equal((await openedByOwner.json()).id, oldDmId);
  const ownerDmMessages = 'conversations/' + oldDmId + '/messages';
  assert.equal((await call(ownerDmMessages, { body: 'Private note from Horizon' }, horizon.cookie)).status, 201);
  assert.equal((await call(ownerDmMessages, { body: 'Private reply' }, second.cookie)).status, 201);
  assert.equal((await call(ownerDmMessages, undefined, outsider.cookie)).status, 404);
  assert.equal((await call('conversations', { handle: 'Horizon#0000' }, outsider.cookie)).status, 404);
  assert.equal((await list(horizon))[0].id, everyone.id);

  const dmHistory = await (await call(ownerDmMessages, undefined, horizon.cookie)).json();
  const reply = dmHistory.messages.find(message => message.body === 'Private reply');
  assert.equal((await call(ownerDmMessages + '/' + reply.id + '/delete', {}, horizon.cookie)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM direct_messages WHERE id = ?').get(reply.id), undefined);
  assert.equal((await call(ownerDmMessages + '?at=' + reply.id, undefined, second.cookie)).status, 404);
  assert.equal((await call(ownerDmMessages, { body: 'attached text '.repeat(500) }, second.cookie)).status, 201);
  const ownerAttachment = (await (await call(ownerDmMessages, undefined, horizon.cookie)).json()).messages.at(-1);
  const chunksFor = db.prepare('SELECT count(*) AS n FROM message_document_chunks WHERE message_id = ?');
  assert.ok(chunksFor.get(ownerAttachment.id).n > 0);
  assert.equal((await call(ownerDmMessages + '/' + ownerAttachment.id + '/delete', {}, horizon.cookie)).status, 200);
  assert.equal(chunksFor.get(ownerAttachment.id).n, 0);

  assert.equal((await call(route + '/' + page.messages[0].id + '/delete', {}, horizon.cookie)).status, 404);
  await call('servers/join', { code: community.inviteCode }, horizon.cookie);
  const communityRoute = 'conversations/' + community.conversationId + '/messages';
  assert.equal((await call(communityRoute, { body: 'Member message' }, second.cookie)).status, 201);
  const memberMessage = (await (await call(communityRoute, undefined, horizon.cookie)).json()).messages.at(-1);
  assert.equal((await call(communityRoute + '/' + memberMessage.id + '/delete', {}, horizon.cookie)).status, 200);
  assert.equal((await call(communityRoute + '?at=' + memberMessage.id, undefined, second.cookie)).status, 404);


  const announcementAbort = new AbortController();
  const announcementStream = await fetch(base + 'events', { headers: { Cookie: second.cookie }, signal: announcementAbort.signal });
  const announcementReader = announcementStream.body.getReader();
  await announcementReader.read();
  const announcementTimeout = setTimeout(() => announcementAbort.abort(), 5000);
  try {
    assert.equal((await call(sharedMessages, { body: 'First broadcast' }, horizon.cookie)).status, 201);
    let event = '';
    while (!event.includes(':0:announcement')) event += new TextDecoder().decode((await announcementReader.read()).value);
    assert.match(event, /event: incoming/);
  } finally {
    clearTimeout(announcementTimeout); announcementAbort.abort(); await announcementReader.cancel().catch(() => {});
  }
  const total = db.prepare('SELECT count(*) AS n FROM accounts WHERE id <> ?').get(horizon.account.id).n;
  const deliveries = db.prepare('SELECT account_id, message_id FROM broadcast_deliveries').all();
  assert.equal(deliveries.length, total);
  assert.ok(deliveries.every(row => row.account_id !== horizon.account.id));
  assert.equal(new Set(deliveries.map(row => row.message_id)).size, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM direct_messages WHERE conversation_id = ?').get(everyone.id).n, 1);
  const messageId = deliveries[0].message_id;
  const received = (await list(second)).find(thread => thread.id === everyone.id);
  assert.equal(received.displayName, 'Horizon');
  assert.equal(received.unread, 1);
  assert.equal(received.broadcastWriter, undefined);
  const history = await (await call(sharedMessages, undefined, second.cookie)).json();
  assert.deepEqual(history.messages.map(message => [message.id, message.body]), [[messageId, 'First broadcast']]);
  assert.equal((await call(sharedMessages, { body: 'Cannot reply' }, second.cookie)).status, 403);
  assert.equal((await call(sharedMessages + '/' + messageId + '/delete', {}, second.cookie)).status, 403);
  assert.equal((await call(shared + '/read', { inboxProxyId: 0, through: messageId }, second.cookie)).status, 200);
  assert.equal((await list(second)).find(thread => thread.id === everyone.id).unread, 0);
  assert.equal((await list(outsider)).find(thread => thread.id === everyone.id).unread, 1);
  assert.equal((await call(shared + '/close', { inboxProxyId: 0 }, second.cookie)).status, 200);
  assert.equal((await list(second)).some(thread => thread.id === everyone.id), false);
  assert.equal((await call(shared + '/close', { inboxProxyId: 0 }, horizon.cookie)).status, 404);
  const late = await signUp('LateMember', '4444', password, 'Late Member');
  assert.equal((await call(sharedMessages, undefined, late.cookie)).status, 404);
  assert.equal((await call(sharedMessages, { body: 'Second broadcast' }, horizon.cookie)).status, 201);
  assert.equal((await list(second)).find(thread => thread.id === everyone.id).unread, 1);
  const lateHistory = await (await call(sharedMessages, undefined, late.cookie)).json();
  assert.deepEqual(lateHistory.messages.map(message => message.body), ['Second broadcast']);
  assert.equal((await call(sharedMessages, { body: 'Broadcast reply', replyTo: messageId }, horizon.cookie)).status, 201);
  const limitedBroadcast = (await (await call(sharedMessages, undefined, late.cookie)).json()).messages.at(-1);
  assert.equal(limitedBroadcast.isReply, 1);
  assert.equal(limitedBroadcast.replyTargetId, null);
  assert.equal(limitedBroadcast.replyText, null);

  assert.equal((await call(sharedMessages + '?at=' + messageId, undefined, late.cookie)).status, 404);
  assert.equal((await list(horizon))[0].unread, 0);


  db.prepare('UPDATE platform_owner SET account_id = ? WHERE singleton = 1').run(second.account.id);
  assert.equal((await list(second))[0].broadcastWriter, true);
  assert.equal((await list(second))[0].id, everyone.id);
  assert.equal((await list(horizon)).some(thread => thread.broadcastWriter), false);
  assert.equal((await call(sharedMessages, { body: 'Former owner cannot broadcast' }, horizon.cookie)).status, 404);
  assert.equal((await call(sharedMessages, { body: 'Broadcast after transfer' }, second.cookie)).status, 201);
  const formerOwnerHistory = await (await call(sharedMessages, undefined, horizon.cookie)).json();
  assert.deepEqual(formerOwnerHistory.messages.map(message => message.body), ['Broadcast after transfer']);
  assert.equal(formerOwnerHistory.messages[0].senderId, second.account.id);
  assert.equal((await list(second))[0].unread, 0);
  const transferredMessage = formerOwnerHistory.messages[0];
  assert.equal((await call(sharedMessages + '/' + transferredMessage.id + '/delete', {}, horizon.cookie)).status, 403);
  assert.equal((await call(sharedMessages + '/' + messageId + '/delete', {}, second.cookie)).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM broadcast_deliveries WHERE message_id = ?').get(messageId).n, 0);


});
