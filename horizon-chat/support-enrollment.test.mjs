import { createTyping } from './typing.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

test('support enrollment is automatic only at registration and respects later leaving', async t=>{
 const db=new DatabaseSync(':memory:');const handler=createMessenger(db,{secure:false,json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(data));}});
 const server=createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost')).catch(e=>res.writeHead(500).end(String(e))));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
 const base=`http://127.0.0.1:${server.address().port}/horizon-chat/api/`;
 async function call(route,data,cookie,status){const res=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{'X-Horizon-Chat':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});if(status)assert.equal(res.status,status,await res.clone().text());else assert.ok(res.ok,await res.clone().text());return {data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};}

 const owner=await call('register',{username:'SupportOwner',displayName:'Official Support',tag:'S001',password:'testing'});
 const support=(await call('servers',{name:'Horizon Chat Support'},owner.cookie)).data.server;
 db.prepare('INSERT INTO default_server_memberships VALUES (?)').run(support.id);
 const user=await call('register',{username:'NewSupportUser',displayName:'New member',tag:'S002',password:'testing'});
 let servers=(await call('conversations',undefined,user.cookie)).data.servers;assert.ok(servers.some(s=>s.id===support.id),'New account already belongs to support');
 assert.equal(db.prepare('SELECT count(*) AS n FROM server_member_roles WHERE account_id=?').get(user.data.account.id).n,0,'Default membership does not grant roles');
 await call('servers/'+support.id+'/leave',{},user.cookie);
 const login=await call('login',{username:'NewSupportUser',password:'testing'});servers=(await call('conversations',undefined,login.cookie)).data.servers;assert.ok(!servers.some(s=>s.id===support.id),'Leaving is respected at next login');
 createMessenger(db,{secure:false,json(){}});assert.equal(db.prepare('SELECT count(*) AS n FROM chat_server_members WHERE account_id=? AND server_id=?').get(user.data.account.id,support.id).n,0,'Restarts do not force rejoin');
 const another=await call('register',{username:'LaterSupportUser',displayName:'Later member',tag:'S003',password:'testing'});assert.ok((await call('conversations',undefined,another.cookie)).data.servers.some(s=>s.id===support.id));
 db.prepare('INSERT OR IGNORE INTO chat_server_members SELECT ?,id FROM accounts').run(support.id);const count=db.prepare('SELECT count(*) AS n FROM chat_server_members WHERE server_id=?').get(support.id).n;db.prepare('INSERT OR IGNORE INTO chat_server_members SELECT ?,id FROM accounts').run(support.id);assert.equal(db.prepare('SELECT count(*) AS n FROM chat_server_members WHERE server_id=?').get(support.id).n,count,'One-time backfill is idempotent');
});
