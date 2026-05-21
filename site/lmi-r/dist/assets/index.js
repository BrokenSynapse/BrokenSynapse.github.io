const Op={MSG_REQUEST:201,MSG_RESPONSE:202,STATE_GET:300,STATE_SET:301,APP_ACTION:700,EVENT_PUBLISH:800,DEBUG_PING:900};
const modules=[
  {id:"settings",name:"Settings.LMX",phase:"stub",capabilities:["state:read","state:write","user:read","user:write","asset:read"]},
  {id:"sift",name:"Sift.LMX",phase:"stub",capabilities:["asset:read","asset:write","entity:read","entity:write","event:publish"]},
  {id:"fleetline",name:"Fleetline.LMX",phase:"compat-planned",capabilities:["entity:read","asset:read","app:open","event:subscribe"]},
  {id:"dataforge",name:"DataForge.LMX",phase:"compat-planned",capabilities:["debug:read","entity:read","entity:write","state:read","state:write"]}
];
const root=document.querySelector("#app");
const state={status:null,statusText:"Checking Rust backend...",settingsValue:"loading",fleetlineAsset:null,siftNote:"No asset published yet.",debug:null,recentPackets:[],topics:new Map(),values:new Map()};
function packet(moduleId,op,payload,target={kind:"shell",id:"runtime"},scope="session"){return{id:crypto.randomUUID(),op,source:{kind:"module",id:moduleId},target,scope,flags:0,ts:Date.now(),payload}}
async function postPacket(p){record(p);const r=await fetch("/api-r/packet",{method:"POST",headers:{Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(p),cache:"no-store"});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||`packet failed ${r.status}`);record(body);return body}
function record(p){state.recentPackets.push(p);if(state.recentPackets.length>40)state.recentPackets.shift()}
function debugView(){return{registeredModules:modules.map(({id,name,capabilities})=>({id,name,capabilities})),recentPackets:state.recentPackets.slice(-20),knownTopics:[...state.topics.keys()].sort(),pendingRequestCount:0,stateKeys:[...state.values.keys()].sort()}}
function publish(moduleId,topic,payload){const p=packet(moduleId,Op.EVENT_PUBLISH,{topic,payload},undefined,"broadcast");record(p);(state.topics.get(topic)||[]).forEach(fn=>fn(payload,p))}
function subscribe(topic,fn){const list=state.topics.get(topic)||[];list.push(fn);state.topics.set(topic,list)}
async function setState(moduleId,key,value,{persist=false,scope="user"}={}){const p=packet(moduleId,Op.STATE_SET,{key,value,scope},persist?{kind:"server",id:"api-r"}:{kind:"shell",id:"runtime"},persist?"server":scope);state.values.set(key,value);record(p);if(persist)await postPacket(p)}
async function getState(moduleId,key,scope="user"){if(state.values.has(key))return state.values.get(key);const p=packet(moduleId,Op.STATE_GET,{key,scope},{kind:"server",id:"api-r"},"server");const response=await postPacket(p);const value=response.payload?.value;if(value!==undefined&&value!==null)state.values.set(key,value);return value??undefined}
function render(){
  const moduleTiles=modules.map(mod=>`<button class="module-tile" type="button" data-module="${mod.id}"><span>${mod.name}</span><small>${mod.phase}</small></button>`).join("");
  root.innerHTML=`<main class="desktop" data-theme="lmi-r-dark">
    <section class="topbar"><div><p class="eyebrow">Leviathan Mainframe Interface</p><h1>LMI-R</h1></div><div class="session"><span>local-operator</span><strong>placeholder</strong></div></section>
    <section class="workspace"><aside class="dock" aria-label="Module registry">${moduleTiles}</aside><section class="panel">
      <div class="panel-head"><div><p class="eyebrow">Rewrite vertical slice</p><h2>LMI Bus Shell</h2></div><span class="pill">0 windows</span></div>
      <div class="status-grid">
        <article><span>Backend</span><strong>${esc(state.statusText)}</strong></article>
        <article><span>Service</span><strong>${esc(state.status?.service??"pending")}</strong></article>
        <article><span>API Prefix</span><strong>${esc(state.status?.api_prefix??"/api-r")}</strong></article>
        <article><span>Database</span><strong>${esc(state.status?.database??"data/lmi-r.sqlite")}</strong></article>
      </div>
      <div class="window-preview"><h3>Unified Transfer Layer</h3><p>Every stub below uses ModuleContext/LMI Bus semantics: state, requests, pub/sub, and server persistence all move as packets.</p></div>
      <div class="module-grid">
        <article class="module-card"><h3>Settings.LMX</h3><p>Persists one shell preference through ctx.setState().</p><strong>${esc(state.settingsValue)}</strong><button data-action="settings-save">Persist demo value</button></article>
        <article class="module-card"><h3>Sift.LMX</h3><p>Publishes a fake asset:selected event through the bus.</p><strong>${esc(state.siftNote)}</strong><button data-action="sift-publish">Publish asset:selected</button></article>
        <article class="module-card"><h3>Fleetline.LMX</h3><p>Subscribes to asset:selected without importing Sift.</p><strong>${state.fleetlineAsset?`${esc(state.fleetlineAsset.id)} (${esc(state.fleetlineAsset.mime||"asset")})`:"Waiting for asset event."}</strong></article>
        <article class="module-card wide"><h3>DataForge.LMX</h3><p>Requests bus debug through ctx.callAction().</p><button data-action="dataforge-debug">Refresh bus debug</button><pre>${esc(JSON.stringify(state.debug??{status:"No debug snapshot yet."},null,2))}</pre></article>
      </div>
    </section></section></main>`;
  wire();
}
function wire(){
  root.querySelector('[data-action="settings-save"]')?.addEventListener("click",()=>setState("settings","settings.demo.message",`Saved at ${new Date().toLocaleTimeString()}`,{persist:true,scope:"user"}).then(()=>getState("settings","settings.demo.message")).then(v=>{state.settingsValue=v||"Saved.";render()}));
  root.querySelector('[data-action="sift-publish"]')?.addEventListener("click",()=>{const asset={ref:"asset:demo-fleetline-preview",kind:"asset",id:"demo-fleetline-preview",mime:"image/png",size:4096};publish("sift","asset:selected",asset);state.siftNote=`Published ${asset.id}`;render()});
  root.querySelector('[data-action="dataforge-debug"]')?.addEventListener("click",()=>{const p=packet("dataforge",Op.APP_ACTION,{action:"debug.bus"});record(p);state.debug=debugView();render()});
}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function boot(){
  if(!root)throw new Error("LMI-R root element missing.");
  subscribe("asset:selected",(asset)=>{state.fleetlineAsset=asset;render()});
  render();
  try{
    const response=await fetch("/api-r/status",{headers:{Accept:"application/json"},cache:"no-store"});
    const body=await response.json();
    if(!response.ok)throw new Error(body.error||`API request failed: ${response.status}`);
    state.status=body;state.statusText="Rust backend online";
    state.settingsValue=await getState("settings","settings.demo.message")||"No persisted value yet.";
  }catch(error){state.statusText=`Rust backend unavailable: ${String(error)}`}
  render();
}
boot();
