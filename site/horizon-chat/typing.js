import { apiFetch } from './platform.js';
export function createTypingUI({call,scope,identity,viewer,canType}){
 const panel=document.getElementById('typing-indicator'),setting=document.getElementById('share-typing'),feedback=document.getElementById('typing-setting-status');
 const states=new Map();let enabled=false,ready=false,sent=null,lastSent=0,idle,queue=Promise.resolve(),generation=0;
 const key=s=>s?s.conversationId+':'+(s.postId||0):'';
 const dots=()=>{const node=document.createElement('span');node.className='typing-dots';node.setAttribute('aria-hidden','true');for(let i=0;i<3;i++)node.append(document.createElement('i'));return node;};
 const names=people=>{const list=people.map(p=>p.displayName);return list.length<=3?new Intl.ListFormat(undefined,{style:'long',type:'conjunction'}).format(list):list.slice(0,2).join(', ')+' and '+(list.length-2)+' others';};
 function peopleFor(s){return (states.get(key(s))||[]).filter(p=>p.expires>Date.now()&&p.accountId!==viewer()?.id);}
 function paint(){const current=scope(),people=peopleFor(current),text=people.length?names(people)+(people.length===1?' is typing':' are typing'):'';
  if(panel.dataset.label!==text){panel.dataset.label=text;panel.replaceChildren();if(text)panel.append(document.createTextNode(text+' '),dots());}panel.hidden=!text||!canType();
  for(const row of document.querySelectorAll('[data-typing-thread]')){const peers=[...states.entries()].filter(([k])=>Number(k.split(':')[0])===Number(row.dataset.typingThread)).flatMap(([,list])=>list).filter(p=>p.expires>Date.now()&&p.accountId!==viewer()?.id);const unique=[...new Map(peers.map(p=>[p.accountId,p])).values()],label=unique.length?'typing':'';if(row.dataset.typingLabel===label)continue;row.dataset.typingLabel=label;let badge=row.querySelector(':scope > .chat-typing');if(!label){badge?.remove();continue;}if(!badge){badge=document.createElement('span');badge.className='chat-typing';badge.append(dots());const more=row.querySelector(':scope > .channel-more');row.insertBefore(badge,more||null);}badge.title='Someone is typing';badge.setAttribute('aria-label','Someone is typing');}
 }
 function write(s,active){const user=viewer(),payload={...identity(),postId:s.postId,active};queue=queue.catch(()=>{}).then(()=>viewer()===user?call('conversations/'+s.conversationId+'/typing',payload):null).catch(()=>{});}
 function stop(){clearTimeout(idle);if(sent)write(sent,false);sent=null;lastSent=0;}
 function activity(){if(!ready||!enabled||!canType()||document.hidden)return;const current=scope();if(!current)return;if(sent&&key(sent)!==key(current))stop();sent=current;if(Date.now()-lastSent>=2500){lastSent=Date.now();write(current,true);}clearTimeout(idle);idle=setTimeout(stop,1800);}
 async function snapshot(){const user=viewer(),s=scope();if(!s||!user)return;try{const data=await call('conversations/'+s.conversationId+'/typing'+(s.postId?'?postId='+s.postId:''));if(viewer()===user&&key(scope())===key(s))receive({...s,people:data.people||[]});}catch{}}
 function receive(data){states.set(key(data),data.people||[]);paint();}
 function preference(data){enabled=Boolean(data.enabled);ready=true;setting.checked=enabled;setting.disabled=false;if(!enabled)stop();}
 async function connect(){const id=++generation;stop();ready=false;states.clear();paint();setting.disabled=true;try{const data=await call('typing-preference');if(id===generation)preference(data);}catch{setting.disabled=false;}await snapshot();}
 setting.onchange=async()=>{const value=setting.checked;setting.disabled=true;if(!value){enabled=false;stop();}try{preference(await call('typing-preference',{enabled:value}));feedback.textContent=value?'Your typing activity is visible.':'Your typing activity is hidden.';}catch{setting.checked=enabled;feedback.textContent='Could not save this setting. Try again.';}finally{setting.disabled=false;}};
 for(const id of ['draft','code-draft'])document.getElementById(id).addEventListener('input',activity);
 document.getElementById('composer').addEventListener('submit',stop,true);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else void snapshot();});window.addEventListener('blur',stop);
 window.addEventListener('pagehide',()=>{if(sent)void apiFetch('conversations/'+sent.conversationId+'/typing',{method:'POST',headers:{'Content-Type':'application/json','X-Horizon-Chat':'1'},body:JSON.stringify({active:false,postId:sent.postId}),keepalive:true}).catch(()=>{});});
 setInterval(()=>{for(const [k,people] of states)if(!people.some(p=>p.expires>Date.now()))states.delete(k);paint();},1000);
 return {connect,receive,preference,paint,stop,refresh:snapshot,changed(){stop();paint();void snapshot();},reset(){generation++;stop();ready=false;states.clear();paint();}};
}
