import { messageFormat } from './message-format.mjs';
export function createForums(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_posts (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS forum_comments (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES forum_posts(message_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS forum_comments_post ON forum_comments(post_id, message_id);
    CREATE TABLE IF NOT EXISTS forum_votes (
      post_id INTEGER NOT NULL REFERENCES forum_posts(message_id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      value INTEGER NOT NULL CHECK(value IN (-1, 1)),
      PRIMARY KEY(post_id, account_id)
    );
    CREATE TRIGGER IF NOT EXISTS forum_delete_discussion BEFORE DELETE ON direct_messages
    WHEN EXISTS(SELECT 1 FROM forum_posts WHERE message_id = OLD.id)
    BEGIN DELETE FROM direct_messages WHERE id IN (SELECT message_id FROM forum_comments WHERE post_id = OLD.id); END;
    INSERT OR IGNORE INTO forum_posts(message_id)
      SELECT m.id FROM direct_messages m JOIN server_channels c ON c.conversation_id = m.conversation_id
      WHERE c.kind = 'forum' AND NOT EXISTS(SELECT 1 FROM forum_comments WHERE message_id = m.id);
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS forum_post_formats (
    message_id INTEGER PRIMARY KEY REFERENCES forum_posts(message_id) ON DELETE CASCADE,
    format TEXT NOT NULL);`);
  const saveFormat = db.prepare('INSERT INTO forum_post_formats VALUES (?,?) ON CONFLICT(message_id) DO UPDATE SET format = excluded.format');
  const removeFormat = db.prepare('DELETE FROM forum_post_formats WHERE message_id = ?');
  const storeFormat = (id, format) => format ? saveFormat.run(id, JSON.stringify(format)) : removeFormat.run(id);
  const channel = db.prepare("SELECT 1 FROM server_channels WHERE conversation_id = ? AND kind = 'forum'");
  const post = db.prepare('SELECT 1 FROM forum_posts f JOIN direct_messages m ON m.id = f.message_id WHERE m.conversation_id = ? AND f.message_id = ?');
  const create = db.prepare('INSERT INTO forum_posts(message_id, body) VALUES (?, ?)');
  const comment = db.prepare('INSERT INTO forum_comments VALUES (?, ?)');
  const vote = db.prepare('INSERT INTO forum_votes VALUES (?, ?, ?) ON CONFLICT(post_id, account_id) DO UPDATE SET value = excluded.value');
  const unvote = db.prepare('DELETE FROM forum_votes WHERE post_id = ? AND account_id = ?');
  const updateBody = db.prepare('UPDATE forum_posts SET body = ? WHERE message_id = ?');
  const rows = `SELECT m.id, m.body AS title, m.format, m.sent, m.sender_id AS senderId,
    coalesce(json_extract(mp.profile,'$.displayName'),p.name,a.display_name) AS displayName,
    coalesce(json_extract(mp.profile,'$.avatarUrl'),CASE WHEN p.id IS NULL THEN a.avatar_url ELSE p.avatar_url END) AS avatarUrl,
    coalesce((SELECT sum(value) FROM forum_votes WHERE post_id = m.id), 0) AS rating,
    coalesce((SELECT value FROM forum_votes WHERE post_id = m.id AND account_id = :account), 0) AS vote,
    (SELECT count(*) FROM forum_comments WHERE post_id = m.id) AS comments
    FROM forum_posts f JOIN direct_messages m ON m.id = f.message_id JOIN accounts a ON a.id = m.sender_id
    LEFT JOIN proxies p ON p.id = m.proxy_id AND p.account_id = m.sender_id
    LEFT JOIN message_character_looks ml ON ml.message_id=m.id
    LEFT JOIN character_looks mp ON mp.id=ml.look_id AND mp.proxy_id=m.proxy_id
    WHERE m.conversation_id = :conversation`;
  const list = db.prepare(rows + ' ORDER BY rating DESC, m.id DESC LIMIT 51 OFFSET :offset');
  const detail = db.prepare(rows.replace('SELECT m.id,', 'SELECT f.body, (SELECT format FROM forum_post_formats WHERE message_id = m.id) AS bodyFormat, m.id,') + ' AND m.id = :id');
  return {
    isForum: id => Boolean(channel.get(id)),
    hasPost: (conversation, id) => Number.isSafeInteger(id) && Boolean(post.get(conversation, id)),
    validate(conversation, message, editId) {
      if (message.forumFormat != null) {
        if (message.forumBody === undefined || message.forumPostId != null || !this.isForum(conversation)) return 'Invalid forum description formatting.';
        try { message.forumFormat = messageFormat({ format: message.forumFormat }); } catch (error) { return error.message; }
      }
      if (editId) {
        if (message.forumBody !== undefined && (typeof message.forumBody !== 'string' || message.forumBody.length > 100000 || !this.hasPost(conversation, editId))) return 'Invalid forum post description.';
        return;
      }
      if (message.forumPostId != null && !this.hasPost(conversation, message.forumPostId)) return 'Forum post not found.';
      if (!this.isForum(conversation)) return;
      if (message.forumPostId == null && (message.body.length > 200 || !message.body.trim())) return 'Enter a forum post title of 1–200 characters.';
      if (message.forumBody != null && (typeof message.forumBody !== 'string' || message.forumBody.length > 100000)) return 'Post descriptions can contain up to 100,000 characters.';
    },
    record(conversation, id, message) {
      if (!this.isForum(conversation)) return;
      if (message.forumPostId != null) comment.run(id, message.forumPostId);
      else { create.run(id, message.forumBody || ''); storeFormat(id,message.forumFormat); }
    },
    prepareEdit(conversation, id, input) {
      if (!this.hasPost(conversation, id)) return { error: 'Forum post not found.', status: 404 };
      if (typeof input?.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.body !== 'string' || input.body.length > 100000) return { error: 'Enter a title up to 200 characters and a description up to 100,000 characters.', status: 400 };
      return { body: input.title.trim(), forumBody: input.body, forumFormat: input.bodyFormat };
    },
    updateBody(id, message) {
      if (message.forumBody !== undefined) { updateBody.run(message.forumBody,id); storeFormat(id,message.forumFormat); }
    },
    list(conversation, account, offset = 0) {
      const posts = list.all({ conversation, account, offset });
      return { posts: posts.slice(0, 50), hasMore: posts.length > 50 };
    },
    detail(conversation, account, id) { return detail.get({ conversation, account, id }); },
    vote(conversation, account, id, value) {
      if (!this.hasPost(conversation, id)) return { error: 'Forum post not found.', status: 404 };
      if (![-1, 0, 1].includes(value)) return { error: 'Choose an upvote or downvote.', status: 400 };
      if (value) vote.run(id, account, value); else unvote.run(id, account);
      return { post: this.detail(conversation, account, id) };
    },
  };
}
