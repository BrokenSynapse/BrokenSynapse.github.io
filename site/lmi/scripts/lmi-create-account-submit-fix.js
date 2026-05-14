(function(){
  if(window.__LMI_CREATE_ACCOUNT_SUBMIT_FIX__) return;
  window.__LMI_CREATE_ACCOUNT_SUBMIT_FIX__ = true;

  const $ = id => document.getElementById(id);

  function cleanTag(v){
    return String(v || '')
      .trim()
      .replace(/\s+/g,'_')
      .replace(/[^A-Za-z0-9_-]/g,'')
      .toUpperCase();
  }

  function cleanPath(v){
    v = String(v || '').trim().replace(/\\/g,'/').replace(/^LMC:\s*/i,'');
    if(!v) return '';
    if(v.startsWith('/assets/')) v = '/lmi' + v;
    if(!v.startsWith('/')){
      v = '/lmi/assets/' + v.replace(/^lmi\/assets\//,'').replace(/^assets\//,'');
    }
    return v.replace(/\/+/g,'/');
  }

  function setStatus(msg, good=false){
    const el = $('statusLine');
    if(!el){
      alert(msg);
      return;
    }
    el.textContent = msg || '';
    el.className = 'status ' + (good ? 'good' : msg ? 'danger' : '');
  }

  function getPayload(){
    return {
      tag: cleanTag($('tag')?.value),
      hash: $('hash')?.value || '',
      displayName: ($('displayName')?.value || '').trim(),
      access: $('access')?.value || 'User',
      status: $('status')?.value || 'Active',
      occupation: $('occupation')?.value || '',
      currency: $('currency')?.value || '',
      balance: Number($('balance')?.value || 0),
      bankAccountId: ($('bankAccountId')?.value || '').trim(),
      avatar: cleanPath($('avatar')?.value || ''),
      wallpaper: cleanPath($('wallpaper')?.value || '')
    };
  }

  async function submitCreateAccount(ev){
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    const payload = getPayload();

    if(!payload.tag || !payload.hash || !payload.displayName || !payload.bankAccountId || !payload.occupation || !payload.currency){
      setStatus('Tag, hash, display name, occupation, currency, and bank account ID are required.');
      return false;
    }

    setStatus('Creating account...');

    try{
      const res = await fetch('/api/relay', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'createAccount',
          payload,
          user:{}
        })
      });

      const text = await res.text();
      let data;
      try{ data = JSON.parse(text); }
      catch{
        throw new Error('Bad server response: ' + text.slice(0, 200));
      }

      if(!data.ok){
        throw new Error(data.error || 'Account creation failed.');
      }

      setStatus('Created account: ' + payload.tag + '. Return to login and sign in.', true);

      const pLogin = $('pLogin');
      if(pLogin) pLogin.textContent = 'Ready: ' + payload.tag + ' / supplied hash';

      console.log('Created account:', data);
      return false;
    }catch(e){
      console.error(e);
      setStatus(e.message || String(e));
      return false;
    }
  }

  function hook(){
    const form = $('createForm');
    if(!form) return;

    form.addEventListener('submit', submitCreateAccount, true);

    const btns = Array.from(document.querySelectorAll('button'));
    const createBtn = btns.find(b => /create account/i.test(b.textContent || ''));
    if(createBtn){
      createBtn.type = 'button';
      createBtn.addEventListener('click', submitCreateAccount, true);
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();

  setTimeout(hook, 400);
})();
