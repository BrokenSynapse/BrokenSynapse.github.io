import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

test('variants share appearance references and channel passwords protect all content routes', async t => {
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

  const image=seed=>{const b=Buffer.alloc(20);b.write('RIFF');b.writeUInt32LE(12,4);b.write('WEBP',8);b.write('VP8 ',12);b[19]=seed;return 'data:image/webp;base64,'+b.toString('base64');};
  await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:0,avatar:image(1),fullBody:image(2)},first.cookie);
  await call(`conversations/${textId}/messages`,{body:'Main one',proxyId:proxy.id,variantId:0},first.cookie);
  await call(`conversations/${textId}/messages`,{body:'Main two',proxyId:proxy.id,variantId:0},first.cookie);
  const created=(await call('proxies/'+proxy.id+'/variants',{action:'create',name:'Ascended',fromVariantId:0},first.cookie)).data;
  const id=created.variantId;
  await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',avatar:image(3),fullBody:image(4)},first.cookie);
  assert.equal((await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',designation:'T123'},first.cookie)).data.proxy.variants.find(v=>v.id===id).designation,'T123','Variants may share Main’s hash');
  await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',designation:'bad'},first.cookie,400);
  await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',designation:'PWR1'},first.cookie);
  await call('proxies/'+proxy.id+'/variants',{action:'select',variantId:id},first.cookie);
  await call(`conversations/${textId}/messages`,{body:'Ascended one',proxyId:proxy.id,variantId:id},first.cookie);
  let history=(await call(`conversations/${textId}/messages`,undefined,first.cookie)).data.messages;
  assert.equal(history[0].variantId,0);assert.equal(history[1].variantId,0);assert.equal(history[2].variantId,id);
  assert.equal(history[0].designation,'T123');assert.equal(history[2].designation,'PWR1');
  assert.equal(history[0].avatarUrl,history[1].avatarUrl);assert.notEqual(history[0].avatarUrl,history[2].avatarUrl);
  assert.notEqual(history[0].fullBodyUrl,history[2].fullBodyUrl);
  const refs=db.prepare('SELECT look_id FROM message_character_looks ORDER BY message_id').all();
  assert.equal(refs[0].look_id,refs[1].look_id);assert.notEqual(refs[0].look_id,refs[2].look_id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_looks').get().n,2,'One shared appearance per variant, not per message');
  const oldMainBody=history[0].fullBodyUrl,oldOtherBody=history[2].fullBodyUrl;
  await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:0,fullBody:image(6)},first.cookie);
  history=(await call(`conversations/${textId}/messages`,undefined,first.cookie)).data.messages;
  assert.notEqual(history[0].fullBodyUrl,oldMainBody,'Old Main posts use the live Main full-body image');
  assert.equal(history[2].fullBodyUrl,oldOtherBody,'Main edits do not retarget other variants');
  const before=history[2].avatarUrl;
  await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',avatar:image(5)},first.cookie);
  history=(await call(`conversations/${textId}/messages`,undefined,first.cookie)).data.messages;assert.notEqual(history[2].avatarUrl,before,'Editing a variant updates its shared appearance without retargeting other variants');
  assert.equal(history[0].variantId,0);assert.notEqual(history[0].avatarUrl,history[2].avatarUrl);
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_looks').get().n,2,'Used variants keep one shared appearance each');
  const saveVersion=fields=>call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',...fields},first.cookie);
  let changed=(await saveVersion({displayName:'Radiant Traveler',description:'Stage description',status:'Ready',group:'Stages',prefix:'radiant:',suffix:'!',designation:'STG1'})).data.proxy;
  let stage=changed.variants.find(v=>v.id===id);
  assert.equal(stage.displayName,'Radiant Traveler');assert.equal(stage.description,'Stage description');assert.equal(stage.status,'Ready');assert.equal(stage.group,'Stages');assert.equal(stage.prefix,'radiant:');assert.equal(stage.suffix,'!');
  await call('persona',{proxyId:proxy.id,variantId:id},first.cookie);
  let members=(await call('conversations',undefined,second.cookie)).data.servers.find(s=>s.id===world.id).members;
  assert.equal(members.find(m=>m.activeIdentity?.proxyId===proxy.id).activeIdentity.displayName,'Radiant Traveler');
  await call('persona',{proxyId:proxy.id,variantId:id},second.cookie,400);
  await call(`conversations/${textId}/messages`,{body:'radiant:Bracket stage!'},first.cookie);
  let last=(await call(`conversations/${textId}/messages`,undefined,first.cookie)).data.messages.at(-1);assert.equal(last.variantId,id);assert.equal(last.body,'Bracket stage');
  changed=(await saveVersion({displayName:'',description:'',status:'',group:'',prefix:'',suffix:'',designation:'',avatar:'',banner:'',fullBody:''})).data.proxy;
  stage=changed.variants.find(v=>v.id===id);
  for(const [key,base] of [['displayName','baseName'],['description','baseDescription'],['status','baseStatus'],['group','baseGroup'],['prefix','basePrefix'],['suffix','baseSuffix'],['designation','baseDesignation'],['avatarUrl','baseAvatarUrl'],['bannerUrl','baseBannerUrl'],['fullBodyUrl','baseFullBodyUrl']])assert.equal(stage[key],changed[base],key+' inherits Main');
  const mainFields={name:'Traveler updated',description:'Main description',status:'Main status',group:'Main group',prefix:'new:',suffix:'',designation:'MAIN'};
  changed=(await call('proxies/'+proxy.id,mainFields,first.cookie)).data.proxy;
  stage=changed.variants.find(v=>v.id===id);assert.equal(stage.displayName,mainFields.name);assert.equal(stage.description,mainFields.description);assert.equal(stage.status,mainFields.status);assert.equal(stage.designation,'MAIN');
  last=(await call(`conversations/${textId}/messages`,undefined,first.cookie)).data.messages.at(-1);assert.equal(last.displayName,mainFields.name);assert.equal(last.bio,mainFields.description);
  await call('persona',{proxyId:0,variantId:0},first.cookie);
  members=(await call('conversations',undefined,second.cookie)).data.servers.find(s=>s.id===world.id).members;assert.ok(members.every(m=>!m.activeIdentity));
  await call('proxies/'+proxy.id+'/variants',{action:'select',variantId:0},second.cookie,404);
  await call(`conversations/${textId}/messages`,{body:'Foreign variant',proxyId:proxy.id,variantId:id},second.cookie,400);
  const outsider=await call('register',{username:'OwnerFlagAccount',displayName:'Platform owner',tag:'P001',password:'testing'});
  await call('servers/join',{code:world.inviteCode},outsider.cookie);
  for(const kind of ['text','voice','forum','map','timeline']){
    const name='Locked '+kind;
    const {channelId}=(await call(`servers/${world.id}/channels`,{name,kind,everyoneVisibility:0,roleRules:[]},first.cookie)).data;
    const channel=(await call('conversations',undefined,first.cookie)).data.servers[0].channels.find(c=>c.id===channelId);
    assert.equal(channel.passwordProtected,false,'Every new channel defaults to password protection off');
    const route='conversations/'+channel.conversationId;
    if(kind!=='voice')await call(route+'/messages',{body:'A hidden message'},first.cookie);
    await call(route+'/password',{enabled:true,password:'secret pass'},first.cookie);
    await call(route+'/messages',undefined,second.cookie,423);
    await call(route+'/messages/1/document',undefined,second.cookie,423);
    await call(route+'/messages',{body:'Cannot send'},second.cookie,423);
    await call(route+'/roll',{sides:6},second.cookie,423);
    if(['forum','map','timeline'].includes(kind))await call(route+'/'+kind,undefined,second.cookie,423);
    await call(route+'/password',{enabled:false},second.cookie,403);
    await call(route+'/unlock',{password:'wrong'},second.cookie,403);
    await call(route+'/unlock',{password:'secret pass'},second.cookie);
    await call(route+'/messages',undefined,second.cookie);
    await call(route+'/password',{enabled:true,password:'new secret'},first.cookie);
    await call(route+'/messages',undefined,second.cookie,423,'Changing a password revokes prior unlocks');
    db.prepare('INSERT INTO platform_owner VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET account_id=excluded.account_id').run(outsider.data.account.id);
    await call(route+'/messages',undefined,outsider.cookie);
    await call(route+'/password',{enabled:false},first.cookie);
    await call(route+'/messages',undefined,second.cookie);
  }
  const role=Number(db.prepare("INSERT INTO server_roles(server_id,name,can_invite,can_manage_channels,administrator,options,position) VALUES (?,'Builder',0,1,0,'{}',10)").run(world.id).lastInsertRowid);
  db.prepare('INSERT INTO server_member_roles VALUES (?,?)').run(role,second.data.account.id);
  const createdByMember=(await call(`servers/${world.id}/channels`,{name:'Creator protected',kind:'text',everyoneVisibility:0,roleRules:[]},second.cookie)).data.channelId;
  db.prepare('DELETE FROM server_member_roles WHERE role_id=?').run(role);
  const memberChannel=(await call('conversations',undefined,second.cookie)).data.servers[0].channels.find(c=>c.id===createdByMember);
  assert.equal(memberChannel.canSetPassword,true,'The channel creator retains the password control');
  await call('conversations/'+memberChannel.conversationId+'/password',{enabled:true,password:'creator pass'},second.cookie);
  await call('conversations/'+memberChannel.conversationId+'/messages',undefined,outsider.cookie);
  db.prepare('UPDATE platform_owner SET account_id=? WHERE singleton=1').run(first.data.account.id);
  await call('conversations/'+memberChannel.conversationId+'/messages',undefined,outsider.cookie,423,'The bypass follows the transferable owner flag');

  const mainLook=db.prepare('SELECT * FROM character_looks WHERE proxy_id=? AND variant_id=0').get(proxy.id);
  const duplicate=Number(db.prepare('INSERT INTO character_looks(proxy_id,variant_id,signature,profile) VALUES (?,?,?,?)').run(proxy.id,0,'legacy-other-snapshot',JSON.stringify({...JSON.parse(mainLook.profile),fullBodyUrl:''})).lastInsertRowid);
  db.prepare('UPDATE message_character_looks SET look_id=? WHERE message_id=?').run(duplicate,history[1].id);
  createMessenger(db,{secure:false,json(){}});
  const mainReferences=db.prepare('SELECT look_id FROM message_character_looks WHERE message_id IN (?,?)').all(history[0].id,history[1].id);
  assert.equal(mainReferences[0].look_id,mainReferences[1].look_id,'Legacy Main snapshots consolidate into the shared Main reference');
  const migrated=db.prepare('SELECT profile FROM character_looks WHERE id=?').get(mainReferences[0].look_id);
  assert.ok(JSON.parse(migrated.profile).fullBodyUrl,'Legacy Main profiles gain the saved Main full-body image');

  const cleared=(await call('proxies/'+proxy.id+'/variants',{action:'save',variantId:id,name:'Ascended',designation:''},first.cookie)).data.proxy;
  assert.equal(cleared.variants.find(v=>v.id===id).designationOverride,'');
  assert.equal(cleared.variants.find(v=>v.id===id).designation,'MAIN','Blank overrides inherit Main');

});
