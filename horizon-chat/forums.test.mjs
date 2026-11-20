import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMessenger } from './messenger.mjs';
import { createForums } from './forums.mjs';
import { createServerLayouts } from './server-layouts.mjs';

test('forum votes, descriptions, discussions and personal folders survive reinitialization', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createMessenger(db, { secure: false, json() {} });
    db.exec(`INSERT INTO accounts(id, username, display_name, salt, credential,display_key,public_tag) VALUES (1,'a:0001','A','','','a','0001'),(2,'b:0002','B','','','b','0002');
      INSERT INTO conversations(id,first_id,second_id,first_proxy,second_proxy) VALUES (1,1,2,-1,-1),(2,1,2,-2,-2);
      INSERT INTO chat_servers(id,owner_id,name,invite_code) VALUES (1,1,'World','WORLD'),(2,2,'Other','OTHER');
      INSERT INTO chat_server_members(server_id,account_id) VALUES (1,1),(1,2),(2,2);
      INSERT INTO server_channels(id,server_id,conversation_id,name,kind) VALUES (1,1,1,'Forum','forum');
      INSERT INTO direct_messages(id,conversation_id,sender_id,body,sent) VALUES (1,1,1,'Existing topic',1);`);
    assert.equal(db.prepare('SELECT theme FROM chat_servers WHERE id = 1').get().theme,'sage');
    db.prepare("UPDATE chat_servers SET theme = 'clove' WHERE id = 1").run();
    createMessenger(db, {secure:false,json(){}});
    assert.equal(db.prepare('SELECT theme FROM chat_servers WHERE id = 1').get().theme,'clove','Theme survives initialization');
    let forums = createForums(db);
    assert.equal(forums.detail(1,1,1).title,'Existing topic');
    db.exec("INSERT INTO direct_messages(id,conversation_id,sender_id,body,sent) VALUES (2,1,2,'Comment',2)");
    forums.record(1,2,{forumPostId:1});
    forums.vote(1,1,1,1); forums.vote(1,1,1,1); forums.vote(1,2,1,-1);
    assert.equal(forums.detail(1,1,1).rating,0);
    const edit = forums.prepareEdit(1,1,{title:'Edited topic',body:'Private body'});
    assert.equal(edit.body,'Edited topic');
    forums.updateBody(1,edit);
    const layouts=createServerLayouts(db);
    assert.equal(layouts.save(1,[{serverId:2}]).status,400);
    const folder={folderId:'worlds',name:'Worlds',image:'',open:false,servers:[1]};
    assert.deepEqual(layouts.save(1,[folder]).layout,[folder]);
    forums=createForums(db);
    assert.equal(forums.list(1,1).posts.length,1,'Restart must never promote comments into topics');
    assert.equal(forums.detail(1,1,1).body,'Private body');
    assert.equal(forums.detail(1,1,1).comments,1);
    assert.deepEqual(createServerLayouts(db).get(1),[folder]);
    assert.deepEqual(createServerLayouts(db).get(2),[],'Layouts are personal');
    db.exec('DELETE FROM direct_messages WHERE id = 1');
    assert.equal(db.prepare('SELECT count(*) AS n FROM direct_messages').get().n,0,'Deleting a post removes its discussion');
    assert.equal(db.prepare('SELECT count(*) AS n FROM forum_votes').get().n,0);
  } finally { db.close(); }
});
