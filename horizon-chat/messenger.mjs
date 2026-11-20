import { configuredRestartStatus } from './maintenance.mjs';
import { createTyping } from './typing.mjs';
import { createChannelPasswords } from './channel-passwords.mjs';
import { createForums } from './forums.mjs';
import { createServerLayouts } from './server-layouts.mjs';
import { rollDice } from './dice.mjs';
import { createTimelines } from './timelines.mjs';
import { createChannelMaps } from './channel-maps.mjs';
import { createBroadcasts } from './broadcasts.mjs';
import { createPublicHandles, defaultDisplayName, sharesLoginName } from './public-handles.mjs';
import { backgroundJsonLimit } from './server-background.mjs';
import { emojiCounts } from './emojis.mjs';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createServerPermissions } from './server-permissions.mjs';
import { createDirectInboxes } from './direct-inboxes.mjs';
import { createProxies } from './proxies.mjs';
import { createProfileMedia, mediaPath } from './profile-media.mjs';
import { createRecoveryArchives } from './recovery-archives.mjs';
import { createAttachmentPeers } from './attachment-peers.mjs';
import { createHostedArchives } from './hosted-archives.mjs';
import { createTrustedDevices } from './trusted-devices.mjs';
import { documentThreshold, messageFormat, messageLimit, trimRichFormat } from './message-format.mjs';
import { createDocuments, documentInfo, fileLimit, fileType, packDocument, readFileInfo } from './message-documents.mjs';

const hashPassword = promisify(scrypt);
const sessionSeconds = 30 * 86400;
const prefix = '/horizon-chat/api/';
const usernamePattern = /^[a-zA-Z0-9_]{3,24}$/;
const handlePattern = /^[a-zA-Z0-9_]{3,24}:[0-9A-Z]{4}$/i;
const tagPattern = /^[0-9A-Z]{4}$/i;
const tagCount = 36 ** 4;
const recoveryPattern = /^[A-Za-z0-9_-]{16}$/;
const validPassword = value => typeof value === 'string' && value.length >= 5 && Buffer.byteLength(value) <= 512;
const passwordOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');

