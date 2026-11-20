import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

test('mentions respect permissions and visibility, persist across reconnects, and forum descriptions preserve safe rich text', async t => {
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
  const outsider = await call('register', { username: 'PrivateOutside', displayName: 'Outside', tag: 'OUT1', password: 'testing' });
  const broad = await call(`conversations/${textId}/messages`, {body:'$everyone Hello'}, first.cookie);
  const saved=(await call('mentions',undefined,second.cookie)).data.mentions;
  assert.equal(saved.length,1); assert.equal(saved[0].conversationId,textId);
  assert.equal((await call('mentions',undefined,outsider.cookie)).data.mentions.length,0);
  await call(`conversations/${textId}/messages`, {body:'$everyone Not allowed'}, second.cookie);
  assert.equal((await call('mentions',undefined,first.cookie)).data.mentions.length,0);
  await call('mentions/read',{conversationId:textId},second.cookie);
  assert.equal((await call('mentions',undefined,second.cookie)).data.mentions.length,0);
  await call(`conversations/${textId}/messages`, {body:'${Reader#L222} Personal ping'}, first.cookie);
  assert.equal((await call('mentions',undefined,second.cookie)).data.mentions.length,1);
  await call('mentions/read',{conversationId:textId},outsider.cookie,404);
  const {channelId:privateChannel}= (await call(`servers/${world.id}/channels`,{name:'Hidden',everyoneVisibility:-1,roleRules:[]},first.cookie)).data;
  const hidden=(await call('conversations',undefined,first.cookie)).data.servers[0].channels.find(c=>c.id===privateChannel).conversationId;
  await call(`conversations/${hidden}/messages`,{body:'$everyone Hidden ping'},first.cookie);
  assert.equal((await call('mentions',undefined,second.cookie)).data.mentions.length,1,'Private channel pings never leak');
  const format={kind:'rich',nodes:[{tag:'s',children:['Rich body']}]};
  await call(`conversations/${forumId}/messages`,{body:'Rich post',forumBody:'Rich body',forumFormat:format},first.cookie);
  const forumPost=(await call(`conversations/${forumId}/forum`,undefined,first.cookie)).data.posts[0];
  const detail=(await call(`conversations/${forumId}/forum/${forumPost.id}`,undefined,first.cookie)).data.post;
  assert.deepEqual(JSON.parse(detail.bodyFormat),format);
  await call(`conversations/${forumId}/forum/${forumPost.id}`,{title:'Rich post',body:'Edited',bodyFormat:{kind:'rich',nodes:[{tag:'script',children:['Bad']}] }},first.cookie,400);
  await call(`conversations/${forumId}/forum/${forumPost.id}`,{title:'Rich post',body:'Edited',bodyFormat:{kind:'rich',nodes:[{tag:'em',children:['Edited']}] }},first.cookie);
  const edited=(await call(`conversations/${forumId}/forum/${forumPost.id}`,undefined,first.cookie)).data.post;
  assert.equal(JSON.parse(edited.bodyFormat).nodes[0].tag,'em');
  const abort=new AbortController();
  const live=await fetch(base+'events',{headers:{Cookie:second.cookie},signal:abort.signal});
  const reader=live.body.getReader();await reader.read();
  try {
    await call('presence',{state:'away'},second.cookie);
    const states=(await call('presence',undefined,first.cookie)).data.presence;
    assert.equal(states.find(p=>p.id===second.data.account.id).state,'away');
    assert.equal(states.some(p=>p.id===outsider.data.account.id),false);
    await call('presence',{state:'online'},second.cookie);
    assert.equal((await call('presence',undefined,first.cookie)).data.presence.find(p=>p.id===second.data.account.id).state,'online');
  } finally {abort.abort();await reader.cancel().catch(()=>{});}
});

