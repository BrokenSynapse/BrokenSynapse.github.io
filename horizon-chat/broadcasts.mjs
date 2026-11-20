const initialOwnerLogin = 'brokensynapsehorizon:0000';

export function createBroadcasts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      account_id INTEGER NOT NULL REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS broadcast_channel (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS broadcast_deliveries (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
      unread INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (account_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS broadcast_delivery_message ON broadcast_deliveries(message_id);
    CREATE TABLE IF NOT EXISTS platform_owner_direct (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, owner_id)
    );
  `);
  const openedByOwner = db.prepare('SELECT 1 FROM platform_owner_direct WHERE conversation_id = ? AND owner_id = ?');
  const allowThread = db.prepare('INSERT OR IGNORE INTO platform_owner_direct VALUES (?, ?)');
  const getOwner = db.prepare('SELECT account_id AS id FROM platform_owner WHERE singleton = 1');
  let channel;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO platform_owner(singleton, account_id)
      SELECT 1, id FROM accounts WHERE username = ?
    `).run(initialOwnerLogin);
    channel = db.prepare('SELECT conversation_id AS id FROM broadcast_channel WHERE singleton = 1').get();
    const owner = getOwner.get();
    if (!channel && owner) {
      channel = db.prepare(`
        INSERT INTO conversations(first_id, second_id, first_proxy, second_proxy)
        SELECT ?, ?, coalesce(min(first_proxy), 0) - 1, 0 FROM conversations WHERE first_id = ?
        RETURNING id
      `).get(owner.id, owner.id, owner.id);
      db.prepare('INSERT INTO broadcast_channel VALUES (1, ?)').run(channel.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const stats = db.prepare('SELECT max(message_id) AS latest, coalesce(sum(unread), 0) AS unread FROM broadcast_deliveries WHERE account_id = ?');
  const hasDeliveries = db.prepare('SELECT 1 FROM broadcast_deliveries WHERE account_id = ? LIMIT 1');
  const delivered = db.prepare('SELECT 1 FROM broadcast_deliveries WHERE account_id = ? AND message_id = ?');
  const recipients = db.prepare('SELECT DISTINCT account_id AS id FROM broadcast_deliveries');
  const mark = db.prepare('UPDATE broadcast_deliveries SET unread = 0 WHERE account_id = ? AND unread = 1 AND message_id <= ?');
  const hidden = db.prepare('SELECT 1 FROM dm_closed WHERE account_id = ? AND conversation_id = ? AND proxy_id = 0');
  const hide = db.prepare('INSERT OR IGNORE INTO dm_closed(account_id, conversation_id, proxy_id) VALUES (?, ?, 0)');
  const reveal = db.prepare('DELETE FROM dm_closed WHERE conversation_id = ? AND proxy_id = 0');
  const deliver = db.prepare('INSERT INTO broadcast_deliveries(account_id, message_id) SELECT id, ? FROM accounts WHERE id <> ? RETURNING account_id');
  const profile = db.prepare(`
    SELECT id AS peerId, display_name AS displayName, public_tag AS publicTag, avatar_url AS avatarUrl,
           banner_url AS bannerUrl, bio, status_text AS status, joined_at AS joinedAt
    FROM accounts WHERE id = ?
  `);

  return {
    get ownerId() { return getOwner.get()?.id ?? null; },
    isChannel: conversation => Boolean(channel && conversation === channel.id),
    allowDirect(conversation, ownerId) {
      allowThread.run(conversation, ownerId);
    },
    directAllowed(conversation, first, second, ownerId = this.ownerId) {
      return (first !== ownerId && second !== ownerId) || Boolean(openedByOwner.get(conversation, ownerId));
    },
    mayRead(account) {
      return account === this.ownerId || Boolean(hasDeliveries.get(account));
    },
    mayReadMessage(account, message) {
      return account === this.ownerId || Boolean(delivered.get(account, message));
    },
    list(account) {
      if (!channel) return [];
      const ownerId = this.ownerId;
      const sender = profile.get(ownerId);
      const base = { ...sender, id: channel.id, inboxProxyId: 0, broadcast: true };
      if (account === ownerId) return [{ ...base, displayName: 'Everyone', broadcastWriter: true, unread: 0 }];
      const { latest, unread } = stats.get(account);
      if (latest === null || hidden.get(account, channel.id)) return [];
      return [{ ...base, unread, lastMessageId: latest }];
    },
    deliver(message) {
      reveal.run(channel.id);
      return deliver.all(message, this.ownerId).map(row => row.account_id);
    },
    viewers() {
      return [...new Set([this.ownerId, ...recipients.all().map(row => row.id)])];
    },
    read(account, through) {
      return mark.run(account, through).changes;
    },
    close(account, proxy) {
      if (proxy !== 0 || account === this.ownerId || !hasDeliveries.get(account)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        hide.run(account, channel.id);
        mark.run(account, Number.MAX_SAFE_INTEGER);
        db.exec('COMMIT');
        return true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
