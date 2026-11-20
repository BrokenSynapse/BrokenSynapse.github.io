import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

test('DMs, channels and forum replies share character, attachment, dice and edit behavior', async t => {
  const db = new DatabaseSync(':memory:');
  const handler = createMessenger(db, { secure: false, json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  } });
  const server = createServer((request, response) => void handler(request, response, new URL(request.url, 'http://localhost')).catch(error => response.writeHead(500).end(String(error))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/horizon-chat/api/`;
  async function call(route, data, cookie, status) {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(cookie ? { Cookie: cookie } : {}), 'X-Horizon-Chat': '1', 'Content-Type': 'application/json',
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (status) assert.equal(response.status, status, await response.clone().text());
    else assert.ok(response.ok, await response.clone().text());
    return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const first = await call('register', { username: 'LifecycleOne', displayName: 'Writer', tag: 'L111', password: 'testing' });
  const second = await call('register', { username: 'LifecycleTwo', displayName: 'Reader', tag: 'L222', password: 'testing' });
  const { proxy } = (await call('proxies', { name: 'Traveler', prefix: 'tr:', suffix: '', group: '', designation: 'T123', description: '' }, first.cookie)).data;
  const { server: world } = (await call('servers', { name: 'World' }, first.cookie)).data;
  await call('servers/join', { code: world.inviteCode }, second.cookie);
  const { channelId } = (await call(`servers/${world.id}/channels`, { name: 'Forum', kind: 'forum', everyoneVisibility: 0, roleRules: [] }, first.cookie)).data;
  const directory = (await call('conversations', undefined, first.cookie)).data;
  const channels = directory.servers.find(s => s.id === world.id).channels;
  const forumId = channels.find(c => c.id === channelId).conversationId;
  const textId = channels.find(c => c.kind === 'text').conversationId;
  const dmId = (await call('conversations', { handle: 'Reader#L222' }, first.cookie)).data.id;
  const rich = { kind: 'rich', nodes: [{ tag: 's', children: ['Discussion'] }] };
  await call(`conversations/${forumId}/messages`, { body: 'Discussion', format: rich, forumBody: 'Original body', proxyId: proxy.id }, first.cookie);
  const post = (await call(`conversations/${forumId}/forum`, undefined, first.cookie)).data.posts[0];
  await call(`conversations/${forumId}/forum/${post.id}`, { title: 'Discussion', body: 'Edited body' }, second.cookie, 403);
  // The edit path must emit the ordinary edit event and preserve the stored rich text.
  const abort = new AbortController();
  const stream = await fetch(base + 'events', { headers: { Cookie: second.cookie }, signal: abort.signal });
  const reader = stream.body.getReader();
  await reader.read();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const edit = await call(`conversations/${forumId}/forum/${post.id}`, { title: 'Discussion', body: 'Edited body' }, first.cookie);
    assert.equal(edit.data.updatedId, post.id);
    let event = '';
    while (!event.includes(`data: ${forumId}:${post.id}`)) event += new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: message-edited/);
  } finally { clearTimeout(timeout); abort.abort(); await reader.cancel().catch(() => {}); }
  const updated = (await call(`conversations/${forumId}/forum/${post.id}`, undefined, first.cookie)).data.post;
  assert.deepEqual(JSON.parse(updated.format), rich);
  assert.equal(updated.body, 'Edited body');
  for (const conversation of [dmId, textId, forumId]) {
    const route = `conversations/${conversation}/messages`;
    const context = conversation === forumId ? { forumPostId: post.id } : {};
    await call(route, { ...context, body: 'tr:Struck message', format: { kind: 'rich', nodes: [{ tag: 's', children: ['tr:Struck message'] }] } }, first.cookie);
    let history = (await call(route + (context.forumPostId ? '?postId=' + post.id : ''), undefined, first.cookie)).data.messages;
    const message = history.at(-1);
    assert.equal(message.proxyId, proxy.id);
    assert.equal(message.body, 'Struck message');
    assert.deepEqual(JSON.parse(message.format).nodes, [{ tag: 's', children: ['Struck message'] }]);
    await call(route + '/' + message.id + '/edit', { body: 'Edited message', format: { kind: 'rich', nodes: [{ tag: 's', children: ['Edited message'] }] } }, first.cookie);
    await call(route + '/' + message.id + '/edit', { body: 'Forbidden edit' }, second.cookie, 404);
    const metadata = Buffer.from(JSON.stringify({ ...context, body: 'tr:Attached message' }));
    const upload = await fetch(base + route, { method: 'POST', headers: { Cookie: first.cookie, 'X-Horizon-Chat': '1',
      'Content-Type': 'application/octet-stream', 'X-Horizon-Filename': 'file.txt', 'X-Horizon-Message-Bytes': String(metadata.length),
    }, body: Buffer.concat([metadata, Buffer.from('same attachment data')]) });
    assert.equal(upload.status, 201, await upload.text());
    await call(`conversations/${conversation}/roll`, { ...context, expression: '2d6', proxyId: proxy.id }, first.cookie);
    history = (await call(route + (context.forumPostId ? '?postId=' + post.id : ''), undefined, first.cookie)).data.messages;
    const [edited, attachment, dice] = history.slice(-3);
    assert.equal(edited.proxyId, proxy.id);
    assert.equal(edited.body, 'Edited message');
    assert.equal(attachment.proxyId, proxy.id);
    assert.equal(attachment.body, 'Attached message');
    assert.equal(JSON.parse(attachment.format).kind, 'document');
    if (conversation === dmId) {
      const chunk = base + route + '/' + attachment.id + '/document?offset=0&encoding=gzip';
      const initial = await fetch(chunk, { headers: { Cookie: first.cookie, 'X-Horizon-Cache-Tag': 'miss' } });
      assert.equal(initial.status, 200);
      const tag = initial.headers.get('etag');
      assert.match(tag, /^"hc-[a-f0-9]{64}"$/);
      await initial.arrayBuffer();
      const verified = await fetch(chunk, { headers: { Cookie: second.cookie, 'X-Horizon-Cache-Tag': tag } });
      assert.equal(verified.status, 304);
      assert.equal(verified.headers.get('etag'), tag);
      assert.equal((await fetch(chunk, { headers: { 'X-Horizon-Cache-Tag': tag } })).status, 401);
      const outsider = await call('register', { username: 'LifecycleThree', displayName: 'Outsider', tag: 'L333', password: 'testing' });
      const denied = await fetch(chunk, { headers: { Cookie: outsider.cookie, 'X-Horizon-Cache-Tag': tag } });
      assert.ok([403, 404].includes(denied.status), 'a tag does not authorize another account');
    }
    assert.equal(dice.proxyId, proxy.id);
    assert.equal(JSON.parse(dice.format).kind, 'dice');
    if (context.forumPostId) assert.ok(history.every(m => m.forumPostId === post.id));
  }
  const final = (await call(`conversations/${forumId}/forum/${post.id}`, undefined, first.cookie)).data.post;
  assert.equal(final.comments, 3);
  await call(`conversations/${forumId}/messages/${post.id}/delete`, {}, first.cookie);
  assert.equal(db.prepare('SELECT count(*) AS n FROM direct_messages WHERE conversation_id = ?').get(forumId).n, 0);
});
