import { createHash } from 'node:crypto';
export function createCharacterVariants(db, media) {
  db.exec(`CREATE TABLE IF NOT EXISTS character_profiles(proxy_id INTEGER PRIMARY KEY REFERENCES proxies(id), body_url TEXT NOT NULL DEFAULT '', active_variant INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS character_variants(id INTEGER PRIMARY KEY, proxy_id INTEGER NOT NULL REFERENCES proxies(id), name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '', banner_url TEXT NOT NULL DEFAULT '', body_url TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS character_looks(id INTEGER PRIMARY KEY,proxy_id INTEGER NOT NULL REFERENCES proxies(id),variant_id INTEGER NOT NULL,signature TEXT NOT NULL,profile TEXT NOT NULL,UNIQUE(proxy_id,variant_id,signature));
    CREATE TABLE IF NOT EXISTS account_personas(account_id INTEGER PRIMARY KEY REFERENCES accounts(id),proxy_id INTEGER NOT NULL REFERENCES proxies(id),variant_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS message_character_looks(message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,look_id INTEGER NOT NULL REFERENCES character_looks(id));`);
  if(!db.prepare("SELECT 1 FROM pragma_table_info('character_variants') WHERE name='designation'").get())db.exec("ALTER TABLE character_variants ADD COLUMN designation TEXT NOT NULL DEFAULT ''");
  if(!db.prepare("SELECT 1 FROM pragma_table_info('character_variants') WHERE name='status_text'").get())db.exec("ALTER TABLE character_variants ADD COLUMN status_text TEXT NOT NULL DEFAULT ''");
  for(const column of ['display_name','description','group_name','prefix','suffix'])if(!db.prepare("SELECT 1 FROM pragma_table_info('character_variants') WHERE name=?").get(column))db.exec(`ALTER TABLE character_variants ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  const config=db.prepare('SELECT body_url AS fullBodyUrl, active_variant AS activeVariant FROM character_profiles WHERE proxy_id=?');
  const variants=db.prepare('SELECT id,name,avatar_url AS avatarUrl,banner_url AS bannerUrl,body_url AS fullBodyUrl,designation AS designationOverride,status_text AS statusOverride,display_name AS nameOverride,description AS descriptionOverride,group_name AS groupOverride,prefix AS prefixOverride,suffix AS suffixOverride,avatar_url AS avatarOverride,banner_url AS bannerOverride,body_url AS fullBodyOverride FROM character_variants WHERE proxy_id=? ORDER BY id');
  const owned=db.prepare('SELECT 1 FROM proxies WHERE id=? AND account_id=? AND archived=0');
  const core=db.prepare(`SELECT p.id,p.name,p.group_name AS "group",p.prefix,p.suffix,p.description,p.status_text AS status,p.avatar_url AS avatarUrl,p.banner AS bannerUrl,coalesce(nullif(p.designation,''),a.public_tag) AS designation FROM proxies p JOIN accounts a ON a.id=p.account_id WHERE p.id=?`);
  const capture=db.prepare('INSERT INTO message_character_looks VALUES (?,?) ON CONFLICT(message_id) DO UPDATE SET look_id=excluded.look_id');
  const insertLook=db.prepare('INSERT OR IGNORE INTO character_looks(proxy_id,variant_id,signature,profile) VALUES (?,?,?,?)');
  const findLook=db.prepare('SELECT id,profile,signature FROM character_looks WHERE proxy_id=? AND variant_id=? ORDER BY id');
  function lookId(id,profile){
    const value=JSON.stringify(profile),signature=createHash('sha256').update(value).digest('hex');
    const records=findLook.all(id,profile.variantId);
    if(!records.length){insertLook.run(id,profile.variantId,signature,value);return findLook.get(id,profile.variantId).id;}
    const canonical=records[0].id;
    for(const duplicate of records.slice(1)){
      db.prepare('UPDATE message_character_looks SET look_id=? WHERE look_id=?').run(canonical,duplicate.id);
      db.prepare('DELETE FROM character_looks WHERE id=?').run(duplicate.id);
    }
    if(records[0].profile!==value||records[0].signature!==signature)db.prepare('UPDATE character_looks SET profile=?,signature=? WHERE id=?').run(value,signature,canonical);
    return canonical;
  }
  function sync(id){
    const person=core.get(id);if(!person)return;
    const current=decorate(person),versions=new Map(current.variants.map(v=>[v.id,v]));
    for(const old of db.prepare('SELECT variant_id,profile FROM character_looks WHERE proxy_id=?').all(id)){
      if(!versions.has(old.variant_id)){const profile=JSON.parse(old.profile);versions.set(old.variant_id,{id:old.variant_id,name:profile.variantName,displayName:profile.displayName,description:profile.bio,avatarUrl:profile.avatarUrl,bannerUrl:profile.bannerUrl,fullBodyUrl:profile.fullBodyUrl,designation:profile.designation,status:profile.status});}
    }
    for(const variant of versions.values())lookId(id,{displayName:variant.displayName||person.baseName||person.name,avatarUrl:variant.avatarUrl,bannerUrl:variant.bannerUrl,fullBodyUrl:variant.fullBodyUrl,bio:variant.description??person.baseDescription??person.description,status:variant.status??person.status,designation:variant.designation||person.designation,variantId:variant.id,variantName:variant.name});
  }

  function decorate(person) {
    if(!person)return null;
    const state=config.get(person.id)||{};
    const main={id:0,name:'Main',displayName:person.name,description:person.description,group:person.group,prefix:person.prefix,suffix:person.suffix,avatarUrl:person.avatarUrl,bannerUrl:person.bannerUrl,fullBodyUrl:state.fullBodyUrl||'',designation:person.designation,status:person.status};
    const list=[main,...variants.all(person.id).map(v=>{const item={...v};for(const key of ['description','group','prefix','suffix','designation','status'])item[key]=v[key+'Override']||main[key];item.displayName=v.nameOverride||main.displayName;for(const [key,raw] of [['avatarUrl','avatarOverride'],['bannerUrl','bannerOverride'],['fullBodyUrl','fullBodyOverride']])item[key]=v[raw]||main[key];return item;})];
    const active=list.find(v=>v.id===state.activeVariant)||main;
    const result={...person,variants:list,variantId:active.id,variantName:active.name};
    for(const key of ['name','description','group','prefix','suffix','status','designation','avatarUrl','bannerUrl','fullBodyUrl']){result['base'+key[0].toUpperCase()+key.slice(1)]=key==='name'?main.displayName:main[key];result[key]=key==='name'?active.displayName:active[key];}
    return result;
  }
  function appearance(account,id,variantId) {
    if(!owned.get(id,account))return {error:'That character is unavailable.'};
    const person=decorate(core.get(id));
    const variant=variantId===undefined?person.variants.find(v=>v.id===person.variantId):person.variants.find(v=>v.id===variantId);
    if(!variant)return {error:'That variant is unavailable.'};
    return {displayName:variant.displayName||person.baseName||person.name,avatarUrl:variant.avatarUrl,bannerUrl:variant.bannerUrl,fullBodyUrl:variant.fullBodyUrl,bio:variant.description??person.baseDescription??person.description,status:variant.status??person.status,designation:variant.designation||person.designation,variantId:variant.id,variantName:variant.name};
  }
  // One live appearance per core/variant. Legacy posts reference Main; changing
  // the active variant never retargets a message's existing reference.
  for(const person of db.prepare('SELECT id FROM proxies').all()){
    sync(person.id);
    const main=findLook.get(person.id,0);
    if(main)db.prepare('INSERT OR IGNORE INTO message_character_looks SELECT id,? FROM direct_messages WHERE proxy_id=?').run(main.id,person.id);
  }
  return {
    decorate,
    sync,
    publicProfile:id=>decorate(core.get(id)),
    memberPersona(account){
      const selected=db.prepare('SELECT proxy_id,variant_id FROM account_personas WHERE account_id=?').get(account);if(!selected)return null;
      let profile=appearance(account,selected.proxy_id,selected.variant_id);if(profile.error)profile=appearance(account,selected.proxy_id,0);
      return profile.error?null:{...profile,proxyId:selected.proxy_id,senderId:account};
    },
    selectPersona(account,proxyId,variantId){
      if(proxyId===0){db.prepare('DELETE FROM account_personas WHERE account_id=?').run(account);return {};}
      const profile=appearance(account,proxyId,variantId);if(profile.error)return {status:400,error:profile.error};
      db.prepare('INSERT INTO account_personas VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET proxy_id=excluded.proxy_id,variant_id=excluded.variant_id').run(account,proxyId,profile.variantId);return {};
    },
    appearance,
    capture(message,account,id,profile) {if(!id)return;const live=appearance(account,id,profile?.variantId);const value=live.error?profile:live;if(value&&!value.error)capture.run(message,lookId(id,value));},
    change(account,id,action,data) {
      if(!owned.get(id,account))return {status:404,error:'Character not found.'};
      const person=decorate(core.get(id));
      if(action==='create') {
        if(typeof data?.name!=='string'||!data.name.trim()||data.name.length>60||person.variants.length>=33)return {status:400,error:'Name the variant (up to 60 characters, maximum 32 variants).'};
        if(person.variants.some(v=>v.name.toLocaleLowerCase()===data.name.trim().toLocaleLowerCase()))return {status:400,error:'Choose a different variant name.'};
        const source=person.variants.find(v=>v.id===(data.fromVariantId??0));if(!source)return {status:400,error:'Variant not found.'};
        const columns=['avatar_url','banner_url','body_url','designation','status_text','display_name','description','group_name','prefix','suffix'];
        const keys=['avatarOverride','bannerOverride','fullBodyOverride','designationOverride','statusOverride','nameOverride','descriptionOverride','groupOverride','prefixOverride','suffixOverride'];
        const saved=db.prepare(`INSERT INTO character_variants(proxy_id,name,${columns.join(',')}) VALUES (${Array(12).fill('?').join(',')})`).run(id,data.name.trim(),...keys.map(key=>source[key]||''));
        sync(id);return {variantId:Number(saved.lastInsertRowid)};
      }
      const variant=person.variants.find(v=>v.id===data?.variantId);if(!variant)return {status:404,error:'Variant not found.'};
      if(action==='select') {
        db.prepare('INSERT INTO character_profiles(proxy_id,active_variant) VALUES (?,?) ON CONFLICT(proxy_id) DO UPDATE SET active_variant=excluded.active_variant').run(id,variant.id);return {};
      }
      if(action==='delete') {
        if(!variant.id)return {status:400,error:'The main variant cannot be deleted.'};
        db.prepare('UPDATE character_profiles SET active_variant=0 WHERE proxy_id=? AND active_variant=?').run(id,variant.id);
        db.prepare('DELETE FROM character_variants WHERE proxy_id=? AND id=?').run(id,variant.id);return {};
      }
      if(action!=='save')return {status:400,error:'Invalid variant action.'};
      if(variant.id&&(typeof data.name!=='string'||!data.name.trim()||data.name.length>60))return {status:400,error:'Enter a variant name up to 60 characters.'};
      if(variant.id&&person.variants.some(v=>v.id!==variant.id&&v.name.toLocaleLowerCase()===data.name.trim().toLocaleLowerCase()))return {status:400,error:'Choose a different variant name.'};
      const designation=data.designation===undefined?variant.designationOverride||'':data.designation;
      if(typeof designation!=='string'||designation!==''&&!/^[A-Za-z0-9]{4}$/.test(designation))return {status:400,error:'Use four letters or digits, or leave the variant hash blank to use Main’s hash.'};
      const status=data.status===undefined?variant.statusOverride||'':data.status;
      if(typeof status!=='string'||status.length>120||status.includes('\0'))return {status:400,error:'Keep the variant status within 120 characters.'};
      const raw=variant.id?{avatarUrl:variant.avatarOverride,bannerUrl:variant.bannerOverride}:variant;
      const images=media.update(data,raw),body=media.update({banner:data.fullBody},{bannerUrl:variant.id?variant.fullBodyOverride:variant.fullBodyUrl});
      const overrides={};for(const [key,limit] of [['displayName',100],['description',4000],['group',100],['prefix',100],['suffix',100]]){const value=data[key]===undefined?(variant[(key==='displayName'?'name':key)+'Override']||''):data[key];if(typeof value!=='string'||value.length>limit||value.includes('\0'))return {status:400,error:'Keep character fields within their limits.'};overrides[key]=value.trim();}
      if(images.error||body.error)return {status:400,error:images.error||body.error};
      if(variant.id)db.prepare('UPDATE character_variants SET name=?,avatar_url=?,banner_url=?,body_url=?,designation=?,status_text=?,display_name=?,description=?,group_name=?,prefix=?,suffix=? WHERE proxy_id=? AND id=?').run(data.name.trim(),images.avatarUrl,images.bannerUrl,body.bannerUrl,designation.toUpperCase(),status.trim(),overrides.displayName,overrides.description,overrides.group,overrides.prefix,overrides.suffix,id,variant.id);
      else {
        db.prepare('UPDATE proxies SET avatar_url=?,banner=? WHERE id=?').run(images.avatarUrl,images.bannerUrl,id);
        db.prepare('INSERT INTO character_profiles(proxy_id,body_url) VALUES (?,?) ON CONFLICT(proxy_id) DO UPDATE SET body_url=excluded.body_url').run(id,body.bannerUrl);
      }
      sync(id);return {};
    }
  };
}
