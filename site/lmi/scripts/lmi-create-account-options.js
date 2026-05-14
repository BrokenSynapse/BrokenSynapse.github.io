(function(){
  if(window.__LMI_CREATE_ACCOUNT_OPTIONS__) return;
  window.__LMI_CREATE_ACCOUNT_OPTIONS__ = true;

  const FALLBACK_OCCUPATIONS = [
    'Archivist',
    'LMC CEO',
    'LMC Delta',
    'Musician',
    'OnlyFans',
    'Unemployed'
  ];

  const FALLBACK_CURRENCIES = [
    'CRED',
    'LSD',
    'USD'
  ];

  function $(id){ return document.getElementById(id); }

  function escapeHtml(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      '"':'&quot;',
      "'":'&#39;'
    }[c]));
  }

  function setOptions(sel, values, placeholder){
    if(!sel) return;

    const clean = Array.from(new Set(
      (values || [])
        .map(x => String(x || '').trim())
        .filter(Boolean)
    )).sort((a,b)=>a.localeCompare(b));

    const old = sel.value;

    sel.innerHTML =
      `<option value="">${escapeHtml(placeholder)}</option>` +
      clean.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');

    if(old && clean.includes(old)) sel.value = old;
    else if(clean.length && !sel.required) sel.value = clean[0];
  }

  async function loadOptions(){
    const occ = $('occupation');
    if(!occ) return;

    occ.required = true;

    try{
      const res = await fetch('/api/relay', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'listAccountOptions',
          payload:{},
          user:{}
        })
      });

      const data = await res.json();

      if(!data || !data.ok){
        throw new Error(data?.error || 'Could not load account options.');
      }

      const opts = data.data || {};

      setOptions(occ, opts.occupations?.length ? opts.occupations : FALLBACK_OCCUPATIONS, 'Select occupation...');

      if($('currency')){
        const cur = $('currency');
        if(cur.tagName === 'SELECT'){
          const oldCur = cur.value || 'USD';
          setOptions(cur, opts.currencies?.length ? opts.currencies : FALLBACK_CURRENCIES, 'Select currency...');
          if([...cur.options].some(o => o.value === oldCur)) cur.value = oldCur;
          else if([...cur.options].some(o => o.value === 'USD')) cur.value = 'USD';
        }
      }

      if($('access') && opts.accessLevels?.length){
        const access = $('access');
        const current = access.value || 'User';
        setOptions(access, opts.accessLevels, 'Select access...');
        if([...access.options].some(o => o.value === current)) access.value = current;
      }

      if($('status') && opts.statuses?.length){
        const status = $('status');
        const current = status.value || 'Active';
        setOptions(status, opts.statuses, 'Select status...');
        if([...status.options].some(o => o.value === current)) status.value = current;
      }

      const statusLine = $('statusLine');
      if(statusLine && /loading occupations/i.test(statusLine.textContent || '')){
        statusLine.textContent = '';
      }

      try{
        if(typeof updatePreview === 'function') updatePreview();
      }catch{}
    }catch(e){
      setOptions(occ, FALLBACK_OCCUPATIONS, 'Select occupation...');
      if($('currency') && $('currency').tagName === 'SELECT'){
        setOptions($('currency'), FALLBACK_CURRENCIES, 'Select currency...');
        if([...$('currency').options].some(o => o.value === 'USD')) $('currency').value = 'USD';
      }
      const statusLine = $('statusLine');
      if(statusLine){
        statusLine.textContent = e.message || String(e);
        statusLine.className = 'status danger';
      }
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', loadOptions);
  }else{
    loadOptions();
  }

  setTimeout(loadOptions, 400);
})();
