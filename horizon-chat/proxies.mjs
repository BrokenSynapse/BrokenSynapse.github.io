import { createCharacterVariants } from './character-variants.mjs';
export function createProxies(db, media) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      suffix TEXT NOT NULL,
      group_name TEXT NOT NULL,
      description TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      banner TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, name, prefix, suffix)
    );
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('direct_messages') WHERE name = 'proxy_id'").get()) {
    db.exec('ALTER TABLE direct_messages ADD COLUMN proxy_id INTEGER REFERENCES proxies(id)');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('proxies') WHERE name = 'archived'").get()) {
    db.exec('ALTER TABLE proxies ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('proxies') WHERE name = 'designation'").get()) {
    db.exec("ALTER TABLE proxies ADD COLUMN designation TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('proxies') WHERE name = 'status_text'").get()) {
    db.exec("ALTER TABLE proxies ADD COLUMN status_text TEXT NOT NULL DEFAULT ''");
  }
  const variants = createCharacterVariants(db,media);
  const profileFields = `id, name, prefix, suffix, group_name AS "group", description, status_text AS status, avatar_url AS avatarUrl,
    banner AS bannerUrl, coalesce(nullif(designation, ''),
    (SELECT public_tag FROM accounts WHERE accounts.id = proxies.account_id)) AS designation`;
  const roster = db.prepare(`
    SELECT ${profileFields}
    FROM proxies WHERE account_id = ? AND archived = 0 ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE, id
  `);
  const owned = db.prepare(`SELECT ${profileFields} FROM proxies WHERE account_id = ? AND id = ? AND archived = 0`);
  const archive = db.prepare("UPDATE proxies SET archived = 1, prefix = char(0) || id, suffix = '' WHERE account_id = ? AND id = ? AND archived = 0");
  const update = db.prepare(`
    UPDATE proxies SET name = ?, prefix = ?, suffix = ?, group_name = ?, description = ?, avatar_url = ?, banner = ?, designation = ?, status_text = ?
    WHERE account_id = ? AND id = ? AND archived = 0
  `);
  const insert = db.prepare(`
    INSERT INTO proxies(account_id, name, prefix, suffix, group_name, description, avatar_url, banner, designation, status_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, name, prefix, suffix) DO NOTHING
  `);
  const limited = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';

  return {
    variants,
    list(accountId) {
      return roster.all(accountId).map(variants.decorate);
    },
    save(accountId, id, data) {
      const existing = id == null ? {} : owned.get(accountId, id);
      if (!existing) return { status: 404, error: 'Character not found.' };
      const fields = [['name', 100], ['prefix', 100], ['suffix', 100], ['group', 100], ['description', 4000]];
      if (!data || fields.some(([key, limit]) => typeof data[key] !== 'string' ||
          data[key].length > limit || data[key].includes('\0')) || !data.name.trim()) {
        return { status: 400, error: 'Enter a name and keep the character fields within their limits.' };
      }
      if (typeof data.designation !== 'string' || !/^[0-9A-Z]{4}$/i.test(data.designation)) {
        return { status: 400, error: 'Enter a four-character designation using letters or digits.' };
      }
      const status = data.status === undefined ? existing.status || '' : data.status;
      if (typeof status !== 'string' || status.length > 120 || status.includes('\0')) {
        return { status: 400, error: 'Keep your status within 120 characters.' };
      }
      const images = media.update(data, existing);
      if (images.error) return { status: 400, error: images.error };
      const values = [data.name.trim(), data.prefix, data.suffix, data.group.trim(), data.description.trim(), images.avatarUrl, images.bannerUrl, data.designation.toUpperCase(), status.trim()];
      try {
        if (id == null) {
          const result = insert.run(accountId, ...values, new Date().toISOString());
          if (!result.changes) return { status: 409, error: 'A character already uses that name and trigger.' };
          id = Number(result.lastInsertRowid);
        } else {
          update.run(...values, accountId, id);
        }
      } catch (error) {
        if (error.errcode === 2067) return { status: 409, error: 'A character already uses that name and trigger.' };
        throw error;
      }
      variants.sync(id);
      return { proxy: variants.decorate(owned.get(accountId,id)), proxies: roster.all(accountId).map(variants.decorate) };
    },
    delete(accountId, id) {
      if (!archive.run(accountId, id).changes) return { status: 404, error: 'Character not found.' };
      return { proxies: roster.all(accountId).map(variants.decorate) };
    },
    import(accountId, data) {
      if (!Array.isArray(data.tuppers) || !data.tuppers.length || data.tuppers.length > 500) {
        return { error: 'Select a Tupperbox export containing 1–500 characters.' };
      }
      const groups = new Map((Array.isArray(data.groups) ? data.groups : [])
        .filter(group => group && typeof group.name === 'string')
        .map(group => [String(group.id), group.name]));
      const duplicates = [];
      let imported = 0;
      let invalid = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of data.tuppers) {
          const name = limited(entry?.name, 100).trim();
          if (!name || entry.name.length > 100 || (entry.brackets != null &&
              (!Array.isArray(entry.brackets) || entry.brackets.length !== 2 ||
               !entry.brackets.every(value => typeof value === 'string' && value.length <= 100 && !value.includes('\0'))))) {
            invalid++;
            continue;
          }
          const [prefix, suffix] = entry.brackets || ['', ''];
          const group = groups.get(String(entry.group_id)) || entry.group_name;
          const result = insert.run(accountId, name, prefix, suffix, limited(group, 100),
            limited(entry.description ?? entry.desc, 4000), limited(entry.avatar_url, 2048),
            limited(entry.banner, 2048), '', '', limited(entry.created_at, 100));
          if (result.changes) imported++;
          else duplicates.push(name);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { imported, duplicates, invalid, proxies: roster.all(accountId).map(variants.decorate) };
    },
    resolve(accountId, proxyId, body, allowTriggers = true, hasAttachment = false) {
      if (proxyId != null && (!Number.isSafeInteger(proxyId) || !owned.get(accountId, proxyId))) {
        return { error: 'That character is unavailable.' };
      }
      if (!allowTriggers) return { proxyId: proxyId ?? null, body };
      let selected = null;
      let tied = false;
      let specificity = 0;
      for (const proxy of roster.all(accountId).flatMap(raw=>{const person=variants.decorate(raw),seen=new Set();return [...person.variants.filter(v=>v.id===person.variantId),...person.variants].flatMap(v=>{const key=JSON.stringify([v.prefix,v.suffix]);if(seen.has(key))return [];seen.add(key);return [{...raw,prefix:v.prefix,suffix:v.suffix,variantId:v.id}];});})) {
        const length = proxy.prefix.length + proxy.suffix.length;
        if (!length || length > body.length || length < specificity ||
            !body.startsWith(proxy.prefix) || !body.endsWith(proxy.suffix)) continue;
        tied = length === specificity;
        selected = proxy;
        specificity = length;
      }
      if (tied) return { error: 'More than one character matches those brackets. Choose a character and remove the brackets.' };
      if (!selected) return { proxyId: proxyId ?? null, body };
      const message = body.slice(selected.prefix.length, body.length - selected.suffix.length);
      if (!message.trim() && !hasAttachment) return { proxyId: selected.id, variantId:selected.variantId, reproxy: true };
      return { proxyId: selected.id, variantId:selected.variantId, body: message, prefixLength: selected.prefix.length, suffixLength: selected.suffix.length };
    },
  };
}
