
(function(){
  function extractSheetId(url){ const m=String(url||'').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/); return m?m[1]:''; }
  function gvizRows(url, opts={}){
    const id=extractSheetId(url); if(!id) return Promise.reject(new Error('No Google Sheet ID found in URL.'));
    const cb='LMI_GVIZ_'+Date.now()+'_'+Math.floor(Math.random()*999999);
    const gid=opts.gid==null?'0':String(opts.gid);
    const sheet=opts.sheet;
    const selector=sheet ? `sheet=${encodeURIComponent(sheet)}` : `gid=${encodeURIComponent(gid)}`;
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      const timer=setTimeout(()=>{cleanup(); reject(new Error('Credential sheet timed out. Make sure the sheet is shared/published.'));},15000);
      function cleanup(){clearTimeout(timer); delete window[cb]; s.remove();}
      window[cb]=(data)=>{try{cleanup(); const rows=(data.table.rows||[]).map(r=>(r.c||[]).map(c=>c && c.v!=null ? c.v : '')); resolve(rows);}catch(e){reject(e)}};
      s.onerror=()=>{cleanup(); reject(new Error('Google Sheet request failed.'))};
      s.src=`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?${selector}&headers=0&tqx=out:json;responseHandler:${cb}&_=${Date.now()}`;
      document.body.appendChild(s);
    });
  }
  async function appsScript(url, payload){
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload||{})});
    const txt=await res.text(); let data;
    try{data=JSON.parse(txt)}catch{throw new Error('Apps Script did not return JSON: '+txt.slice(0,180));}
    if(data && data.ok===false) throw new Error(data.error||'Apps Script rejected request.');
    return data;
  }
  window.LMI_API={extractSheetId,gvizRows,appsScript};
})();
