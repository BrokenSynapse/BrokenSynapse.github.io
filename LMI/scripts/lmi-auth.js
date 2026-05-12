
(function(){
  function norm(v){return String(v||'').trim().toLowerCase().replace(/[\s_\-.]+/g,'');}
  function parseLoginRows(rows){
    rows=(rows||[]).map(r=>Array.isArray(r)?r:[r]).filter(r=>r.some(c=>String(c??'').trim()!==''));
    if(!rows.length) return [];
    function fieldRow(labels){const wanted=labels.map(norm); for(let r=0;r<rows.length;r++){if(wanted.includes(norm(rows[r][0]))) return r;} return -1;}
    function cell(r,c){return r<0?'':String((rows[r]||[])[c]??'').trim();}
    const usernameRow=fieldRow(['Username','User Name','Username or ID','Login','Login ID','Employee Tag','Tag']);
    const passwordRow=fieldRow(['Password','Pass','Hash']);
    const idRow=fieldRow(['ID','User ID','Operator ID','Employee ID']);
    const accessRow=fieldRow(['Access','Role','Permission','Clearance']);
    const themeRow=fieldRow(['Theme']);
    const wallpaperRow=fieldRow(['Wallpaper','Background','Desktop Wallpaper']);
    const avatarRow=fieldRow(['Avatar','Profile Image','Icon']);
    const flagsRow=fieldRow(['Extra2','Extra 2','Flags','Permissions','Modules','Notes','Installed Apps']);
    if(usernameRow>=0 && passwordRow>=0){
      const out=[]; const max=Math.max(...rows.map(r=>r.length));
      for(let c=1;c<max;c++){
        const username=cell(usernameRow,c), id=cell(idRow,c);
        if(!username && !id) continue;
        out.push({username,password:cell(passwordRow,c),id,access:cell(accessRow,c)||'User',theme:cell(themeRow,c)||'Default',wallpaper:cell(wallpaperRow,c),avatar:cell(avatarRow,c),flags:cell(flagsRow,c),aliases:[username,id].filter(Boolean)});
      }
      return out;
    }
    const header=(rows[0]||[]).map(String); const data=rows.slice(1);
    function read(row,names){for(const n of names){const i=header.findIndex(h=>norm(h)===norm(n)); if(i>=0) return String(row[i]??'').trim();} return '';}
    return data.map(r=>({username:read(r,['Username','Employee Tag','Tag'])||String(r[0]??'').trim(),password:read(r,['Password','Hash'])||String(r[1]??'').trim(),id:read(r,['ID','User ID','Operator ID'])||String(r[2]??'').trim(),access:read(r,['Access','Role','Permission'])||String(r[3]??'User').trim(),theme:read(r,['Theme'])||'Default',wallpaper:read(r,['Wallpaper']),avatar:read(r,['Avatar']),flags:read(r,['Extra2','Flags','Permissions','Modules','Installed Apps']),aliases:[] })).filter(u=>u.username||u.id);
  }
  function matchUser(users, tag, hash){
    tag=String(tag||'').trim().toLowerCase(); hash=String(hash||'').trim();
    return (users||[]).find(u=>{
      const aliases=[u.username,u.id,...(u.aliases||[])].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean);
      return aliases.includes(tag) && String(u.password||'').trim()===hash;
    }) || null;
  }
  async function login(tag, hash){
    const url=localStorage.getItem('lmi_login_url') || window.LMI_CONFIG.defaultLoginUrl;
    const rows=await window.LMI_API.gvizRows(url,{gid:0});
    const users=parseLoginRows(rows);
    const user=matchUser(users, tag, hash);
    if(!user) throw new Error('Credential rejected. Tag/hash was not found in the login sheet.');
    user.loginAt=new Date().toISOString();
    sessionStorage.setItem('lmi_user', JSON.stringify(user));
    window.LMI_USER=user;
    return user;
  }
  function logout(){sessionStorage.removeItem('lmi_user'); window.LMI_USER=null; location.reload();}
  function currentUser(){ if(window.LMI_USER) return window.LMI_USER; try{return JSON.parse(sessionStorage.getItem('lmi_user')||'null')}catch{return null} }
  window.LMI_AUTH={parseLoginRows,login,logout,currentUser};
})();
