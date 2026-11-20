// Keep existing conversation IDs so messages and attachments retain their references.
export function createDirectInboxes(db) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'first_proxy'").get()) {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE conversations_with_inboxes (
          id INTEGER PRIMARY KEY,
          first_id INTEGER NOT NULL REFERENCES accounts(id),
          second_id INTEGER NOT NULL REFERENCES accounts(id),
          first_proxy INTEGER NOT NULL DEFAULT 0,
          second_proxy INTEGER NOT NULL DEFAULT 0,
          CHECK (first_id < second_id OR (first_id = second_id AND first_proxy < second_proxy)),
          UNIQUE (first_id, second_id, first_proxy, second_proxy)
        );
        INSERT INTO conversations_with_inboxes(id, first_id, second_id)
          SELECT id, first_id, second_id FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_with_inboxes RENAME TO conversations;
        CREATE INDEX conversations_second ON conversations(second_id);
      `);
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid conversation references');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS dm_unread (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      proxy_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS dm_closed (
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      proxy_id INTEGER NOT NULL,
      PRIMARY KEY (account_id, conversation_id, proxy_id)
    );
    CREATE TABLE IF NOT EXISTS chat_servers (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      icon_url TEXT NOT NULL DEFAULT '',
      conversation_id INTEGER UNIQUE REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS chat_server_members (
      server_id INTEGER NOT NULL REFERENCES chat_servers(id),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      PRIMARY KEY (server_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS chat_server_members_account ON chat_server_members(account_id, server_id);
    CREATE INDEX IF NOT EXISTS chat_servers_owner ON chat_servers(owner_id);
    CREATE INDEX IF NOT EXISTS dm_unread_inbox ON dm_unread(account_id, conversation_id, proxy_id, message_id);
  `);
  const create = db.prepare(`
    INSERT INTO conversations(first_id, first_proxy, second_id, second_proxy) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const find = db.prepare(`
    SELECT id FROM conversations WHERE first_id = ? AND first_proxy = ? AND second_id = ? AND second_proxy = ?
  `);
  const pair = db.prepare('SELECT first_id, first_proxy, second_id, second_proxy FROM conversations WHERE id = ?');
  const available = db.prepare('SELECT 1 FROM proxies WHERE id = ? AND account_id = ? AND archived = 0');
  const encountered = db.prepare(`
    SELECT 1 FROM conversations c
    WHERE (c.first_id = ? OR c.second_id = ?) AND (
      (c.first_id = ? AND c.first_proxy = ?) OR (c.second_id = ? AND c.second_proxy = ?) OR
      EXISTS (SELECT 1 FROM direct_messages m WHERE m.conversation_id = c.id AND m.sender_id = ? AND m.proxy_id = ?)
    ) LIMIT 1
  `);
  const list = db.prepare(`
    WITH inboxes AS (
      SELECT id, first_proxy AS inboxProxyId, second_id AS peerId, second_proxy AS proxyId
      FROM conversations WHERE first_id = :viewer
      UNION ALL
      SELECT id, second_proxy, first_id, first_proxy FROM conversations WHERE second_id = :viewer
    )
    SELECT i.id, i.inboxProxyId, i.peerId, nullif(i.proxyId, 0) AS proxyId,
      CASE WHEN i.proxyId = 0 THEN a.public_tag END AS publicTag,
      coalesce(p.name, a.display_name) AS displayName,
      CASE WHEN p.id IS NULL THEN a.avatar_url ELSE p.avatar_url END AS avatarUrl,
      coalesce(p.banner, a.banner_url) AS bannerUrl, coalesce(p.description, a.bio) AS bio,
      CASE WHEN p.id IS NOT NULL THEN coalesce(nullif(p.designation, ''), a.public_tag) END AS designation,
      CASE WHEN p.id IS NULL THEN a.status_text ELSE p.status_text END AS status,
      CASE WHEN p.id IS NULL THEN a.joined_at END AS joinedAt,
      (SELECT max(id) FROM direct_messages WHERE conversation_id = i.id) AS lastMessageId,
      (SELECT count(*) FROM dm_unread n
       WHERE n.conversation_id = i.id AND n.account_id = :viewer AND n.proxy_id = i.inboxProxyId) AS unread,
      (SELECT coalesce(speaker.name, sender.display_name)
       FROM dm_unread n JOIN direct_messages m ON m.id = n.message_id
       JOIN accounts sender ON sender.id = m.sender_id LEFT JOIN proxies speaker ON speaker.id = m.proxy_id
       WHERE n.conversation_id = i.id AND n.account_id = :viewer AND n.proxy_id = i.inboxProxyId
       ORDER BY n.message_id DESC LIMIT 1) AS unreadSender
    FROM inboxes i JOIN accounts a ON a.id = i.peerId
    LEFT JOIN proxies p ON p.id = i.proxyId AND p.account_id = a.id
    WHERE i.inboxProxyId >= 0 AND coalesce(i.proxyId, 0) >= 0
      AND NOT EXISTS (SELECT 1 FROM dm_closed c WHERE c.account_id = :viewer
        AND c.conversation_id = i.id AND c.proxy_id = i.inboxProxyId)
      AND (i.inboxProxyId = 0 OR EXISTS (
        SELECT 1 FROM proxies owned WHERE owned.id = i.inboxProxyId AND owned.account_id = :viewer AND owned.archived = 0
      ))
    ORDER BY lastMessageId DESC, i.id DESC
  `);
  const mark = db.prepare(`
    DELETE FROM dm_unread WHERE account_id = ? AND conversation_id = ? AND proxy_id = ? AND message_id <= ?
  `);
  const add = db.prepare('INSERT INTO dm_unread VALUES (?, ?, ?, ?)');
  const hide = db.prepare('INSERT OR IGNORE INTO dm_closed VALUES (?, ?, ?)');
  const reveal = db.prepare('DELETE FROM dm_closed WHERE account_id = ? AND conversation_id = ? AND proxy_id = ?');
  const addServer = db.prepare('INSERT INTO chat_servers(owner_id, name, icon_url, invite_code) VALUES (?, ?, ?, ?)');
  const addMember = db.prepare('INSERT OR IGNORE INTO chat_server_members VALUES (?, ?)');
  const byInvite = db.prepare('SELECT id FROM chat_servers WHERE invite_code = ?');
  const nextServerBacking = db.prepare('SELECT coalesce(min(first_proxy), 0) - 1 AS id FROM conversations WHERE first_id = ?');
  const linkChannel = db.prepare('UPDATE chat_servers SET conversation_id = ? WHERE id = ?');
  const memberServers = db.prepare(`
    SELECT s.id, s.name, s.icon_url AS iconUrl, s.conversation_id AS conversationId, s.owner_id AS ownerId,
           CASE WHEN s.owner_id = m.account_id THEN s.invite_code END AS inviteCode
    FROM chat_server_members m JOIN chat_servers s ON s.id = m.server_id
    WHERE m.account_id = ? ORDER BY s.id
  `);
  const serverMembers = db.prepare(`
    SELECT a.id, a.public_tag AS publicTag, a.display_name AS displayName, a.avatar_url AS avatarUrl,
           a.banner_url AS bannerUrl, a.bio, a.status_text AS status, a.joined_at AS joinedAt
    FROM chat_server_members m JOIN accounts a ON a.id = m.account_id
    JOIN chat_servers s ON s.id = m.server_id WHERE s.id = ?
    ORDER BY (s.owner_id = a.id) DESC, a.display_name COLLATE NOCASE
  `);
  const channelMembers = db.prepare(`
    SELECT m.account_id AS id FROM chat_server_members m
    JOIN chat_servers s ON s.id = m.server_id WHERE s.conversation_id = ?
  `);
  function participants(thread) {
    return [[thread.first_id, thread.first_proxy], [thread.second_id, thread.second_proxy]];
  }
  return {
    pair: id => pair.get(id),
    list: account => list.all({ viewer: account }),
    servers: account => memberServers.all(account).map(server => ({ ...server, members: serverMembers.all(server.id) })),
    viewers(conversation) {
      const channel = channelMembers.all(conversation);
      if (channel.length) return channel.map(member => member.id);
      const thread = pair.get(conversation);
      return [...new Set([thread.first_id, thread.second_id])];
    },
    joinServer(account, code) {
      const server = byInvite.get(code);
      if (!server) return null;
      return { id: server.id, joined: Boolean(addMember.run(server.id, account).changes) };
    },
    createServer(owner, name, iconUrl, inviteCode) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const id = Number(addServer.run(owner, name, iconUrl, inviteCode).lastInsertRowid);
        // An owner-only channel reuses message storage without appearing in either DM inbox.
        const endpoints = [owner, nextServerBacking.get(owner).id, owner, 0];
        create.run(...endpoints);
        const conversationId = find.get(...endpoints).id;
        linkChannel.run(conversationId, id);
        addMember.run(id, owner);
        db.exec('COMMIT');
        return { id, name, iconUrl, conversationId, ownerId: owner, inviteCode, members: serverMembers.all(id) };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close(account, conversation, proxy) {
      const thread = pair.get(conversation);
      if (!thread || proxy < 0 || thread.first_proxy < 0 ||
          !participants(thread).some(([id, identity]) => id === account && identity === proxy)) return false;
      hide.run(account, conversation, proxy);
      mark.run(account, conversation, proxy, Number.MAX_SAFE_INTEGER);
      return true;
    },
    open(account, senderProxy, recipient, recipientProxy) {
      if (!Number.isSafeInteger(senderProxy) || !Number.isSafeInteger(recipientProxy) ||
          (senderProxy !== 0 && !available.get(senderProxy, account)) ||
          (recipientProxy !== 0 && (!available.get(recipientProxy, recipient) ||
            (recipient !== account && !encountered.get(account, account, recipient, recipientProxy,
              recipient, recipientProxy, recipient, recipientProxy)))) ||
          (account === recipient && senderProxy === recipientProxy)) return null;
      const endpoints = [[account, senderProxy], [recipient, recipientProxy]];
      endpoints.sort(([a, p], [b, q]) => a - b || p - q);
      const key = endpoints.flat();
      create.run(...key);
      const thread = find.get(...key);
      reveal.run(account, thread.id, senderProxy);
      return thread;
    },
    speaker(thread, account, inboxProxy) {
      if ((!thread.first_proxy && !thread.second_proxy) || thread.first_proxy < 0) return { dedicated: false };
      const endpoints = participants(thread);
      if (endpoints.some(([id, proxy]) => proxy && !available.get(proxy, id))) return null;
      const own = endpoints.filter(([id]) => id === account);
      const identity = own.length === 1 ? own[0] : own.find(([, proxy]) => proxy === inboxProxy);
      if (!identity) return null;
      return { dedicated: true, proxyId: identity[1] || null };
    },
    addUnread(thread, sender, proxy, conversation, message) {
      if (thread.first_proxy < 0) return null;
      const target = participants(thread).find(([id, identity]) =>
        id !== sender || (thread.first_id === thread.second_id && identity !== (proxy || 0)));
      if (target) {
        add.run(message, ...target, conversation);
        reveal.run(target[0], conversation, target[1]);
      }
      return target;
    },
    read(account, conversation, proxy, through) {
      return mark.run(account, conversation, proxy, through).changes;
    },
  };
}
