(function(){
  if(window.__FE_CONTEXT_FIX__) return;
  window.__FE_CONTEXT_FIX__ = true;

  let lastContextItem = null;

  function setFEStatus(msg, cls=''){
    if(typeof setStatus === 'function'){
      setStatus(msg, cls);
      return;
    }
    const el=document.getElementById('status');
    if(el)el.textContent=msg||'Ready.';
  }

  function cleanSlash(s){
    return String(s||'').replace(/\\/g,'/').replace(/\/+/g,'/');
  }

  function basename(path){
    return cleanSlash(path).split('/').filter(Boolean).pop() || path;
  }

  function getItemFromElement(el){
    const row = el?.closest?.('.item');
    if(!row || row.dataset.path === '__pending_new_folder__') return null;

    return {
      kind: row.dataset.kind || 'file',
      path: row.dataset.path || '',
      name: basename(row.dataset.path || '')
    };
  }

  function rememberContextTarget(e){
    const item = getItemFromElement(e.target);
    if(item && item.path){
      lastContextItem = item;
    }else{
      lastContextItem = null;
    }
  }

  async function apiPostSafe(url, payload){
    const res = await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload||{})
    });
    const data = await res.json().catch(()=>({ok:false,error:'Bad JSON'}));
    if(!data.ok) throw new Error(data.error || 'Operation failed.');
    return data;
  }

  async function confirmDelete(item){
    const label = item.kind === 'dir' ? 'folder' : 'file';
    const shown = item.path;

    if(typeof showModal === 'function'){
      const yes = await showModal(
        'Confirm Delete',
        `<p>Delete this ${label}?</p><p><b>${shown}</b></p><p>This cannot be undone from inside LMI.</p>`,
        'Delete'
      );
      return !!yes;
    }

    return confirm(`Delete this ${label}?\n\n${shown}`);
  }

  async function deleteRememberedTarget(){
    const item = lastContextItem || getItemFromElement(document.activeElement);

    if(!item || !item.path){
      setFEStatus('Right-click or select something first.', 'bad');
      return;
    }

    const yes = await confirmDelete(item);
    if(!yes)return;

    setFEStatus('Deleting...');
    await apiPostSafe('/api/files/delete',{path:item.path});

    lastContextItem = null;

    if(typeof clearSelection === 'function') clearSelection();
    if(typeof loadFiles === 'function') await loadFiles();

    setFEStatus('Deleted '+item.path, 'good');
  }

  // Remember what was right-clicked before any menu/deselect logic runs.
  document.addEventListener('contextmenu', e=>{
    if(!e.target.closest?.('.fe-shell'))return;
    rememberContextTarget(e);
  }, true);

  // Prevent clicks inside the context menu from being treated like blank-space clicks.
  document.addEventListener('pointerdown', e=>{
    if(e.target.closest?.('#ctxMenu')){
      e.stopPropagation();
    }
  }, true);

  // Override only Delete. Leave the other context actions alone.
  document.addEventListener('click', e=>{
    const btn = e.target.closest?.('#ctxMenu [data-act="delete"]');
    if(!btn)return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if(typeof hideContextMenu === 'function') hideContextMenu();
    else document.getElementById('ctxMenu')?.classList.remove('open');

    deleteRememberedTarget().catch(err=>{
      setFEStatus(err.message || String(err), 'bad');
    });
  }, true);
})();
