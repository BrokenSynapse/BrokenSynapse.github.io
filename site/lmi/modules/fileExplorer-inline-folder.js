(function(){
  if(window.__FE_INLINE_FOLDER_PATCH_V3__) return;
  window.__FE_INLINE_FOLDER_PATCH_V3__ = true;

  const ROOT = '/lmi/assets';
  const DRIVE = 'LMC:';

  let pendingRow = null;
  let committing = false;
  let patchedMenu = false;

  function cleanSlash(s){
    return String(s || '').replace(/\\/g,'/').replace(/\/+/g,'/');
  }

  function normalizeDir(p){
    p = cleanSlash(p || '').trim();
    if(/^lmc:/i.test(p)) p = p.replace(/^lmc:/i,'');
    if(!p.startsWith('/')) p = ROOT + '/' + p;
    if(p === '/') p = ROOT;
    if(!p.startsWith(ROOT)) p = ROOT;
    p = p.replace(/\/$/,'');
    return p || ROOT;
  }

  function currentVisibleDir(){
    const addr = document.getElementById('address')?.value || '';
    const bottom = document.getElementById('currentPath')?.textContent || '';
    return normalizeDir(addr || bottom || ROOT);
  }

  function relDir(p){
    p = normalizeDir(p);
    return p === ROOT ? '' : p.slice(ROOT.length).replace(/^\//,'');
  }

  function setFEStatus(msg, cls=''){
    if(typeof setStatus === 'function'){
      setStatus(msg, cls);
      return;
    }
    const el = document.getElementById('status');
    if(el) el.textContent = msg || 'Ready.';
  }

  function hideMenu(){
    try{
      if(typeof hideContextMenu === 'function') hideContextMenu();
      else document.getElementById('ctxMenu')?.classList.remove('open');
    }catch{}
  }

  function injectStyle(){
    if(document.getElementById('fe-inline-folder-style')) return;

    const st = document.createElement('style');
    st.id = 'fe-inline-folder-style';
    st.textContent = `
      .item.pending-create{
        border-color:var(--line)!important;
        background:rgba(164,92,255,.16)!important;
        box-shadow:0 0 18px rgba(164,92,255,.22)!important;
      }
      .inline-name-input{
        width:100%;
        min-width:90px;
        border:1px solid var(--line);
        background:#050209;
        color:#fff;
        padding:4px 6px;
        font-family:inherit;
        font-weight:800;
        outline:none;
        box-shadow:0 0 12px rgba(164,92,255,.28);
      }
      .grid .inline-name-input{
        text-align:center;
        font-size:12px;
      }
    `;
    document.head.appendChild(st);
  }

  function sanitizeName(name){
    return String(name || '')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function existingFolderNames(){
    const names = new Set();

    document.querySelectorAll('.item[data-kind="dir"]').forEach(el=>{
      const txt = el.querySelector('.filename')?.textContent?.trim();
      if(txt) names.add(txt.toLowerCase());
    });

    return names;
  }

  function uniqueFolderName(base='New Folder'){
    const existing = existingFolderNames();
    if(!existing.has(base.toLowerCase())) return base;

    for(let i=2;i<999;i++){
      const n = `${base} (${i})`;
      if(!existing.has(n.toLowerCase())) return n;
    }

    return base + ' ' + Date.now();
  }

  function removePending(){
    if(pendingRow && pendingRow.isConnected) pendingRow.remove();
    pendingRow = null;
    committing = false;
  }

  function makePendingRow(name){
    const row = document.createElement('div');
    row.className = 'item pending-create';
    row.dataset.kind = 'pending-dir';
    row.dataset.path = '__pending_new_folder__';

    row.innerHTML = `
      <div class="namecell">
        <div class="ico">📁</div>
        <div>
          <input class="inline-name-input" id="newFolderNameInput" value="${name.replace(/"/g,'&quot;')}" spellcheck="false">
          <div class="pathline">New folder</div>
        </div>
      </div>
      <div class="extra">Folder</div>
      <div class="extra">—</div>
      <div class="extra">new</div>
    `;

    return row;
  }

  async function apiPostSafe(url, payload){
    const res = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload || {})
    });

    const data = await res.json().catch(()=>({ok:false,error:'Bad JSON'}));
    if(!data.ok) throw new Error(data.error || 'Operation failed.');
    return data;
  }

  async function commitPending(){
    if(!pendingRow || committing) return;
    committing = true;

    const input = pendingRow.querySelector('.inline-name-input');
    const name = sanitizeName(input?.value);

    if(!name){
      committing = false;
      input?.focus();
      input?.select();
      setFEStatus('Folder name cannot be blank.', 'bad');
      return;
    }

    const dir = currentVisibleDir();

    // Important:
    // currentVisibleDir() may be displayed as LMC:/lmi/assets in the UI,
    // but mkdir wants a real jailed web path or relative path.
    // Build the final path explicitly as /assets/<typed name>.
    const destWebPath = cleanSlash(dir + '/' + name);

    if(destWebPath === ROOT || destWebPath === ROOT + '/'){
      committing = false;
      setFEStatus('Cannot create /lmi/assets root.', 'bad');
      return;
    }

    try{
      setFEStatus('Creating folder...');
      await apiPostSafe('/api/files/mkdir', { path: destWebPath });

      removePending();

      if(typeof loadFiles === 'function') await loadFiles();

      setTimeout(()=>{
        const el = document.querySelector(`.item[data-path="${CSS.escape(destWebPath)}"]`);
        if(el){
          document.querySelectorAll('.item').forEach(x=>x.classList.remove('selected'));
          el.classList.add('selected');
        }
      }, 80);

      setFEStatus('Created ' + DRIVE + destWebPath, 'good');
    }catch(e){
      committing = false;
      setFEStatus(e.message || String(e), 'bad');
      input?.focus();
      input?.select();
    }
  }

  function cancelPending(){
    removePending();
    setFEStatus('New folder cancelled.');
  }

  function beginInlineNewFolder(){
    injectStyle();
    hideMenu();
    removePending();

    if(typeof clearSelection === 'function') clearSelection();
    else document.querySelectorAll('.item').forEach(x=>x.classList.remove('selected'));

    const filesEl = document.getElementById('files');
    if(!filesEl){
      setFEStatus('File pane not ready.', 'bad');
      return;
    }

    const empty = filesEl.querySelector('.empty');
    if(empty) empty.remove();

    pendingRow = makePendingRow(uniqueFolderName('New Folder'));
    filesEl.prepend(pendingRow);

    const input = pendingRow.querySelector('.inline-name-input');

    input.addEventListener('click', e=>e.stopPropagation());
    input.addEventListener('pointerdown', e=>e.stopPropagation());

    input.addEventListener('keydown', e=>{
      if(e.key === 'Enter'){
        e.preventDefault();
        commitPending();
      }

      if(e.key === 'Escape'){
        e.preventDefault();
        cancelPending();
      }
    });

    input.addEventListener('blur', ()=>{
      setTimeout(()=>{
        if(pendingRow) commitPending();
      }, 120);
    });

    setTimeout(()=>{
      input.focus();
      input.select();
    }, 30);
  }

  function runOldAction(act){
    hideMenu();

    if(act === 'newFolder'){
      beginInlineNewFolder();
      return;
    }

    if(typeof runContextAction === 'function'){
      runContextAction(act);
      return;
    }

    setFEStatus('Context action unavailable: ' + act, 'bad');
  }

  function patchContextMenuButtons(){
    const menu = document.getElementById('ctxMenu');
    if(!menu || patchedMenu) return;

    patchedMenu = true;

    menu.querySelectorAll('[data-act]').forEach(oldBtn=>{
      const btn = oldBtn.cloneNode(true);
      oldBtn.replaceWith(btn);

      btn.addEventListener('click', e=>{
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const act = btn.dataset.act;
        runOldAction(act);
      });
    });
  }

  document.addEventListener('pointerdown', e=>{
    if(!pendingRow) return;
    if(e.target.closest?.('.pending-create')) return;
    if(e.target.closest?.('#ctxMenu')) return;
    if(e.target.closest?.('.modal-backdrop')) return;

    const insideFilePane = e.target.closest?.('#files');
    if(insideFilePane){
      setTimeout(commitPending, 0);
    }
  }, true);

  document.addEventListener('keydown', e=>{
    if(e.key === 'Escape' && pendingRow){
      e.preventDefault();
      cancelPending();
    }
  }, true);

  document.addEventListener('DOMContentLoaded',()=>{
    injectStyle();
    patchContextMenuButtons();
  });

  setTimeout(()=>{
    injectStyle();
    patchContextMenuButtons();
  }, 100);

  setTimeout(patchContextMenuButtons, 500);
  setTimeout(patchContextMenuButtons, 1200);

  window.FE_beginInlineNewFolder = beginInlineNewFolder;
})();
