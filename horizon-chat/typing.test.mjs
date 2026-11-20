import { createTyping } from './typing.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMessenger } from './messenger.mjs';

test('typing is ephemeral, private, permission checked and separated by forum post', async t=>{
 const db=new DatabaseSync(':memory:');const handler=createMessenger(db,{secure:false,json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(data));}});
 const server=createServer((req,res)=>void handler(req,res,new URL(req.url,'http://localhost')).catch(e=>res.writeHead(500).end(String(e))));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
 const base=`http://127.0.0.1:${server.address().port}/horizon-chat/api/`;
 async function call(route,data,cookie,status){const res=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{'X-Horizon-Chat':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});if(status)assert.equal(res.status,status,await res.clone().text());else assert.ok(res.ok,await res.clone().text());return {data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};}
 const a=await call('register',{username:'TypingWriter',displayName:'Visible Writer',tag:'T001',password:'testing'}),b=await call('register',{username:'TypingReader',displayName:'Visible Reader',tag:'T002',password:'testing'}),c=await call('register',{username:'TypingOutside',displayName:'Outsider',tag:'T003',password:'testing'});
 const world=(await call('servers',{name:'Typing permissions'},a.cookie)).data.server;await call('servers/join',{code:world.inviteCode},b.cookie);
 const directory=()=>call('conversations',undefined,a.cookie);let text=(await directory()).data.servers[0].channels.find(c=>c.kind==='text').conversationId;
 assert.equal((await call('typing-preference',undefined,a.cookie)).data.enabled,true);
 await call('conversations/'+text+'/typing',{active:true,inboxProxyId:0},a.cookie);
 let people=(await call('conversations/'+text+'/typing',undefined,b.cookie)).data.people;assert.equal(people[0].displayName,'Visible Writer');assert.deepEqual(Object.keys(people[0]).sort(),['accountId','displayName','expires']);assert.equal((await call('conversations/'+text+'/typing',undefined,a.cookie)).data.people.length,0);
 await call('conversations/'+text+'/typing',undefined,c.cookie,404);await call('conversations/'+text+'/typing',{active:true},c.cookie,404);
 await call('typing-preference',{enabled:false},a.cookie);assert.equal((await call('conversations/'+text+'/typing',undefined,b.cookie)).data.people.length,0);await call('conversations/'+text+'/typing',{active:true,inboxProxyId:0},a.cookie);assert.equal((await call('conversations/'+text+'/typing',undefined,b.cookie)).data.people.length,0);
 await call('contacts',{handle:'Visible Reader#T002'},a.cookie);const dm=(await call('conversations',{handle:'Visible Reader#T002'},a.cookie)).data.id;
 await call('typing-preference',{enabled:true},a.cookie);await call('conversations/'+dm+'/typing',{active:true,inboxProxyId:0},a.cookie);assert.equal((await call('conversations/'+dm+'/typing',undefined,b.cookie)).data.people[0].displayName,'Visible Writer');await call('conversations/'+dm+'/typing',undefined,c.cookie,404);await call('typing-preference',{enabled:false},a.cookie);
 const login=await call('login',{username:'TypingWriter',password:'testing'},undefined);assert.equal((await call('typing-preference',undefined,login.cookie)).data.enabled,false);
 await call('typing-preference',{enabled:true},a.cookie);await call('conversations/'+text+'/password',{enabled:true,password:'testinglock'},a.cookie);await call('conversations/'+text+'/typing',{active:true,inboxProxyId:0},a.cookie);await call('conversations/'+text+'/typing',undefined,b.cookie,423);await call('conversations/'+text+'/unlock',{password:'testinglock'},b.cookie);assert.equal((await call('conversations/'+text+'/typing',undefined,b.cookie)).data.people.length,1);
 await call('conversations/'+text+'/typing',{active:false},a.cookie);assert.equal((await call('conversations/'+text+'/typing',undefined,b.cookie)).data.people.length,0);
 await call('servers/'+world.id+'/channels',{name:'Forum',kind:'forum',everyoneVisibility:0,roleRules:[]},a.cookie);const forum=(await directory()).data.servers[0].channels.find(c=>c.kind==='forum').conversationId;
 await call('conversations/'+forum+'/messages',{body:'First topic'},a.cookie);await call('conversations/'+forum+'/messages',{body:'Second topic'},a.cookie);const posts=(await call('conversations/'+forum+'/forum',undefined,a.cookie)).data.posts;
 await call('conversations/'+forum+'/typing',{active:true,postId:posts[0].id,inboxProxyId:0},a.cookie);assert.equal((await call('conversations/'+forum+'/typing?postId='+posts[0].id,undefined,b.cookie)).data.people.length,1);assert.equal((await call('conversations/'+forum+'/typing?postId='+posts[1].id,undefined,b.cookie)).data.people.length,0);await call('conversations/'+forum+'/typing',{active:true,postId:999999,inboxProxyId:0},a.cookie,400);
});

test('typing expires and locked sessions never receive typing events',t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE accounts(id INTEGER PRIMARY KEY);INSERT INTO accounts VALUES (1),(2)');t.after(()=>db.close());const allowed=[],locked=[];
 const streams=new Map([[2,new Set([{tokenHash:'allowed',response:{write:event=>{allowed.push(event);return true;}}},{tokenHash:'locked',response:{write:event=>{locked.push(event);return true;}}}])]]);
 const typing=createTyping(db,streams,(_conversation,_viewer,token)=>token==='allowed');typing.update(1,'writer',123,null,'Visible Writer',true);assert.equal(allowed.length,1);assert.equal(locked.length,0);assert.equal(typing.list(123,null,2).length,1);
 t.mock.timers.tick(8001);assert.equal(typing.list(123,null,2).length,0);assert.equal(allowed.length,2);assert.equal(locked.length,0);assert.match(allowed[1],/"people":\[\]/);
});
