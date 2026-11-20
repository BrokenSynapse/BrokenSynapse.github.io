// Ephemeral typing metadata only: never store drafts or message contents.
export function createTyping(db,streams,canRead){
 db.exec('CREATE TABLE IF NOT EXISTS typing_preferences(account_id INTEGER PRIMARY KEY REFERENCES accounts(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))');
 const states=new Map();
 const preferenceRow=db.prepare('SELECT enabled FROM typing_preferences WHERE account_id=?');
 const enabled=id=>preferenceRow.get(id)?.enabled!==0;
 function list(conversation,postId,viewer){const people=new Map();for(const state of states.values())if(state.conversation===conversation&&state.postId===postId&&state.account!==viewer&&state.until>Date.now()&&enabled(state.account))people.set(state.account,{accountId:state.account,displayName:state.name,expires:state.until});return [...people.values()];}
 function publish(conversation,postId){for(const [viewer,clients] of streams)for(const client of clients){if(!canRead(conversation,viewer,client.tokenHash))continue;const data=JSON.stringify({conversationId:conversation,postId,people:list(conversation,postId,viewer)});if(!client.response.write('event: typing\ndata: '+data+'\n\n'))client.response.destroy();}}
 function remove(key){const state=states.get(key);if(!state)return;clearTimeout(state.timer);states.delete(key);publish(state.conversation,state.postId);}
 return {enabled,list,
 preference(account,value){db.prepare('INSERT INTO typing_preferences VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled').run(account,Number(value));if(!value)for(const [key,state] of states)if(state.account===account)remove(key);for(const client of streams.get(account)||[])client.response.write('event: typing-preference\ndata: '+JSON.stringify({enabled:value})+'\n\n');},
 update(account,token,conversation,postId,name,active){const key=token+':'+conversation+':'+(postId||0);if(!active||!enabled(account)){remove(key);return;}
 const old=states.get(key);if(old&&Date.now()-old.at<1500&&old.name===name)return;
 if(!old&&[...states.values()].filter(s=>s.account===account).length>=10)return;
 if(old)clearTimeout(old.timer);const state={account,conversation,postId,name,at:Date.now(),until:Date.now()+8000};states.set(key,state);state.timer=setTimeout(()=>remove(key),8000);state.timer.unref();publish(conversation,postId);
 },stop(account,token,conversation,postId){remove(token+':'+conversation+':'+(postId||0));}
 };
}