export function createMessenger(db, { secure, json }) {
  const allowAttachmentPeers = process.env.HORIZON_ATTACHMENT_PEERS === '1';
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      salt TEXT NOT NULL,
      credential TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      first_id INTEGER NOT NULL REFERENCES accounts(id),
      second_id INTEGER NOT NULL REFERENCES accounts(id),
      CHECK (first_id < second_id),
      UNIQUE (first_id, second_id)
    );
    CREATE INDEX IF NOT EXISTS conversations_second ON conversations(second_id);
    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      sender_id INTEGER NOT NULL REFERENCES accounts(id),
      body TEXT NOT NULL,
      sent INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS direct_messages_history ON direct_messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS direct_messages_rate ON direct_messages(sender_id, sent);
  `);
  db.exec('CREATE TABLE IF NOT EXISTS account_themes(account_id INTEGER PRIMARY KEY REFERENCES accounts(id),theme TEXT NOT NULL)');
  const media = createProfileMedia(db);
  const accountColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map(row => row.name));
  for (const column of ['bio', 'avatar_url', 'banner_url', 'status_text', 'joined_at']) {
    if (!accountColumns.has(column)) db.exec(`ALTER TABLE accounts ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('direct_messages') WHERE name = 'format'").get()) {
    db.exec('ALTER TABLE direct_messages ADD COLUMN format TEXT');
  }
  const documents = createDocuments(db);
  db.exec("UPDATE accounts SET username = username || ':0000' WHERE instr(username, ':') = 0");
  const publicHandles = createPublicHandles(db);
  const proxies = createProxies(db, media);
  const recoveryArchive = createRecoveryArchives(db, { json, readJson, readBody, sync: proxies.variants.sync });
  const hostedArchives = createHostedArchives(db, { json, readJson, readBody });
  const trustedDevices = createTrustedDevices(db, { json, readJson, hostedArchives, verifyPassword: verifyDevicePassword });
  const inboxes = createDirectInboxes(db);
  const serverPermissions = createServerPermissions(db);
  const broadcasts = createBroadcasts(db);
  const channelPasswords = createChannelPasswords(db,()=>broadcasts.ownerId);
  const channelMaps = createChannelMaps(db);
  const timelines = createTimelines(db);
  const serverLayouts = createServerLayouts(db);
  const forums = createForums(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_recovery (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
      code_hash TEXT NOT NULL UNIQUE
    )
  `);
  const recoveryByHash = db.prepare(`
    SELECT a.* FROM account_recovery r JOIN accounts a ON a.id = r.account_id WHERE r.code_hash = ?
  `);
  const recoveryHash = db.prepare('SELECT code_hash AS hash FROM account_recovery WHERE account_id = ?');
  const saveRecovery = db.prepare(`
    INSERT INTO account_recovery VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash
  `);
  function issueRecovery(id) {
    const code = randomBytes(12).toString('base64url');
    saveRecovery.run(id, digest(code));
    return code;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_contacts (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY(account_id, contact_id),
      CHECK(account_id <> contact_id)
    );
  `);
  const contacts = db.prepare(`
    SELECT a.id, a.public_tag AS publicTag, a.display_name AS displayName, a.avatar_url AS avatarUrl
    FROM account_contacts c JOIN accounts a ON a.id = c.contact_id
    WHERE c.account_id = ? AND a.id IS NOT ? ORDER BY a.display_key, a.public_tag
  `);
  const hasContact = db.prepare('SELECT 1 FROM account_contacts WHERE account_id = ? AND contact_id = ?');
  const addContact = db.prepare('INSERT OR IGNORE INTO account_contacts VALUES (?, ?)');
  const removeContact = db.prepare('DELETE FROM account_contacts WHERE account_id = ? AND contact_id = ?');
  const accountById = db.prepare('SELECT id FROM accounts WHERE id = ?');
  const accountByName = db.prepare('SELECT * FROM accounts WHERE username = ?');
  const nameRange = db.prepare('SELECT * FROM accounts WHERE username BETWEEN ? AND ? ORDER BY username');
  const accountsForName = name => nameRange.all(name + ':0000', name + ':ZZZZ');
  const changeCredential = db.prepare('UPDATE accounts SET credential = ? WHERE id = ?');
  const removeOtherSessions = db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?');
  function sameCredentials(before, after) {
    return before.length === after.length && before.every((row, index) =>
      row.id === after[index].id && row.credential === after[index].credential);
  }
  // New accounts join configured official servers once, at registration.
  // Leaving later is respected: logins and restarts never add them back.
  db.exec('CREATE TABLE IF NOT EXISTS default_server_memberships(server_id INTEGER PRIMARY KEY REFERENCES chat_servers(id) ON DELETE CASCADE)');
  const joinDefaultServers=db.prepare('INSERT OR IGNORE INTO chat_server_members(server_id,account_id) SELECT server_id,? FROM default_server_memberships');
  const createAccount = db.prepare('INSERT INTO accounts(username, display_name, salt, credential, joined_at, display_key, public_tag) VALUES(?, ?, ?, ?, ?, ?, ?)');
  function registerAccount(name, preferredTag, displayName, salt, credential, candidates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = accountsForName(name);
      if (!sameCredentials(candidates, current)) {
        db.exec('COMMIT');
        return { error: 'This username was just claimed. Try again.' };
      }
      const taken = new Set(current.map(row => row.username.slice(-4).toUpperCase()));
      if (taken.size === tagCount) {
        db.exec('COMMIT');
        return { error: 'All tags for this name are taken. Choose another name.' };
      }
      let tag = preferredTag;
      if (taken.size || !tag) {
        let index = randomInt(tagCount);
        do {
          tag = index.toString(36).toUpperCase().padStart(4, '0');
          index = (index + 1) % tagCount;
        } while (taken.has(tag));
      }
      const username = name + ':' + tag;
      const nameForProfile = displayName || defaultDisplayName;
      const handle = publicHandles.allocate(nameForProfile, preferredTag || tag);
      createAccount.run(username, nameForProfile, salt, credential.toString('hex'), new Date().toISOString(), ...handle);
      const account = accountByName.get(username);
      const recoveryCode = issueRecovery(account.id);
      joinDefaultServers.run(account.id);
      db.exec('COMMIT');
      return { account, recoveryCode };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const sessionAccount = db.prepare(`
    SELECT a.id, a.username, a.display_name AS displayName, a.public_tag AS publicTag, a.bio, a.avatar_url AS avatarUrl, a.banner_url AS bannerUrl,
           a.status_text AS status, a.joined_at AS joinedAt
    FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?
  `);
  const updateProfile = db.prepare('UPDATE accounts SET display_name = ?, bio = ?, avatar_url = ?, banner_url = ?, status_text = ?, display_key = ?, public_tag = ? WHERE id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const createSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const membership = db.prepare(`
    SELECT 1 FROM conversations WHERE id = :conversation AND first_proxy >= 0
      AND (first_id = :account OR second_id = :account)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_replies (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      target_id INTEGER REFERENCES direct_messages(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS message_replies_target ON message_replies(target_id);
    CREATE TABLE IF NOT EXISTS message_id_sequence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_id INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO message_id_sequence SELECT 1, coalesce(max(id), 0) FROM direct_messages;
  `);
  const messageRows = `
    SELECT m.id, m.sender_id AS senderId, p.id AS proxyId, coalesce(json_extract(mp.profile,'$.displayName'),p.name,a.display_name) AS displayName,
           coalesce(json_extract(mp.profile,'$.avatarUrl'),CASE WHEN p.id IS NULL THEN a.avatar_url ELSE p.avatar_url END) AS avatarUrl, coalesce(json_extract(mp.profile,'$.bannerUrl'),p.banner,a.banner_url) AS bannerUrl, json_extract(mp.profile,'$.fullBodyUrl') AS fullBodyUrl, json_extract(mp.profile,'$.variantId') AS variantId, json_extract(mp.profile,'$.variantName') AS variantName,
           coalesce(json_extract(mp.profile,'$.bio'),p.description,a.bio) AS bio,
           CASE WHEN p.id IS NOT NULL THEN coalesce(json_extract(mp.profile,'$.designation'),nullif(p.designation,''),a.public_tag) END AS designation,
           CASE WHEN p.id IS NULL THEN a.public_tag END AS publicTag,
           CASE WHEN p.id IS NULL THEN a.status_text ELSE coalesce(json_extract(mp.profile,'$.status'),p.status_text) END AS status,
           CASE WHEN p.id IS NULL THEN a.joined_at END AS joinedAt,
           m.body, m.sent, m.format, comment.post_id AS forumPostId,
           invitation.message_id AS inviteMessageId, invitation.invite_id AS inviteId,
           invitation.recipient_id AS inviteRecipientId, invitation.server_name AS inviteServerName,
           CASE WHEN invitation.invite_id IS NULL AND invitation.status = 'pending' THEN 'expired' ELSE invitation.status END AS inviteStatus,
           (reply.message_id IS NOT NULL) AS isReply, source.id AS replyTargetId,
           coalesce(json_extract(sp.profile,'$.displayName'),source_proxy.name,source_author.display_name) AS replyAuthor,
           coalesce(json_extract(sp.profile,'$.avatarUrl'),CASE WHEN source_proxy.id IS NULL THEN source_author.avatar_url ELSE source_proxy.avatar_url END) AS replyAvatarUrl,
           substr(source.body, 1, 180) AS replyText,
           CASE WHEN source.body = '' AND json_valid(source.format)
                THEN substr(json_extract(source.format, '$.name'), 1, 180) END AS replyAttachment
    FROM direct_messages m JOIN accounts a ON a.id = m.sender_id
    LEFT JOIN proxies p ON p.id = m.proxy_id AND p.account_id = m.sender_id
    LEFT JOIN message_character_looks ml ON ml.message_id=m.id
    LEFT JOIN character_looks mp ON mp.id=ml.look_id AND mp.proxy_id=m.proxy_id
    LEFT JOIN forum_comments comment ON comment.message_id = m.id
    LEFT JOIN server_invite_messages invitation ON invitation.message_id = m.id
    LEFT JOIN message_replies reply ON reply.message_id = m.id
    LEFT JOIN direct_messages source ON source.id = reply.target_id AND source.conversation_id = m.conversation_id
      AND (:recipient IS NULL OR EXISTS (
        SELECT 1 FROM broadcast_deliveries WHERE account_id = :recipient AND message_id = source.id
      ))
    LEFT JOIN accounts source_author ON source_author.id = source.sender_id
    LEFT JOIN proxies source_proxy ON source_proxy.id = source.proxy_id AND source_proxy.account_id = source.sender_id
    LEFT JOIN message_character_looks sl ON sl.message_id=source.id
    LEFT JOIN character_looks sp ON sp.id=sl.look_id AND sp.proxy_id=source.proxy_id
    WHERE m.conversation_id = :conversation AND (:forumPost IS NULL OR comment.post_id = :forumPost) AND (:recipient IS NULL OR EXISTS (
      SELECT 1 FROM broadcast_deliveries WHERE account_id = :recipient AND message_id = m.id
    ))
  `;
  const history = db.prepare(messageRows + ' AND m.id < :cursor ORDER BY m.id DESC LIMIT 51');
  const catchUp = db.prepare(messageRows + ' AND m.id > :cursor ORDER BY m.id LIMIT 51');
  const nextMessageId = db.prepare(`
    UPDATE message_id_sequence
    SET last_id = max(last_id, (SELECT coalesce(max(id), 0) FROM direct_messages)) + 1
    WHERE singleton = 1 RETURNING last_id AS id
  `);
  const post = db.prepare('INSERT INTO direct_messages(id, conversation_id, sender_id, body, sent, proxy_id, format) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const replyTarget = db.prepare('SELECT 1 FROM direct_messages WHERE conversation_id = ? AND id = ?');
  const recordReply = db.prepare('INSERT INTO message_replies(message_id, target_id) VALUES (?, ?)');
  const editable = db.prepare("SELECT body, format FROM direct_messages WHERE conversation_id = ? AND id = ? AND sender_id = ? AND coalesce(json_extract(format, '$.kind'), '') <> 'dice' AND id NOT IN (SELECT message_id FROM server_invite_messages)");
  const updateMessage = db.prepare('UPDATE direct_messages SET body = ?, format = ? WHERE id = ?');
  const deleteMessage = db.prepare(`
    DELETE FROM direct_messages WHERE conversation_id = :conversation AND id = :message
      AND (sender_id = :actor OR :moderator OR EXISTS (
        SELECT 1 FROM platform_owner WHERE singleton = 1 AND account_id = :actor
      ))
  `);
  const reproxyLast = db.prepare(`
    UPDATE direct_messages SET proxy_id = ? WHERE id = (
      SELECT id FROM direct_messages WHERE sender_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT 1
    ) RETURNING id
  `);
  const count = db.prepare('SELECT count(*) AS n FROM direct_messages WHERE sender_id = ? AND sent > ?');
  const peers = inboxes.pair;
  const streams = new Map();
  const presence = new Map();
  const presencePeers = db.prepare(`SELECT id FROM accounts WHERE id = :account
    OR id IN (SELECT contact_id FROM account_contacts WHERE account_id = :account)
    OR id IN (SELECT CASE WHEN first_id = :account THEN second_id ELSE first_id END FROM conversations WHERE first_id = :account OR second_id = :account)
    OR id IN (SELECT other.account_id FROM chat_server_members own JOIN chat_server_members other ON other.server_id = own.server_id WHERE own.account_id = :account)`);
  function announcePresence(id) {
    if (!db.isOpen) return;
    for (const viewer of presencePeers.all({account:id})) notify(viewer.id,0,'updated','presence');
  }
  function presenceState(id) {
    if (!streams.get(id)?.size) return 'offline';
    const live = [...streams.get(id)].map(client => presence.get(client.tokenHash)).filter(state => state && Date.now() - state.at < 150000);
    return live.some(state => state.state === 'online') ? 'online' : 'away';
  }
  db.exec(`CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    PRIMARY KEY(message_id,account_id));`);
  const addMention = db.prepare('INSERT OR IGNORE INTO message_mentions VALUES (?,?,?)');
  const unreadMentions = db.prepare('SELECT message_id AS messageId, conversation_id AS conversationId FROM message_mentions WHERE account_id = ? ORDER BY message_id DESC LIMIT 500');
  const clearMentions = db.prepare('DELETE FROM message_mentions WHERE account_id = ? AND conversation_id = ?');
  const authAttempts = new Map();
  let authInFlight = 0;
  let streamCount = 0;
  let uploadsInFlight = 0;
  const timingSalt = randomBytes(16).toString('hex');

  function setCookie(response, value, maxAge) {
    response.setHeader('Set-Cookie',
      `horizon_session=${value}; Path=/horizon-chat/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }

  function notify(id, conversationId, messageId, action = 'reproxy') {
    for (const { response } of streams.get(id) || []) {
      const event = messageId ? `event: ${action}\ndata: ${conversationId}:${messageId}\n\n`
        : `event: changed\ndata: ${conversationId}\n\n`;
      if (!response.write(event)) response.destroy();
    }
  }

  function mayReadConversation(conversation, account) {
    const channel = serverPermissions.channel(conversation);
    if (channel) return channel.kind !== 'separator' && serverPermissions.visible(conversation, account);
    if (broadcasts.isChannel(conversation)) return broadcasts.mayRead(account);
    if (!membership.get({ conversation, account })) return false;
    const pair = peers(conversation);
    return broadcasts.directAllowed(conversation, pair.first_id, pair.second_id);
  }

  function conversationViewers(conversation) {
    if (broadcasts.isChannel(conversation)) return broadcasts.viewers();
    const channel = serverPermissions.channel(conversation);
    return channel ? serverPermissions.members(channel.serverId).filter(id => serverPermissions.visible(conversation, id))
      : inboxes.viewers(conversation);
  }

  const typing=createTyping(db,streams,(conversation,viewer,token)=>mayReadConversation(conversation,viewer)&&(!serverPermissions.channel(conversation)||channelPasswords.allowed(token,conversation,viewer)));
  const attachmentPeers = createAttachmentPeers({
    authorize(peer, { conversation, message }) {
      return sessionAccount.get(peer.token, Date.now())?.id === peer.account &&
        mayReadConversation(conversation, peer.account) &&
        (!serverPermissions.channel(conversation) || channelPasswords.allowed(peer.token, conversation, peer.account)) &&
        (!broadcasts.isChannel(conversation) || broadcasts.mayReadMessage(peer.account, message));
    },
    describe: ({ conversation, message, offset }) => documents.peerChunk(conversation, message, offset),
    emit(peer, ticket) {
      for (const client of streams.get(peer.account) || []) {
        if (client.tokenHash === peer.token && !client.response.write(`event: attachment-peer\ndata: ${peer.id}:${ticket}\n\n`)) client.response.destroy();
      }
    },
  });
  // Caller owns the transaction. Every new message uses the same ID, reply and forum bookkeeping.
  function insertMessage(conversationId, accountId, message, storedFormat, sent = Date.now()) {
    const id = Number(nextMessageId.get().id);
    post.run(id, conversationId, accountId, message.body, sent, message.proxyId ?? null, storedFormat);
    proxies.variants.capture(id,accountId,message.proxyId,message.persona);
    if (message.replyTo != null) recordReply.run(id, message.replyTo);
    forums.record(conversationId, id, message);
    for(const client of streams.get(accountId)||[])typing.stop(accountId,client.tokenHash,conversationId,message.forumPostId||null);
    return id;
  }

  function resolveSpeaker(conversationId, accountId, input, format, { editing = false, attachment = false, triggers = true } = {}) {
    const broadcast = broadcasts.isChannel(conversationId);
    const inbox = editing ? { dedicated: false } : inboxes.speaker(peers(conversationId), accountId, input.inboxProxyId);
    if (!inbox) return { error: 'This character inbox is unavailable.' };
    const speaker = proxies.resolve(accountId, broadcast ? null : inbox.dedicated ? inbox.proxyId : input.proxyId,
      input.body, triggers && !broadcast && input.proxyId == null && !inbox.dedicated && !editing && format?.kind !== 'code', attachment);
    if (!speaker.error && format?.kind === 'rich' && speaker.body !== input.body) {
      trimRichFormat(format, speaker.prefixLength, speaker.suffixLength);
    }
    if (!speaker.error && speaker.proxyId) {
      const persona = proxies.variants.appearance(accountId,speaker.proxyId,speaker.variantId??input.variantId);
      if (persona.error) return persona;
      return {...speaker,variantId:persona.variantId,persona};
    }
    return speaker;
  }

  function deliverInvite(invite, proxyId = 0) {
    const existing = db.prepare('SELECT m.id, m.conversation_id AS conversation FROM server_invite_messages i JOIN direct_messages m ON m.id = i.message_id WHERE i.invite_id = ?').get(invite.id);
    if (existing) return { inviteConversation: existing.conversation, inviteMessage: existing.id };
    const conversation = inboxes.open(invite.inviter_id, proxyId, invite.recipient_id, 0);
    if (!conversation) throw new Error('Could not open the invitation conversation.');
    if (invite.inviter_id === broadcasts.ownerId) broadcasts.allowDirect(conversation.id, invite.inviter_id);
    const server = db.prepare('SELECT name FROM chat_servers WHERE id = ?').get(invite.server_id);
    const id = insertMessage(conversation.id, invite.inviter_id, { body: 'Invitation to ' + server.name, proxyId: proxyId || null }, null);
    db.prepare('INSERT INTO server_invite_messages(message_id, invite_id, recipient_id, server_name) VALUES (?, ?, ?, ?)')
      .run(id, invite.id, invite.recipient_id, server.name);
    inboxes.addUnread(peers(conversation.id), invite.inviter_id, proxyId || null, conversation.id, id);
    return { inviteConversation: conversation.id, inviteMessage: id };
  }

  // Convert pending invitations from earlier versions into ordinary DM cards.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const invite of db.prepare('SELECT * FROM server_invites WHERE id NOT IN (SELECT invite_id FROM server_invite_messages WHERE invite_id IS NOT NULL)').all()) deliverInvite(invite);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  function notifyProfileUpdate(account,proxy=null){
    const receivers=new Set([account]);
    if(proxy){
      for(const row of db.prepare('SELECT DISTINCT conversation_id AS id FROM direct_messages WHERE proxy_id=?').all(proxy))for(const viewer of conversationViewers(row.id))receivers.add(viewer);
      for(const row of db.prepare('SELECT first_id,second_id FROM conversations WHERE first_proxy=? OR second_proxy=?').all(proxy,proxy)){receivers.add(row.first_id);receivers.add(row.second_id);}
    }else{
      for(const person of presencePeers.all({account}))receivers.add(person.id);
      for(const person of db.prepare('SELECT account_id AS id FROM account_contacts WHERE contact_id=?').all(account))receivers.add(person.id);
    }
    for(const viewer of receivers)notify(viewer,account,proxy?String(proxy):'account','profile-updated');
  }
  function notifyServer(server) {
    for (const viewer of serverPermissions.members(server)) notify(viewer, 0, 'updated', 'server-update');
  }

  function notifyMemberPersona(account){for(const person of presencePeers.all({account}))notify(person.id,account,'state','member-persona');}
  const serversFor = account => inboxes.servers(account).map(server => serverPermissions.decorate({...server,members:server.members.map(person=>({...person,activeIdentity:proxies.variants.memberPersona(person.id)}))}, account));

  function generatedDocument(body, format) {
    return body.length > documentThreshold && !emojiCounts(format).size && documentInfo(body, format?.language);
  }

  async function sendMessage(response, conversationId, accountId, message, format, file, attached = false, editId = null, keep = false) {
    const targetId = editId ? null : message.replyTo;
    if (targetId != null && (!Number.isSafeInteger(targetId) || targetId < 1)) {
      return json(response, 400, { error: 'Invalid reply target.' });
    }
    const packed = file && await packDocument(file);
    if (!mayReadConversation(conversationId, accountId)) return json(response, 404, { error: 'Conversation not found.' });
    const broadcast = broadcasts.isChannel(conversationId);
    if (broadcast && accountId !== broadcasts.ownerId) return json(response, 403, { error: 'This chat is read-only.' });
    const policy = serverPermissions.channelActions(conversationId, accountId);
    if (policy && (!policy.canSend || (attached && file && !policy.canAttach))) {
      return json(response, 403, { error: 'You do not have permission to send this message.' });
    }
    const forumError = forums.validate(conversationId, message, editId);
    if (forumError) return json(response, 400, { error: forumError });
    const now = Date.now();
    if (!editId && count.get(accountId, now - 10_000).n >= 15) {
      return json(response, 429, { error: 'Too many messages. Try again in a few seconds.' });
    }
    const original = editId && editable.get(conversationId, editId, accountId);
    if (editId && !original) return json(response, 404, { error: 'Message not found.' });
    const previous = keep && JSON.parse(original.format);
    if (keep && previous?.kind !== 'document') {
      return json(response, 409, { error: 'This attachment is no longer available.' });
    }
    let body = message.body;
    let storedFormat = format;
    if (file || keep) {
      const metadata = keep ? { ...previous } : {
        kind: 'document', name: file.name, language: file.language, bytes: file.body.length,
        mime: file.mime, thumbnail: file.thumbnail ? true : undefined, chunkBytes: packed.chunkBytes,
      };
      if (file && (editId || /^(audio|video)\//.test(file.mime || ''))) metadata.thumbnailRevision = randomBytes(8).toString('hex');
      if (!attached) metadata.generated = true;
      else if (!keep && metadata.name === documentInfo('', metadata.language).name) metadata.generated = false;
      metadata.align = keep ? message.attachmentAlign : file.align;
      body = attached && body.trim() ? body : '';
      metadata.caption = body ? format || { kind: 'plain' } : undefined;
      storedFormat = metadata;
    }
    // Mark messages sent with explicit emoji references so literal shortcodes stay literal.
    const hasLiteralShortcode = /:[a-z0-9_]{2,32}:/i.test(body) || /:[a-z0-9_]{2,32}:/i.test(JSON.stringify(storedFormat));
    const stored = hasLiteralShortcode ? JSON.stringify({ ...(storedFormat || { kind: 'plain' }), emojiVersion: 1 })
      : storedFormat ? JSON.stringify(storedFormat) : null;
    const pair = peers(conversationId);
    let target;
    let broadcastRecipients;
    let sentId;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!mayReadConversation(conversationId, accountId) || (broadcast && accountId !== broadcasts.ownerId)) {
        db.exec('ROLLBACK');
        return json(response, 403, { error: 'You do not have permission to send this message.' });
      }
      if (!serverPermissions.emojiStore.mayUse(accountId, storedFormat, editId && JSON.parse(original.format))) {
        db.exec('ROLLBACK');
        return json(response, 403, { error: 'One or more custom emojis are unavailable for this message.' });
      }
      if (targetId != null && (!replyTarget.get(conversationId, targetId) ||
          (broadcast && !broadcasts.mayReadMessage(accountId, targetId)))) {
        db.exec('ROLLBACK');
        return json(response, 404, { error: 'The message you are replying to is unavailable.' });
      }
      let id = editId;
      if (id) {
        updateMessage.run(body, stored, id);
        forums.updateBody(id, message);
        if (!keep) documents.remove(id);
      } else {
        id = insertMessage(conversationId, accountId, { ...message, body }, stored, now);
      }
      if (file) documents.save(id, packed.parts, file.thumbnail);
      if (!editId) {
        sentId = Number(id);
        if (broadcast) broadcastRecipients = broadcasts.deliver(id);
        else target = inboxes.addUnread(pair, accountId, message.proxyId, conversationId, id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (broadcastRecipients) {
      for (const viewer of broadcastRecipients) notify(viewer, conversationId, sentId + ':0:announcement', 'incoming');
    } else if (editId || pair.first_proxy < 0) {
      for (const viewer of conversationViewers(conversationId)) notify(viewer, conversationId, editId, 'message-edited');
    } else {
      if (target?.[0] !== accountId) notify(accountId, conversationId);
      if (target) notify(target[0], conversationId, sentId + ':' + target[1], 'incoming');
    }
    if (!editId && format?.kind !== 'code') {
      for (const viewer of serverPermissions.mentionRecipients(conversationId, accountId, message.body + '\n' + (message.forumBody || ''), id => presenceState(id) === 'online')) {
        addMention.run(sentId, viewer, conversationId);
        notify(viewer, conversationId, sentId, 'role-mention');
      }
    }
    return editId ? json(response, 200, { updatedId: editId }) : json(response, 201, { sent: true });
  }

  function revoke(tokenHash, accountId) {
    deleteSession.run(tokenHash);
    for (const client of streams.get(accountId) || []) {
      if (client.tokenHash === tokenHash) client.response.end();
    }
  }

  function subscribe(response, accountId, tokenHash) {
    const clients = streams.get(accountId) || new Set();
    if (clients.size >= 8 || streamCount >= 256) {
      return json(response, 429, { error: 'Too many live connections.' });
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.write('event: ready\ndata: 1\n\n');
    const client = { response, tokenHash };
    presence.set(tokenHash, { state: 'online', at: Date.now() });
    clients.add(client);
    streams.set(accountId, clients);
    announcePresence(accountId);
    streamCount++;
    const heartbeat = setInterval(() => { if (!response.write(': heartbeat\n\n')) response.destroy(); }, 20_000);
    const recycle = setTimeout(() => response.end(), 5 * 60_000);
    response.once('close', () => {
      clearInterval(heartbeat);
      clearTimeout(recycle);
      clients.delete(client);
      if (![...clients].some(other => other.tokenHash === tokenHash)) presence.delete(tokenHash);
      streamCount--;
      if (!clients.size) streams.delete(accountId);
      announcePresence(accountId);
    });
  }

  function allowAuthAttempt(request, name, now = Date.now()) {
    for (const [key, entry] of authAttempts) if (entry.until <= now) authAttempts.delete(key);
    // The origin is accessible through Caddy, which supplies the forwarded address.
    const address = request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || request.socket.remoteAddress;
    const nameKey = 'name:' + name.toLowerCase();
    const addressKey = 'address:' + address;
    if (authInFlight >= 4 || authAttempts.size >= 4096 ||
        (authAttempts.get(nameKey)?.count || 0) >= 10 || (authAttempts.get(addressKey)?.count || 0) >= 40) {
      return false;
    }
    for (const key of [nameKey, addressKey]) {
      const entry = authAttempts.get(key) || { count: 0, until: now + 60_000 };
      entry.count++;
      authAttempts.set(key, entry);
    }
    return true;
  }

  async function verifyDevicePassword(request, account, password, session) {
    const name = account.username.split(':')[0];
    if (!validPassword(password) || !allowAuthAttempt(request, name)) return false;
    const current = accountsForName(name).find(row => row.id === account.id);
    if (!current) return false;
    authInFlight++;
    try {
      const candidate = await hashPassword(password, current.salt, 64, passwordOptions);
      return timingSafeEqual(candidate, Buffer.from(current.credential, 'hex')) &&
        sessionAccount.get(session, Date.now())?.id === account.id;
    } finally { authInFlight--; }
  }

  async function changePassword(request, response, account, tokenHash) {
    const input = await readJson(request, 4096);
    if (!validPassword(input?.currentPassword) || !validPassword(input?.newPassword)) {
      return json(response, 400, { error: 'Use passwords of at least 5 characters and up to 512 bytes.' });
    }
    const name = account.username.split(':')[0];
    if (!allowAuthAttempt(request, name)) {
      return json(response, 429, { error: 'Too many attempts. Try again in a minute.' });
    }
    const before = accountsForName(name);
    const current = before.find(row => row.id === account.id);
    if (!current) return json(response, 404, { error: 'Account not found.' });
    authInFlight++;
    try {
      const oldCredential = await hashPassword(input.currentPassword, current.salt, 64, passwordOptions);
      if (!timingSafeEqual(oldCredential, Buffer.from(current.credential, 'hex'))) {
        return json(response, 400, { error: 'Current password is incorrect.' });
      }
      const result = await replacePassword(before, current, input.newPassword, tokenHash);
      if (result.error) return json(response, 409, { error: result.error });
      for (const client of streams.get(account.id) || []) {
        if (client.tokenHash !== tokenHash) client.response.end();
      }
      return json(response, 200, { changed: true });
    } finally {
      authInFlight--;
    }
  }

  async function replacePassword(before, current, password, tokenHash, expectedRecovery = null) {
    const derived = new Map();
    for (const row of before) {
      if (!derived.has(row.salt)) derived.set(row.salt, await hashPassword(password, row.salt, 64, passwordOptions));
      if (timingSafeEqual(derived.get(row.salt), Buffer.from(row.credential, 'hex'))) {
        return { error: row.id === current.id ? 'Choose a new password.' : 'Choose a different password for this username.' };
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const latest = accountsForName(current.username.split(':')[0]);
      const authorized = expectedRecovery
        ? recoveryHash.get(current.id)?.hash === expectedRecovery
        : sessionAccount.get(tokenHash, Date.now())?.id === current.id;
      if (!sameCredentials(before, latest) || !authorized) {
        db.exec('ROLLBACK');
        return { error: 'The account changed. Try again.' };
      }
      changeCredential.run(derived.get(current.salt).toString('hex'), current.id);
      removeOtherSessions.run(current.id, expectedRecovery ? '' : tokenHash);
      const recoveryCode = expectedRecovery ? issueRecovery(current.id) : undefined;
      db.exec('COMMIT');
      return { recoveryCode };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function recoverAccount(request, response, tokenHash, viewer) {
    const input = await readJson(request, 4096);
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    const code = typeof input?.code === 'string' ? input.code.trim() : '';
    if (!(usernamePattern.test(username) || handlePattern.test(username)) ||
        !recoveryPattern.test(code) || !validPassword(input?.newPassword)) {
      return json(response, 400, { error: 'Enter your username, 16-character recovery code, and a new password.' });
    }
    const name = username.split(':')[0];
    if (!allowAuthAttempt(request, name)) return json(response, 429, { error: 'Too many attempts. Try again in a minute.' });
    const hash = digest(code);
    const current = recoveryByHash.get(hash);
    const expectedName = username.includes(':') ? current?.username : current?.username.split(':')[0];
    if (expectedName?.toLowerCase() !== username.toLowerCase()) {
      return json(response, 400, { error: 'Username or recovery code is incorrect.' });
    }
    authInFlight++;
    try {
      const result = await replacePassword(accountsForName(name), current, input.newPassword, tokenHash, hash);
      if (result.error) return json(response, 409, { error: result.error });
      for (const client of streams.get(current.id) || []) client.response.end();
      return startSession(response, current, tokenHash, viewer, 200, result.recoveryCode);
    } finally {
      authInFlight--;
    }
  }

  async function regenerateRecovery(request, response, account, tokenHash) {
    const input = await readJson(request, 4096);
    if (!validPassword(input?.password)) return json(response, 400, { error: 'Enter your current password.' });
    if (!allowAuthAttempt(request, account.username.split(':')[0])) {
      return json(response, 429, { error: 'Too many attempts. Try again in a minute.' });
    }
    const current = accountByName.get(account.username);
    authInFlight++;
    try {
      const credential = await hashPassword(input.password, current.salt, 64, passwordOptions);
      if (!timingSafeEqual(credential, Buffer.from(current.credential, 'hex'))) {
        return json(response, 400, { error: 'Current password is incorrect.' });
      }
      if (accountByName.get(account.username)?.credential !== current.credential || !sessionAccount.get(tokenHash, Date.now())) {
        return json(response, 409, { error: 'The account changed. Try again.' });
      }
      return json(response, 200, { recoveryCode: issueRecovery(account.id) });
    } finally {
      authInFlight--;
    }
  }

  async function authenticate(request, response, route, input, tokenHash, current) {
    const registering = route === 'register';
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const preferredTag = input.tag ?? '';
    const bareName = usernamePattern.test(username);
    const password = input.password;
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!(bareName || (!registering && handlePattern.test(username))) || !validPassword(password) || displayName.length > 40) {
      return json(response, 400, { error: registering
        ? 'Use a 3–24 character username and a passphrase of at least 5 characters.'
        : 'Enter your username and a passphrase of at least 5 characters.' });
    }
    if (registering && displayName && sharesLoginName(displayName, username)) {
      return json(response, 400, { error: 'Choose a display name different from your sign-in username.' });
    }
    if (registering && preferredTag !== '' && (typeof preferredTag !== 'string' || !tagPattern.test(preferredTag))) {
      return json(response, 400, { error: 'Enter four letters or digits for your tag.' });
    }
    const now = Date.now();
    const name = username.split(':')[0];
    if (!allowAuthAttempt(request, name, now)) {
      return json(response, 429, { error: 'Too many attempts. Try again in a minute.' });
    }

    const candidates = bareName
      ? accountsForName(name)
      : [accountByName.get(username)].filter(Boolean);
    let account;
    let recoveryCode;
    authInFlight++;
    try {
      const credentials = new Map();
      async function derive(salt) {
        if (!credentials.has(salt)) {
          credentials.set(salt, await hashPassword(password, salt, 64, passwordOptions));
        }
        return credentials.get(salt);
      }
      const matches = [];
      if (!candidates.length && !registering) {
        await derive(timingSalt);
      }
      for (const candidate of candidates) {
        const credential = await derive(candidate.salt);
        if (timingSafeEqual(credential, Buffer.from(candidate.credential, 'hex'))) matches.push(candidate);
      }
      if (registering) {
        if (matches.length) {
          return json(response, 409, { error: 'Choose a different passphrase for this username.' });
        }
        // Accounts with the same name share a salt so sign-in can check their
        // credentials with one derivation. Older account salts still work.
        const salt = candidates.find(candidate => candidate.salt.startsWith('name:'))?.salt
          || 'name:' + randomBytes(16).toString('hex');
        const result = registerAccount(name, preferredTag.toUpperCase(), displayName, salt, await derive(salt), candidates);
        if (result.error) return json(response, 409, { error: result.error });
        ({ account, recoveryCode } = result);
        for(const server of db.prepare('SELECT server_id AS id FROM default_server_memberships').all())notifyServer(server.id);
      } else {
        if (matches.length !== 1) {
          return json(response, 401, { error: matches.length
            ? 'More than one account matches. Sign in with your username and its sign-in suffix.'
            : 'Username or passphrase is incorrect.' });
        }
        [account] = matches;
        if (accountByName.get(account.username)?.credential !== account.credential) {
          return json(response, 401, { error: 'Username or passphrase is incorrect.' });
        }
      }
    } finally {
      authInFlight--;
    }
    return startSession(response, account, tokenHash, current, registering ? 201 : 200, recoveryCode);
  }

  function startSession(response, account, tokenHash, current, status, recoveryCode) {
    if (tokenHash) revoke(tokenHash, current?.id);
    const now = Date.now();
    purge.run(now);
    const token = randomBytes(32).toString('hex');
    createSession.run(digest(token), account.id, now + sessionSeconds * 1000);
    setCookie(response, token, sessionSeconds);
    return json(response, status, {
      recoveryCode,
      account: { id: account.id, username: account.username, displayName: account.display_name, publicTag: account.public_tag,
        bio: account.bio, avatarUrl: account.avatar_url, bannerUrl: account.banner_url,
        status: account.status_text, joinedAt: account.joined_at },
    });
  }

  return async (request, response, url) => {
    if (!url.pathname.startsWith(prefix)) return json(response, 404, { error: 'Page not found.' });
    const route = url.pathname.slice(prefix.length);
    const method = request.method;
    const cookie = /(?:^|;\s*)horizon_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const tokenHash = cookie && digest(cookie);
    const account = tokenHash ? sessionAccount.get(tokenHash, Date.now()) : null;
    if (route === 'session' && method === 'GET') return json(response, 200, { account: account || null });
    if (method === 'POST' && request.headers['x-horizon-chat'] !== '1') {
      return json(response, 403, { error: 'Reload Horizon Chat and try again.' });
    }
    if (route === 'recover' && method === 'POST') return recoverAccount(request, response, tokenHash, account);
    const isAuth = method === 'POST' && ['register', 'login'].includes(route);
    if (!account && !isAuth) return json(response, 401, { error: 'Sign in to continue.' });
    if (route.startsWith('peers/') && method === 'POST') {
      if (!allowAttachmentPeers) return json(response, 404, { error: 'Peer attachments are disabled.' });
      const input = await readJson(request, 32 * 1024);
      const result = attachmentPeers(route.slice('peers/'.length), input, account.id, tokenHash);
      return json(response, result.status, result.data);
    }
    if (route.startsWith('recovery-archive/')) return recoveryArchive(request, response, route, account.id, tokenHash);
    if (route === 'hosted-archives' || route.startsWith('hosted-archives/')) {
      return hostedArchives(request, response, route.slice('hosted-archives'.length), account.id);
    }
    if (route === 'trusted-devices' || route.startsWith('trusted-devices/')) {
      return trustedDevices(request, response, route.slice('trusted-devices'.length), account, tokenHash);
    }
    if (route === 'chat-image-formats' && method === 'GET') return json(response, 200, { formats: ['avif', 'webp'] });
    if (method === 'GET' && route.startsWith('emoji-art/')) {
      if (serverPermissions.emojiStore.serve(route.slice('emoji-art/'.length), request, response)) return;
      return json(response, 404, { error: 'Emoji artwork not found.' });
    }
    if (method === 'GET' && url.pathname.startsWith(mediaPath)) {
      if (media.serve(url.pathname.slice(mediaPath.length), response)) return;
      return json(response, 404, { error: 'Image not found.' });
    }
    if (route === 'recovery-code' && method === 'POST') return regenerateRecovery(request, response, account, tokenHash);
    if (route === 'password' && method === 'POST') return changePassword(request, response, account, tokenHash);
    if(route==='platform-status'&&method==='GET')return json(response,200,configuredRestartStatus());
    if(route==='profile-themes'&&method==='GET'){
      const peers=new Set([account.id,...presencePeers.all({account:account.id}).map(person=>person.id)]),lookup=db.prepare('SELECT theme FROM account_themes WHERE account_id=?');
      return json(response,200,{themes:[...peers].map(id=>({id,theme:lookup.get(id)?.theme||'horizon'}))});
    }
    const themeRoute=/^profile-theme(?:\/([1-9]\d{0,14}))?$/.exec(route);
    if(themeRoute&&method==='GET'){const owner=Number(themeRoute[1]||account.id);return json(response,200,{theme:db.prepare('SELECT theme FROM account_themes WHERE account_id=?').get(owner)?.theme||null});}
    if(route==='profile-theme'&&method==='POST'){
      const data=await readJson(request,512);if(!['horizon','basic-light','basic-mid','basic-dark','vanilla','sage','cinnamon','lavender','nutmeg','clove','d2-steel','burnt-titanium'].includes(data?.theme))return json(response,400,{error:'Choose an available theme.'});
      db.prepare('INSERT INTO account_themes VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET theme=excluded.theme').run(account.id,data.theme);for(const owner of new Set([account.id,...presencePeers.all({account:account.id}).map(p=>p.id)]))notify(owner,account.id,data.theme,'profile-theme');return json(response,200,{theme:data.theme});
    }
    if (route === 'profile' && method === 'POST') {
      const data = await readJson(request, 650_000);
      const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
      const status = data?.status ?? account.status;
      if (!displayName || displayName.length > 40 || typeof data.bio !== 'string' || data.bio.length > 500) {
        return json(response, 400, { error: 'Enter a display name up to 40 characters and a bio up to 500 characters.' });
      }
      if (typeof status !== 'string' || status.length > 120) {
        return json(response, 400, { error: 'Keep your status within 120 characters.' });
      }
      if (sharesLoginName(displayName, account.username)) {
        return json(response, 400, { error: 'Choose a display name different from your sign-in username.' });
      }
      const bio = data.bio.trim();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = sessionAccount.get(tokenHash, Date.now());
        if (!current) {
          db.exec('ROLLBACK');
          return json(response, 401, { error: 'Sign in to continue.' });
        }
        const [key, publicTag] = publicHandles.allocate(displayName, current.publicTag, current.id);
        const images = media.update(data, current);
        if (images.error) {
          db.exec('ROLLBACK');
          return json(response, 400, { error: images.error });
        }
        updateProfile.run(displayName, bio, images.avatarUrl, images.bannerUrl, status.trim(), key, publicTag, current.id);
        notifyProfileUpdate(account.id);
        db.exec('COMMIT');
        return json(response, 200, { account: { ...current, displayName, publicTag, bio, status: status.trim(), ...images } });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    if (route === 'proxies' && method === 'GET') {
      return json(response, 200, { proxies: proxies.list(account.id) });
    }
    if(route==='persona'&&method==='POST'){
      const input=await readJson(request,1024);
      if(!Number.isSafeInteger(input?.proxyId)||input.proxyId<0||!Number.isSafeInteger(input?.variantId)||input.variantId<0)return json(response,400,{error:'Choose a valid character and variant.'});
      const result=proxies.variants.selectPersona(account.id,input.proxyId,input.variantId);
      if(result.error)return json(response,result.status,result);
      notifyMemberPersona(account.id);return json(response,200,{selected:true});
    }
    const variantRoute=/^proxies\/([1-9]\d{0,14})\/variants$/.exec(route);
    if(variantRoute && method==='POST') {
      const data=await readJson(request,1000000);
      const result=proxies.variants.change(account.id,Number(variantRoute[1]),data?.action,data);
      if(result.error)return json(response,result.status,result);
      if(data.action==='save'||data.action==='delete'){notifyProfileUpdate(account.id,Number(variantRoute[1]));notifyMemberPersona(account.id);}
      notify(account.id,account.id,'state','persona-state');
      const list=proxies.list(account.id);
      return json(response,200,{...result,proxy:list.find(p=>p.id===Number(variantRoute[1])),proxies:list});
    }
    const proxyAction = /^proxies\/([1-9][0-9]{0,14})(\/delete)?$/.exec(route);
    if (method === 'POST' && (route === 'proxies' || proxyAction)) {
      const id = proxyAction ? Number(proxyAction[1]) : null;
      const result = proxyAction?.[2]
        ? proxies.delete(account.id, id)
        : proxies.save(account.id, id, await readJson(request, 650_000));
      if(!result.error&&id!==null&&!proxyAction?.[2]){notifyProfileUpdate(account.id,id);notifyMemberPersona(account.id);}
      return json(response, result.status || (id === null ? 201 : 200), result);
    }
    if (route === 'proxies/import' && method === 'POST') {
      const data = await readJson(request, 1_048_576);
      if (!data) return json(response, 400, { error: 'Choose a valid Tupperbox JSON file under 1 MB.' });
      const result = proxies.import(account.id, data);
      return json(response, result.error ? 400 : 200, result);
    }
    if (route === 'logout' && method === 'POST') {
      revoke(tokenHash, account.id);
      setCookie(response, '', 0);
      return json(response, 200, { account: null });
    }
    const passwordRoute=/^conversations\/([1-9]\d{0,14})\/(password|unlock)$/.exec(route);
    if(passwordRoute && method==='POST') {
      const conversation=Number(passwordRoute[1]);
      if(!serverPermissions.visible(conversation,account.id)||!serverPermissions.channel(conversation))return json(response,404,{error:'Channel not found.'});
      const input=await readJson(request,2048);
      const result=passwordRoute[2]==='password'?await channelPasswords.change(tokenHash,conversation,account.id,input):await channelPasswords.unlock(tokenHash,conversation,account.id,input);
      if(result.error)return json(response,result.status,result);
      if(passwordRoute[2]==='password')notifyServer(serverPermissions.channel(conversation).serverId);else notify(account.id);
      return json(response,200,{...channelPasswords.info(tokenHash,conversation,account.id)});
    }
    const protectedRoute=/^conversations\/([1-9]\d{0,14})(?:\/|$)/.exec(route);
    if(protectedRoute && serverPermissions.channel(Number(protectedRoute[1])) && !channelPasswords.allowed(tokenHash,Number(protectedRoute[1]),account.id)) {
      if(!serverPermissions.visible(Number(protectedRoute[1]),account.id))return json(response,404,{error:'Channel not found.'});
      request.resume();
      return json(response,423,{error:'Enter this channel’s password to view or interact with it.',passwordRequired:true});
    }
    if(route==='typing-preference'&&['GET','POST'].includes(method)){
      if(method==='POST'){const input=await readJson(request,512);if(typeof input?.enabled!=='boolean')return json(response,400,{error:'Choose whether to share typing activity.'});typing.preference(account.id,input.enabled);}
      return json(response,200,{enabled:typing.enabled(account.id)});
    }
    const typingRoute=/^conversations\/([1-9]\d{0,14})\/typing$/.exec(route);
    if(typingRoute&&['GET','POST'].includes(method)){
      const conversation=Number(typingRoute[1]);if(!mayReadConversation(conversation,account.id))return json(response,404,{error:'Conversation not found.'});
      if(broadcasts.isChannel(conversation))return json(response,200,{people:[]});
      const input=method==='POST'?await readJson(request,2048):{},postId=method==='GET'?Number(url.searchParams.get('postId')||0):input.postId||0;
      if(!Number.isSafeInteger(postId)||postId<0||postId&&!forums.hasPost(conversation,postId))return json(response,400,{error:'Forum post not found.'});
      if(method==='POST'){
        if(typeof input.active!=='boolean')return json(response,400,{error:'Invalid typing state.'});
        if(!input.active){typing.stop(account.id,tokenHash,conversation,postId||null);return json(response,200,{ok:true});}
        const policy=serverPermissions.channelActions(conversation,account.id);if(policy&&!policy.canSend)return json(response,403,{error:'This channel is read-only.'});
        const speaker=resolveSpeaker(conversation,account.id,{...input,body:''},null,{triggers:false});if(speaker.error)return json(response,400,{error:speaker.error});
        typing.update(account.id,tokenHash,conversation,postId||null,speaker.persona?.displayName||account.displayName,true);
        return json(response,200,{ok:true});
      }
      return json(response,200,{conversationId:conversation,postId:postId||null,people:typing.list(conversation,postId||null,account.id)});
    }
    if (route === 'presence' && ['GET', 'POST'].includes(method)) {
      if (method === 'POST') {
        const input = await readJson(request, 1024);
        if (!['online','away'].includes(input?.state)) return json(response,400,{error:'Choose online or away.'});
        const previous = presenceState(account.id);
        presence.set(tokenHash,{state:input.state,at:Date.now()});
        if (previous !== presenceState(account.id)) announcePresence(account.id);
      }
      return json(response,200,{presence:presencePeers.all({account:account.id}).map(person=>({id:person.id,state:presenceState(person.id)}))});
    }
    if (route === 'mentions' && method === 'GET') return json(response,200,{mentions:unreadMentions.all(account.id).filter(item=>mayReadConversation(item.conversationId,account.id))});
    if (route === 'mentions/read' && method === 'POST') {
      const input = await readJson(request,1024);
      if (!Number.isSafeInteger(input?.conversationId) || !mayReadConversation(input.conversationId,account.id)) return json(response,404,{error:'Conversation unavailable.'});
      clearMentions.run(account.id,input.conversationId); return json(response,200,{read:true});
    }
    if (route === 'events' && method === 'GET') return subscribe(response, account.id, tokenHash);
    if (route === 'servers' && method === 'POST') {
      const data = await readJson(request, 320_000);
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      if (!name || name.length > 80) return json(response, 400, { error: 'Enter a server name up to 80 characters.' });
      const icon = media.update({ avatar: data.icon }, {});
      if (icon.error) return json(response, 400, { error: icon.error });
      const server = inboxes.createServer(account.id, name, icon.avatarUrl, randomBytes(9).toString('base64url'));
      serverPermissions.seed(server.id, server.conversationId);
      serverPermissions.audit(server.id, account.id, 'Created server', name);
      notifyServer(server.id);
      return json(response, 201, { server: serverPermissions.decorate(server, account.id) });
    }
    if (route === 'servers/join' && method === 'POST') {
      const data = await readJson(request, 512);
      const code = typeof data?.code === 'string' ? data.code.trim() : '';
      if (!/^[a-zA-Z0-9_-]{12}$/.test(code)) return json(response, 404, { error: 'Invite code not found.' });
      const joinedServer = inboxes.joinServer(account.id, code);
      if (!joinedServer) return json(response, 404, { error: 'Invite code not found.' });
      const { id, joined } = joinedServer;
      serverPermissions.clearInvite(id, account.id);
      if (joined) serverPermissions.audit(id, account.id, 'Joined with invite code');
      const server = serversFor(account.id).find(item => item.id === id);
      notifyServer(id);
      return json(response, 200, { server });
    }
    const auditRoute = /^servers\/([1-9]\d{0,14})\/audit$/.exec(route);
    if (auditRoute && method === 'GET') {
      const before = url.searchParams.get('before');
      if (before !== null && !/^[1-9]\d{0,14}$/.test(before)) return json(response, 400, { error: 'Invalid activity log cursor.' });
      const result = serverPermissions.history(Number(auditRoute[1]), account.id, before ? Number(before) : Number.MAX_SAFE_INTEGER);
      return json(response, result.status || 200, result);
    }
    const serverAction = /^servers\/([1-9]\d{0,14})\/(roles|channels|members|invite|kick|leave|delete|profile|emojis)(?:\/([1-9]\d{0,14}))?$/.exec(route);
    if (serverAction && method === 'POST') {
      const server = Number(serverAction[1]);
      const id = serverAction[3] ? Number(serverAction[3]) : null;
      if (serverAction[2] === 'profile' && !serverPermissions.canEditProfile(server, account.id)) {
        request.resume();
        return json(response, 403, { error: 'Only server administrators can change server settings.' });
      }
      const data = await readJson(request, serverAction[2] === 'profile' ? 650_000 : serverAction[2] === 'emojis' ? 320_000 : 8192);
      if (!data) return json(response, 400, { error: 'Invalid server settings.' });
      let result;
      switch (serverAction[2]) {
        case 'roles': result = serverPermissions.editRole(server, account.id, id, data, Boolean(id && data.remove)); break;
        case 'channels': result = serverPermissions.editChannel(server, account.id, id, data, Boolean(id && data.remove)); if(!id&&result.channelId)channelPasswords.creator(result.channelId,account.id); break;
        case 'members': result = serverPermissions.assignRoles(server, account.id, id, data); break;
        case 'kick': result = serverPermissions.kick(server, account.id, id); break;
        case 'leave': result = id === null ? serverPermissions.leave(server, account.id) : { status: 404, error: 'Page not found.' }; break;
        case 'delete': result = serverPermissions.removeServer(server, account.id, data.name); break;
        case 'emojis': result = serverPermissions.editEmoji(server, account.id, data); break;
        case 'profile': result = serverPermissions.editServer(server, account.id, data, media); break;
        case 'invite':
          if (data.proxyId != null && data.proxyId !== 0 &&
              (!Number.isSafeInteger(data.proxyId) || !proxies.list(account.id).some(proxy => proxy.id === data.proxyId))) {
            result = { status: 400, error: 'That character is unavailable.' };
          } else result = serverPermissions.invite(server, account.id, data.recipientId, invite => deliverInvite(invite, data.proxyId || 0));
          break;
      }
      if (result.error) return json(response, result.status, { error: result.error });
      if (serverAction[2] === 'invite') {
        notify(data.recipientId, result.inviteConversation, result.inviteMessage + ':0', 'incoming');
        notify(account.id, result.inviteConversation);
      }
      else if (serverAction[2] === 'leave') {
        for (const viewer of new Set([account.id, ...result.recipients])) notify(viewer, 0, 'updated', 'server-update');
        notifyServer(server);
        return json(response, 200, { left: true });
      } else if (serverAction[2] === 'delete') {
        for (const viewer of result.viewers) notify(viewer, 0, 'updated', 'server-update');
        return json(response, 200, { deleted: true });
      } else {
        if (serverAction[2] === 'kick') notify(id, 0, 'updated', 'server-update');
        notifyServer(server);
      }
      return json(response, 200, result);
    }
    const inviteAction = /^server-invites\/([1-9]\d{0,14})$/.exec(route);
    if (inviteAction && method === 'POST') {
      const data = await readJson(request, 512);
      if (typeof data?.accept !== 'boolean') return json(response, 400, { error: 'Choose whether to accept the invite.' });
      const card = db.prepare('SELECT m.conversation_id AS conversation, m.id FROM server_invite_messages i JOIN direct_messages m ON m.id = i.message_id WHERE i.invite_id = ?').get(Number(inviteAction[1]));
      const result = serverPermissions.answerInvite(Number(inviteAction[1]), account.id, data.accept);
      if (result.error) return json(response, result.status, { error: result.error });
      if (card) for (const viewer of conversationViewers(card.conversation)) {
        notify(viewer, card.conversation, card.id, 'message-edited');
      }
      if (data.accept) notifyServer(result.serverId);
      else notify(account.id, 0, 'invite', 'server-update');
      return json(response, 200, { server: data.accept ? serversFor(account.id).find(item => item.id === result.serverId) : null });
    }
    if (route === 'server-layout' && method === 'POST') {
      const data = await readJson(request, 2_100_000);
      const result = serverLayouts.save(account.id, data?.layout);
      if (result.error) return json(response, result.status, result);
      notify(account.id, 0, 'updated', 'server-update');
      return json(response, 200, result);
    }
    if (route === 'contacts' && method === 'POST') {
      const data = await readJson(request, 512);
      if (data?.remove === true && Number.isSafeInteger(data.contactId) && data.contactId > 0) {
        removeContact.run(account.id, data.contactId);
      } else {
        const person = publicHandles.find(data?.handle);
        if (!person || person.id === account.id || person.id === broadcasts.ownerId) return json(response, 404, { error: 'Enter another member’s display name and four-character tag.' });
        addContact.run(account.id, person.id);
      }
      notify(account.id, 0, 'contacts', 'contacts-update');
      return json(response, 200, { contacts: contacts.all(account.id, broadcasts.ownerId) });
    }
    if (route === 'conversations' && method === 'GET') {
      const ownerId = broadcasts.ownerId;
      const direct = inboxes.list(account.id).filter(thread => broadcasts.directAllowed(thread.id, account.id, thread.peerId, ownerId)).map(thread=>{const profile=thread.proxyId&&proxies.variants.publicProfile(thread.proxyId);return profile?{...thread,displayName:profile.name,bio:profile.description,status:profile.status,avatarUrl:profile.avatarUrl,bannerUrl:profile.bannerUrl,fullBodyUrl:profile.fullBodyUrl,designation:profile.designation,variantId:profile.variantId,variantName:profile.variantName}:thread;});
      const conversations = [...broadcasts.list(account.id), ...direct]
        .sort((a, b) => Number(Boolean(b.broadcastWriter)) - Number(Boolean(a.broadcastWriter)) ||
          (b.lastMessageId || 0) - (a.lastMessageId || 0) || b.id - a.id);
      return json(response, 200, { conversations, proxies: proxies.list(account.id),
        serverLayout: serverLayouts.get(account.id), broadcastOwnerId: ownerId, servers: serversFor(account.id).map(server=>({...server,channels:server.channels.map(channel=>({...channel,...channelPasswords.info(tokenHash,channel.conversationId,account.id)}))})), contacts: contacts.all(account.id, ownerId) });
    }
    const timelineRoute = /^conversations\/([1-9]\d{0,14})\/timeline$/.exec(route);
    if (timelineRoute) {
      const conversation = Number(timelineRoute[1]);
      const channel = serverPermissions.channel(conversation);
      if (channel?.kind !== 'timeline' || !serverPermissions.visible(conversation, account.id)) {
        return json(response, 404, { error: 'Timeline channel not found.' });
      }
      const policy = () => {
        const manage = serverPermissions.canManageChannels(channel.serverId, account.id);
        return { id: channel.id, account: account.id, manage,
          create: manage || serverPermissions.channelActions(conversation, account.id)?.canSend };
      };
      if (method === 'GET') return json(response, 200, timelines.view(policy()));
      if (method !== 'POST') return json(response, 404, { error: 'Page not found.' });
      const data = await readJson(request, 32_768);
      if (!data) return json(response, 400, { error: 'Invalid timeline data.' });
      if (serverPermissions.channel(conversation)?.kind !== 'timeline' || !serverPermissions.visible(conversation, account.id)) {
        return json(response, 404, { error: 'Timeline channel not found.' });
      }
      const result = timelines.change(policy(), data);
      if (result.error) return json(response, result.status, result);
      for (const viewer of conversationViewers(conversation)) notify(viewer, conversation, 'updated', 'timeline-update');
      return json(response, 200, result);
    }
    const mapRoute = /^conversations\/([1-9]\d{0,14})\/map(?:\/image\/(background|[1-9]\d{0,14}))?$/.exec(route);
    if (mapRoute) {
      const conversation = Number(mapRoute[1]);
      function mapPolicy() {
        const channel = serverPermissions.channel(conversation);
        if (channel?.kind !== 'map' || !serverPermissions.visible(conversation, account.id)) return null;
        const manage = serverPermissions.canManageChannels(channel.serverId, account.id);
        const linkExists = id => {
          const linked = id !== conversation && serverPermissions.channel(id);
          return linked?.serverId === channel.serverId && linked.kind !== 'separator';
        };
        return { channel: { ...channel, conversationId: conversation }, viewer: account.id, manage,
          create: manage || serverPermissions.channelActions(conversation, account.id).canSend,
          linkExists, canLink: id => linkExists(id) && serverPermissions.visible(id, account.id) };
      }
      let policy = mapPolicy();
      if (!policy) return json(response, 404, { error: 'Map channel not found.' });
      if (method === 'GET') {
        if (!mapRoute[2]) return json(response, 200, channelMaps.view(policy));
        if (channelMaps.serve(policy.channel.id, mapRoute[2], response)) return;
        return json(response, 404, { error: 'Map image not found.' });
      }
      if (method !== 'POST' || mapRoute[2]) return json(response, 404, { error: 'Page not found.' });
      if (!policy.create) {
        request.resume();
        return json(response, 403, { error: 'You cannot edit this map.' });
      }
      const data = await readJson(request, backgroundJsonLimit);
      if (!data) return json(response, 400, { error: 'Invalid map data.' });
      policy = mapPolicy();
      if (!policy) return json(response, 404, { error: 'Map channel not found.' });
      const result = channelMaps.update(policy, data);
      if (result.error) return json(response, result.status, result);
      for (const viewer of conversationViewers(conversation)) notify(viewer, conversation, 'updated', 'map-update');
      return json(response, 200, result);
    }
    const forumRoute = /^conversations\/([1-9]\d{0,14})\/forum(?:\/([1-9]\d{0,14})(?:\/(vote))?)?$/.exec(route);
    if (forumRoute) {
      const conversation = Number(forumRoute[1]);
      if (!mayReadConversation(conversation, account.id) || !forums.isForum(conversation)) return json(response, 404, { error: 'Forum not found.' });
      const id = forumRoute[2] && Number(forumRoute[2]);
      if (method === 'GET' && !forumRoute[3]) {
        if (id) {
          const post = forums.detail(conversation, account.id, id);
          return post ? json(response, 200, { post }) : json(response, 404, { error: 'Forum post not found.' });
        }
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return json(response, 400, { error: 'Invalid forum page.' });
        return json(response, 200, forums.list(conversation, account.id, offset));
      }
      if (method === 'POST' && id && !forumRoute[3]) {
        if (!serverPermissions.channelActions(conversation, account.id)?.canSend) return json(response, 403, { error: 'This forum is read-only.' });
        const result = forums.prepareEdit(conversation, id, await readJson(request, 650000));
        if (result.error) return json(response, result.status, result);
        const original = editable.get(conversation, id, account.id);
        if (!original) return json(response, 403, { error: 'You can only edit your own editable posts.' });
        const previous = JSON.parse(original.format);
        const keep = previous?.kind === 'document';
        const format = original.body === result.body ? keep ? previous.caption : previous : null;
        return sendMessage(response, conversation, account.id,
          { ...result, attachmentAlign: previous?.align }, format, null, keep, id, keep);
      }
      if (method === 'POST' && forumRoute[3] === 'vote') {
        if (!serverPermissions.channelActions(conversation, account.id)?.canSend) return json(response, 403, { error: 'This forum is read-only.' });
        const input = await readJson(request, 128);
        const result = forums.vote(conversation, account.id, id, input?.value);
        if (result.error) return json(response, result.status, result);
        for (const viewer of conversationViewers(conversation)) notify(viewer, conversation, id, 'forum-update');
        return json(response, 200, result);
      }
      return json(response, 404, { error: 'Page not found.' });
    }
    const diceRoute = /^conversations\/([1-9]\d{0,14})\/roll$/.exec(route);
    if (diceRoute && method === 'POST') {
      const conversation = Number(diceRoute[1]);
      const input = await readJson(request, 512);
      let roll;
      try { roll = rollDice(input || {}); }
      catch (error) { return json(response, 400, { error: error.message }); }
      if (!mayReadConversation(conversation, account.id)) return json(response, 404, { error: 'Conversation not found.' });
      const identity = resolveSpeaker(conversation, account.id, { ...input, body: '' }, null, { triggers: false });
      if (identity.error) return json(response, 400, { error: identity.error });
      const roller = identity.proxyId ? proxies.list(account.id).find(proxy => proxy.id === identity.proxyId)?.name : account.displayName;
      identity.body = (roller || account.displayName) + ' rolled ' + roll.expression + ' → ' + roll.total;
      return sendMessage(response, conversation, account.id, { ...identity, forumPostId: input.forumPostId },
        roll, null);
    }
    const closing = /^conversations\/([1-9]\d{0,14})\/close$/.exec(route);
    if (closing && method === 'POST') {
      const conversation = Number(closing[1]);
      const input = await readJson(request, 512);
      const closed = Number.isSafeInteger(input?.inboxProxyId) && (broadcasts.isChannel(conversation)
        ? broadcasts.close(account.id, input.inboxProxyId)
        : inboxes.close(account.id, conversation, input.inboxProxyId));
      if (!closed) {
        return json(response, 404, { error: 'Direct message not found.' });
      }
      notify(account.id, conversation, 'closed', 'inbox-read');
      return json(response, 200, { closed: true });
    }
    const reading = /^conversations\/([1-9]\d{0,14})\/read$/.exec(route);
    if (reading && method === 'POST') {
      const id = Number(reading[1]);
      if (!mayReadConversation(id, account.id)) return json(response, 404, { error: 'Conversation not found.' });
      const input = await readJson(request, 512);
      if (!Number.isSafeInteger(input?.inboxProxyId) || !Number.isSafeInteger(input.through) || input.through < 1) {
        return json(response, 400, { error: 'Invalid read position.' });
      }
      const read = broadcasts.isChannel(id)
        ? input.inboxProxyId === 0 && broadcasts.read(account.id, input.through)
        : inboxes.read(account.id, id, input.inboxProxyId, input.through);
      if (read) notify(account.id, id, input.inboxProxyId + ':read', 'inbox-read');
      return json(response, 200, { read: true });
    }
    const match = /^conversations\/([1-9]\d{0,14})\/messages(?:\/([1-9]\d{0,14})\/(document|thumbnail|delete|edit))?$/.exec(route);
    const conversationId = match && Number(match[1]);
    if (conversationId && !mayReadConversation(conversationId, account.id)) {
      return json(response, 404, { error: 'Conversation not found.' });
    }
    const broadcast = broadcasts.isChannel(conversationId);
    if (broadcast && account.id !== broadcasts.ownerId && method === 'POST') {
      request.resume();
      return json(response, 403, { error: 'This chat is read-only.' });
    }
    if (broadcast && match[2] && !broadcasts.mayReadMessage(account.id, Number(match[2]))) {
      return json(response, 404, { error: 'Message not found.' });
    }
    const recipientHistory = broadcast && account.id !== broadcasts.ownerId ? account.id : null;
    const forumPost = url.searchParams.get('postId');
    if (forumPost !== null && (!/^[1-9]\d{0,14}$/.test(forumPost) || !forums.hasPost(conversationId, Number(forumPost)))) return json(response, 404, { error: 'Forum post not found.' });
    const messageCursor = cursor => ({ conversation: conversationId, cursor, recipient: recipientHistory, forumPost: forumPost === null ? null : Number(forumPost) });
    const editId = match?.[3] === 'edit' ? Number(match[2]) : null;
    const channelPolicy = conversationId && serverPermissions.channelActions(conversationId, account.id);
    if (channelPolicy && method === 'POST' && (!match[2] || editId) &&
        (!channelPolicy.canSend || (request.headers['content-type'] === 'application/octet-stream' && !channelPolicy.canAttach))) {
      return json(response, 403, { error: 'You do not have permission to send this message.' });
    }
    if (editId) {
      const original = editable.get(conversationId, editId, account.id);
      if (!original) return json(response, 404, { error: 'Message not found.' });
      if (method === 'GET') {
        const message = history.get(messageCursor(editId + 1));
        const format = JSON.parse(original.format);
        const generated = format?.kind === 'document' && (format.generated ?? (
          !format.mime && !format.caption && format.name === documentInfo('', format.language).name));
        if (generated) {
          message.body = documents.readText(editId);
          message.format = format.language === 'plaintext' ? null : JSON.stringify({ kind: 'code', language: format.language });
        }
        return json(response, 200, { message });
      }
    }
    if (match?.[2] && !editId) {
      if (match[3] === 'delete') {
        const id = Number(match[2]);
        const viewers = broadcast ? conversationViewers(conversationId) : null;
        if (method !== 'POST' || !deleteMessage.run({
          conversation: conversationId, message: id, actor: account.id,
          moderator: Number(Boolean(channelPolicy?.canManageMessages)),
        }).changes) {
          return json(response, 404, { error: 'Message not found.' });
        }
        for (const viewer of viewers || conversationViewers(conversationId)) notify(viewer, conversationId, id, 'message-deleted');
        return json(response, 200, { deleted: true });
      }
      if (match[3] === 'thumbnail') {
        if (method === 'GET' && documents.thumbnail(conversationId, Number(match[2]), response)) return;
        return json(response, 404, { error: 'Thumbnail not found.' });
      }
      const offset = url.searchParams.get('offset') ?? '0';
      if (!/^\d{1,8}$/.test(offset)) return json(response, 400, { error: 'Invalid file offset.' });
      const gzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers['accept-encoding'] || '');
      if (method === 'GET' && documents.serve(conversationId, Number(match[2]), Number(offset), gzip, response,
        url.searchParams.get('encoding') === 'gzip', request.headers['x-horizon-cache-tag'], request.headers['x-horizon-cache-only'] === '1')) return;
      return json(response, 404, { error: 'File not found.' });
    }
    if (conversationId && method === 'GET' && !editId) {
      const cursor = url.searchParams.get('before');
      const after = url.searchParams.get('after');
      const at = url.searchParams.get('at');
      if (at !== null) {
        if (!/^[1-9]\d{0,14}$/.test(at)) return json(response, 400, { error: 'Invalid message ID.' });
        const item = history.get(messageCursor(Number(at) + 1));
        if (item?.id !== Number(at)) return json(response, 404, { error: 'Message not found.' });
        return json(response, 200, { message: item });
      }
      if ((cursor !== null && !/^[1-9]\d{0,14}$/.test(cursor)) ||
          (after !== null && !/^(0|[1-9]\d{0,14})$/.test(after)) || (cursor && after)) {
        return json(response, 400, { error: 'Invalid history cursor.' });
      }
      if (after) {
        const rows = catchUp.all(messageCursor(Number(after)));
        return json(response, 200, { messages: rows.slice(0, 50), hasNewer: rows.length > 50 });
      }
      const rows = history.all(messageCursor(cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER));
      return json(response, 200, { messages: rows.slice(0, 50).reverse(), hasOlder: rows.length > 50 });
    }
    if (method !== 'POST' || (!isAuth && route !== 'conversations' && !conversationId)) {
      return json(response, 404, { error: 'Page not found.' });
    }
    if (conversationId && request.headers['content-type'] === 'application/octet-stream') {
      const info = readFileInfo(request);
      if (!info) return json(response, 400, { error: 'Choose a file with a valid name.' });
      if (uploadsInFlight >= 3) {
        return json(response, 429, { error: 'Uploads are busy. Try again in a moment.' });
      }
      const metadataHeader = request.headers['x-horizon-message-bytes'];
      const metadataBytes = metadataHeader === undefined ? 0 : Number(metadataHeader);
      if (metadataHeader !== undefined && (!Number.isSafeInteger(metadataBytes) ||
          metadataBytes < 1 || metadataBytes > 1_300_000)) {
        return json(response, 400, { error: 'Invalid attachment message.' });
      }
      uploadsInFlight++;
      try {
        const payload = await readBody(request, fileLimit + metadataBytes);
        if (!payload || payload.length <= metadataBytes) {
          return json(response, 400, { error: 'Choose a file up to 10 MB.' });
        }
        const body = payload.subarray(metadataBytes);
        const proxyHeader = request.headers['x-horizon-proxy'];
        let input = { body: '', proxyId: proxyHeader === undefined ? null : Number(proxyHeader) };
        let format = null;
        if (metadataBytes) {
          try {
            input = JSON.parse(payload.toString('utf8', 0, metadataBytes));
            if (typeof input?.body !== 'string' || input.body.length > messageLimit) throw new Error();
            format = messageFormat(input, true);
          } catch {
            return json(response, 400, { error: 'Invalid attachment message or formatting.' });
          }
        }
        const speaker = resolveSpeaker(conversationId, account.id, input, format,
          { editing: Boolean(editId), attachment: true, triggers: Boolean(metadataBytes) });
        if (speaker.error) return json(response, 400, { error: speaker.error });
        const type = fileType(body, request.headers['x-horizon-thumbnail'], info.name);
        if (input.optimizedImage !== undefined &&
            (!['avif', 'webp'].includes(input.optimizedImage) || type.mime !== 'image/' + input.optimizedImage ||
            !info.name.toLowerCase().endsWith('.' + input.optimizedImage))) {
          return json(response, 400, { error: 'The optimized attachment format is invalid.' });
        }
        const align = ['center', 'right'].includes(input.attachmentAlign) ? input.attachmentAlign : undefined;
        return await sendMessage(response, conversationId, account.id, { ...speaker, replyTo: input.replyTo, forumPostId: input.forumPostId, forumBody: input.forumBody, forumFormat: input.forumFormat }, format, { ...info, ...type, body, align }, true, editId);
      } finally {
        uploadsInFlight--;
      }
    }
    const input = await readJson(request, conversationId ? 1_300_000 : 32_768);
    if (!input) return json(response, 400, { error: 'Invalid request or request too large.' });
    if (isAuth) return authenticate(request, response, route, input, tokenHash, account);
    if (route === 'conversations') {
      const recipientId = input.recipientId;
      let recipient;
      if (typeof input.handle === 'string') {
        const match = publicHandles.find(input.handle);
        if (recipientId === undefined || recipientId === match?.id) recipient = match?.id;
      } else if (Number.isSafeInteger(recipientId) && (input.recipientProxyId || hasContact.get(account.id, recipientId))) {
        recipient = recipientId;
      }
      const person = Number.isSafeInteger(recipient) && accountById.get(recipient);
      db.exec('BEGIN IMMEDIATE');
      let opened;
      try {
        const ownerId = broadcasts.ownerId;
        if (person && person.id !== ownerId) {
          opened = inboxes.open(account.id, input.inboxProxyId ?? 0, person.id, input.recipientProxyId ?? 0);
          if (opened && account.id === ownerId) broadcasts.allowDirect(opened.id, ownerId);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (!opened) return json(response, 404, { error: 'Recipient not found or unavailable from this inbox.' });
      return json(response, 200, opened);
    }
    const keep = Boolean(editId && input.keepAttachment === true);
    if (typeof input.body !== 'string' || (!keep && !input.body.trim()) || input.body.length > messageLimit) {
      return json(response, 400, { error: 'Enter a message of 1–100,000 characters.' });
    }
    let format;
    try {
      format = messageFormat(input, keep);
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
    if (editId) {
      const attachmentAlign = ['center', 'right'].includes(input.attachmentAlign) ? input.attachmentAlign : undefined;
      const file = !keep && generatedDocument(input.body, format);
      return sendMessage(response, conversationId, account.id, { body: input.body, attachmentAlign },
        format, file, keep, editId, keep);
    }
    const message = resolveSpeaker(conversationId, account.id, input, format);
    if (message.error) return json(response, 400, { error: message.error });
    if (message.reproxy) {
      if (input.replyTo != null) return json(response, 400, { error: 'Enter a reply after the character trigger.' });
      if (!mayReadConversation(conversationId, account.id) ||
          serverPermissions.channelActions(conversationId, account.id)?.canSend === false) {
        return json(response, 403, { error: 'You do not have permission to send this message.' });
      }
      const changed = reproxyLast.get(message.proxyId, account.id, conversationId);
      if (!changed) return json(response, 404, { error: 'Send a message before using a brackets-only trigger.' });
      proxies.variants.capture(changed.id,account.id,message.proxyId,message.persona);
      for (const viewer of conversationViewers(conversationId)) notify(viewer, conversationId, changed.id);
      return json(response, 200, { sent: true, updatedId: changed.id });
    }
    const file = generatedDocument(message.body, format);
    return sendMessage(response, conversationId, account.id, { ...message, replyTo: input.replyTo, forumPostId: input.forumPostId, forumBody: input.forumBody, forumFormat: input.forumFormat }, format, file);
  };
}

async function readJson(request, limit = 32_768) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return null;
  const body = await readBody(request, limit);
  if (!body) return null;
  try {
    const data = JSON.parse(body.toString());
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function readBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
