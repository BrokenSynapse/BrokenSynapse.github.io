(function(){
  if(window.__LMI_CREATE_ACCOUNT_LINK__) return;
  window.__LMI_CREATE_ACCOUNT_LINK__ = true;

  function isLoginShell(){
    const txt = (document.body && document.body.innerText || '').toLowerCase();
    return !!(
      document.querySelector('input[type="password"]') &&
      (
        txt.includes('submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash')
      )
    );
  }

  function addLink(){
    if(!isLoginShell()) return;
    if(document.getElementById('lmiCreateAccountLink')) return;

    const a = document.createElement('a');
    a.id = 'lmiCreateAccountLink';
    a.href = '/lmi/create-account.html';
    a.textContent = 'Create Account';
    a.style.display = 'inline-block';
    a.style.marginLeft = '10px';
    a.style.padding = '11px 14px';
    a.style.border = '1px solid #9b55ff';
    a.style.background = '#10031c';
    a.style.color = '#fff';
    a.style.textDecoration = 'none';
    a.style.fontFamily = 'inherit';
    a.style.fontWeight = '900';
    a.style.boxShadow = '0 0 16px rgba(164,92,255,.22)';

    const submit =
      Array.from(document.querySelectorAll('button,input[type="submit"],a'))
        .find(el => /submit tag|login|submit/i.test(el.textContent || el.value || ''));

    if(submit && submit.parentElement){
      submit.insertAdjacentElement('afterend', a);
    }else{
      document.body.appendChild(a);
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', addLink);
  }else{
    addLink();
  }

  setTimeout(addLink, 300);
  setTimeout(addLink, 1000);
})();
