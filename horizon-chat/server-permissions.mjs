import { createEmojis } from './emojis.mjs';
import { mediaPath } from './profile-media.mjs';

export function createServerPermissions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_roles (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES chat_servers(id),
      name TEXT NOT NULL COLLATE NOCASE,
      can_invite INTEGER NOT NULL,
      can_manage_channels INTEGER NOT NULL,
      UNIQUE(server_id, name)
    );
    CREATE TABLE IF NOT EXISTS server_member_roles (
      role_id INTEGER NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      PRIMARY KEY(role_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS server_channels (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES chat_servers(id),
      parent_id INTEGER REFERENCES server_channels(id),
      conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id),
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      depth INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS server_channels_tree ON server_channels(server_id, parent_id);
    CREATE TABLE IF NOT EXISTS server_channel_roles (
      channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
      PRIMARY KEY(channel_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS server_invites (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES chat_servers(id),
      inviter_id INTEGER NOT NULL REFERENCES accounts(id),
      recipient_id INTEGER NOT NULL REFERENCES accounts(id),
      UNIQUE(server_id, recipient_id)
    );
    CREATE TABLE IF NOT EXISTS server_invite_messages (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      invite_id INTEGER UNIQUE REFERENCES server_invites(id) ON DELETE SET NULL,
      recipient_id INTEGER NOT NULL REFERENCES accounts(id),
      server_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS server_invites_recipient ON server_invites(recipient_id);
    CREATE TABLE IF NOT EXISTS server_emojis (
      server_id INTEGER NOT NULL REFERENCES chat_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      url TEXT NOT NULL,
      PRIMARY KEY(server_id, name)
    );
    CREATE TABLE IF NOT EXISTS server_audit (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES chat_servers(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS server_audit_history ON server_audit(server_id, id);
    INSERT OR IGNORE INTO server_channels(server_id, conversation_id, name)
      SELECT id, conversation_id, 'general' FROM chat_servers WHERE conversation_id IS NOT NULL;
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('server_roles') WHERE name = 'administrator'").get()) {
    db.exec('ALTER TABLE server_roles ADD COLUMN administrator INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('chat_servers') WHERE name = 'background_url'").get()) {
    db.exec("ALTER TABLE chat_servers ADD COLUMN background_url TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('chat_servers') WHERE name = 'theme'").get()) {
    db.exec("ALTER TABLE chat_servers ADD COLUMN theme TEXT NOT NULL DEFAULT 'sage'");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('server_channels') WHERE name = 'topic'").get()) {
    db.exec("ALTER TABLE server_channels ADD COLUMN topic TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('server_channel_roles') WHERE name = 'visibility'").get()) {
    transaction(() => {
      db.exec(`
        ALTER TABLE server_channel_roles ADD COLUMN visibility INTEGER NOT NULL DEFAULT 1 CHECK (visibility IN (-1, 1));
        ALTER TABLE server_channels ADD COLUMN everyone_visibility INTEGER NOT NULL DEFAULT 0 CHECK (everyone_visibility IN (-1, 0, 1));
        UPDATE server_channels SET everyone_visibility = -1
          WHERE EXISTS (SELECT 1 FROM server_channel_roles WHERE channel_id = server_channels.id);
      `);
    });
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('server_roles') WHERE name = 'position'").get()) {
    transaction(() => db.exec(`
      ALTER TABLE server_roles ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE server_roles ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
      UPDATE server_roles SET position = id;
    `));
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('server_channels') WHERE name = 'message_rules'").get()) {
    db.exec("ALTER TABLE server_channels ADD COLUMN message_rules TEXT NOT NULL DEFAULT '{}'");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('server_channels') WHERE name = 'position'").get()) {
    transaction(() => db.exec(`
      ALTER TABLE server_channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      UPDATE server_channels SET position = id;
    `));
  }
  db.exec('CREATE INDEX IF NOT EXISTS server_channels_order ON server_channels(server_id, parent_id, position, id)');
  // Every ancestor must grant access. A matching role deny takes precedence at that level.
  const canSee = db.prepare(`
    WITH RECURSIVE path(id, parent_id, everyone_visibility) AS (
      SELECT id, parent_id, everyone_visibility FROM server_channels WHERE conversation_id = :conversation
      UNION ALL
      SELECT c.id, c.parent_id, c.everyone_visibility FROM server_channels c JOIN path p ON p.parent_id = c.id
    )
    SELECT 1 FROM server_channels c JOIN chat_servers s ON s.id = c.server_id
    JOIN chat_server_members m ON m.server_id = s.id AND m.account_id = :account
    WHERE c.conversation_id = :conversation AND (s.owner_id = :account OR EXISTS (
      SELECT 1 FROM server_roles r JOIN server_member_roles a ON a.role_id = r.id
      WHERE r.server_id = s.id AND a.account_id = :account AND r.administrator
    ) OR NOT EXISTS (
      SELECT 1 FROM path p WHERE EXISTS (
        SELECT 1 FROM server_channel_roles r JOIN server_member_roles mr ON mr.role_id = r.role_id
        WHERE r.channel_id = p.id AND mr.account_id = :account AND r.visibility = -1
      ) OR (p.everyone_visibility = -1 AND NOT EXISTS (
        SELECT 1 FROM server_channel_roles r JOIN server_member_roles mr ON mr.role_id = r.role_id
        WHERE r.channel_id = p.id AND mr.account_id = :account AND r.visibility = 1
      ))
    ))
  `);
  const permissions = db.prepare(`
    SELECT s.owner_id AS ownerId, s.invite_code AS inviteCode,
      (s.owner_id = :account OR EXISTS (SELECT 1 FROM server_roles r JOIN server_member_roles a ON a.role_id = r.id
        WHERE r.server_id = s.id AND a.account_id = :account AND (r.can_invite OR r.administrator))) AS canInvite,
      (s.owner_id = :account OR EXISTS (SELECT 1 FROM server_roles r JOIN server_member_roles a ON a.role_id = r.id
        WHERE r.server_id = s.id AND a.account_id = :account AND (r.can_manage_channels OR r.administrator))) AS canManageChannels,
      (s.owner_id = :account OR EXISTS (SELECT 1 FROM server_roles r JOIN server_member_roles a ON a.role_id = r.id
        WHERE r.server_id = s.id AND a.account_id = :account AND r.administrator)) AS canAdmin
    FROM chat_servers s JOIN chat_server_members m ON m.server_id = s.id
    WHERE s.id = :server AND m.account_id = :account
  `);
  const channels = db.prepare(`
    SELECT id, parent_id AS parentId, name, topic, kind, conversation_id AS conversationId, depth, position, message_rules AS messageRules, everyone_visibility AS everyoneVisibility
    FROM server_channels WHERE server_id = ? ORDER BY position, id
  `);
  const channelById = db.prepare(`
    SELECT id, name, topic, parent_id AS parentId, conversation_id AS conversationId, kind, depth, position, message_rules AS messageRules, everyone_visibility AS everyoneVisibility
    FROM server_channels WHERE id = ? AND server_id = ?
  `);
  const channelForConversation = db.prepare('SELECT id, server_id AS serverId, kind, message_rules AS messageRules FROM server_channels WHERE conversation_id = ?');
  const channelRoleRules = db.prepare('SELECT role_id AS roleId, visibility FROM server_channel_roles WHERE channel_id = ? ORDER BY role_id');
  const roles = db.prepare(`
    SELECT id, name, can_invite AS canInvite, can_manage_channels AS canManageChannels, administrator, position, options
    FROM server_roles WHERE server_id = ? ORDER BY position DESC, id DESC
  `);
  const assignments = db.prepare(`
    SELECT a.account_id AS accountId, a.role_id AS roleId FROM server_member_roles a
    JOIN server_roles r ON r.id = a.role_id WHERE r.server_id = ?
  `);
  const serverProfile = db.prepare('SELECT name, icon_url AS avatarUrl, background_url AS bannerUrl, theme FROM chat_servers WHERE id = ?');
  const updateServerStyle = db.prepare("UPDATE chat_servers SET name = ?, icon_url = ?, background_url = '', theme = ? WHERE id = ?");
  const member = db.prepare('SELECT 1 FROM chat_server_members WHERE server_id = ? AND account_id = ?');
  const memberIds = db.prepare('SELECT account_id AS id FROM chat_server_members WHERE server_id = ?');
  const accountById = db.prepare('SELECT id, display_name AS displayName FROM accounts WHERE id = ?');
  const seed = db.prepare(`
    INSERT OR IGNORE INTO server_channels(server_id, conversation_id, name) VALUES (?, ?, 'general')
  `);
  const nextBackingId = db.prepare('SELECT coalesce(min(first_proxy), 0) - 1 AS id FROM conversations WHERE first_id = ?');
  const newConversation = db.prepare('INSERT INTO conversations(first_id, second_id, first_proxy, second_proxy) VALUES (?, ?, ?, 0)');
  const newChannel = db.prepare(`
    INSERT INTO server_channels(server_id, parent_id, conversation_id, name, depth, topic, everyone_visibility, kind, message_rules, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const siblings = db.prepare('SELECT id FROM server_channels WHERE server_id = ? AND parent_id IS ? ORDER BY position, id');
  const lastPosition = db.prepare('SELECT coalesce(max(position), 0) AS position FROM server_channels WHERE server_id = ? AND parent_id IS ?');
  const placeChannel = db.prepare('UPDATE server_channels SET parent_id = ?, position = ? WHERE id = ?');
  const setPosition = db.prepare('UPDATE server_channels SET position = ? WHERE id = ?');
  const shiftDepth = db.prepare('UPDATE server_channels SET depth = depth + ? WHERE id = ?');
  const updateChannel = db.prepare('UPDATE server_channels SET name = ?, topic = ?, everyone_visibility = ?, message_rules = ? WHERE id = ?');
  const clearChannelRoles = db.prepare('DELETE FROM server_channel_roles WHERE channel_id = ?');
  const addChannelRole = db.prepare('INSERT INTO server_channel_roles(channel_id, role_id, visibility) VALUES (?, ?, ?)');
  const subtree = db.prepare(`
    WITH RECURSIVE nodes(id, conversation_id, depth) AS (
      SELECT id, conversation_id, depth FROM server_channels WHERE id = ?
      UNION ALL SELECT c.id, c.conversation_id, c.depth FROM server_channels c JOIN nodes n ON c.parent_id = n.id
    )
    SELECT id, depth, conversation_id AS conversationId FROM nodes ORDER BY depth DESC
  `);
  const roleInUse = db.prepare('SELECT 1 FROM server_channel_roles r JOIN server_roles s ON s.id = r.role_id WHERE r.role_id = ? AND s.server_id = ?');
  const deleteChannel = db.prepare('DELETE FROM server_channels WHERE id = ?');
  const unlinkDefault = db.prepare('UPDATE chat_servers SET conversation_id = NULL WHERE conversation_id = ?');
  const eraseMessages = db.prepare('DELETE FROM direct_messages WHERE conversation_id = ?');
  const insertRole = db.prepare('INSERT INTO server_roles(server_id, name, can_invite, can_manage_channels, administrator, options, position) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const moveRole = db.prepare('UPDATE server_roles SET position = ? WHERE id = ?');
  const updateRole = db.prepare('UPDATE server_roles SET name = ?, can_invite = ?, can_manage_channels = ?, administrator = ?, options = ? WHERE id = ? AND server_id = ?');
  const deleteRole = db.prepare('DELETE FROM server_roles WHERE id = ? AND server_id = ?');
  const clearMemberRoles = db.prepare(`
    DELETE FROM server_member_roles WHERE account_id = ? AND role_id IN (SELECT id FROM server_roles WHERE server_id = ?)
  `);
  const addMemberRole = db.prepare('INSERT INTO server_member_roles VALUES (?, ?)');
  const invitation = db.prepare('SELECT * FROM server_invites WHERE id = ? AND recipient_id = ?');
  const sendInvite = db.prepare('INSERT OR IGNORE INTO server_invites(server_id, inviter_id, recipient_id) VALUES (?, ?, ?)');
  const clearInvite = db.prepare('DELETE FROM server_invites WHERE server_id = ? AND recipient_id = ?');
  const invitesFrom = db.prepare('SELECT recipient_id AS id FROM server_invites WHERE server_id = ? AND inviter_id = ?');
  const cancelInvitesFrom = db.prepare('DELETE FROM server_invites WHERE server_id = ? AND inviter_id = ?');
  const deleteMember = db.prepare('DELETE FROM chat_server_members WHERE server_id = ? AND account_id = ?');
  const deleteMembers = db.prepare('DELETE FROM chat_server_members WHERE server_id = ?');
  const inviteRecipients = db.prepare('SELECT recipient_id AS id FROM server_invites WHERE server_id = ?');
  const removeUnusedImage = db.prepare(`
    DELETE FROM profile_media WHERE id = :id
      AND NOT EXISTS (SELECT 1 FROM chat_servers WHERE icon_url = :url OR background_url = :url)
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE avatar_url = :url OR banner_url = :url)
      AND NOT EXISTS (SELECT 1 FROM proxies WHERE avatar_url = :url OR banner = :url)
  `);
  const deleteInvites = db.prepare('DELETE FROM server_invites WHERE server_id = ?');
  const deleteRoles = db.prepare('DELETE FROM server_roles WHERE server_id = ?');
  const deleteServer = db.prepare('DELETE FROM chat_servers WHERE id = ?');
  const addAudit = db.prepare('INSERT INTO server_audit(server_id, actor_id, action, detail, recorded_at) VALUES (?, ?, ?, ?, ?)');
  const auditHistory = db.prepare(`
    SELECT a.id, u.display_name AS actor, a.action,
      CASE WHEN a.action IN ('Invited member', 'Removed member', 'Changed member roles') AND EXISTS (
        SELECT 1 FROM accounts target
        WHERE (CASE WHEN a.action = 'Changed member roles' AND instr(a.detail, ' — ') > 0
                    THEN substr(a.detail, 1, instr(a.detail, ' — ') - 1) ELSE a.detail END)
          COLLATE NOCASE IN (target.username, substr(target.username, 1, length(target.username) - 5))
      ) THEN 'Horizon member' ||
        CASE WHEN a.action = 'Changed member roles' AND instr(a.detail, ' — ') > 0
             THEN substr(a.detail, instr(a.detail, ' — ')) ELSE '' END
      ELSE a.detail END AS detail, a.recorded_at AS recordedAt
    FROM server_audit a JOIN accounts u ON u.id = a.actor_id WHERE server_id = ? AND a.id < ?
    ORDER BY a.id DESC LIMIT 51
  `);
  const join = db.prepare('INSERT OR IGNORE INTO chat_server_members VALUES (?, ?)');
  const visible = (conversation, account) => Boolean(canSee.get({ conversation, account }));
  const access = (server, account) => permissions.get({ server, account });
  const fail = (status, error) => ({ status, error });
  const nameOf = data => typeof data?.name === 'string' ? data.name.trim() : '';
  const validRoles = (server, roleIds) => {
    if (!Array.isArray(roleIds) || roleIds.length > 50 || new Set(roleIds).size !== roleIds.length) return false;
    const available = new Set(roles.all(server).map(role => role.id));
    return roleIds.every(id => available.has(id));
  };

  const settingsFlags = ['canManageEmojis', 'canManageRoles', 'canAttach', 'canMentionRoles', 'canManageMessages'];
  const serverRoles = server => roles.all(server).map(({ options, ...role }) => ({ ...role, ...JSON.parse(options) }));
  const accountRoles = (server, account) => {
    const assigned = new Set(assignments.all(server).filter(row => row.accountId === account).map(row => row.roleId));
    return serverRoles(server).filter(role => assigned.has(role.id));
  };
  function roleAccess(server, account) {
    const policy = access(server, account);
    if (!policy) return null;
    const held = accountRoles(server, account);
    const owner = policy.ownerId === account;
    const highest = held[0]?.position ?? 0;
    const has = flag => Boolean(policy.canAdmin || (flag === 'canAttach'
      ? !held.length || held.some(role => role.canAttach !== false) : held.some(role => role[flag])));
    const canManageRoles = has('canManageRoles');
    return { ...policy, owner, held, highest, has, canManageRoles,
      canEdit: role => owner || (canManageRoles && role.position < highest && (!role.administrator || policy.canAdmin)) };
  }

  function channelActions(conversation, account, knownPolicy) {
    const channel = channelForConversation.get(conversation);
    if (!channel) return null;
    const policy = knownPolicy ?? roleAccess(channel.serverId, account);
    if (!policy) return { canSend: false, canAttach: false, canManageMessages: false, canMentionRoles: false };
    const rules = JSON.parse(channel.messageRules);
    const permitted = (key, fallback) => {
      if (policy.canAdmin) return true;
      const values = (rules[key]?.roles || []).filter(rule => policy.held.some(role => role.id === rule.roleId));
      if (values.some(rule => rule.value === -1)) return false;
      if (values.some(rule => rule.value === 1)) return true;
      return rules[key]?.everyone ? rules[key].everyone === 1 : fallback;
    };
    const canSend = !['voice', 'separator'].includes(channel.kind) && permitted('send', true);
    return { canSend,
      canAttach: canSend && policy.has('canAttach'),
      canManageMessages: permitted('manage', policy.has('canManageMessages')),
      canMentionRoles: policy.has('canMentionRoles') };
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const emojiStore = createEmojis(db, transaction);
  const audit = (server, account, action, detail = '') => addAudit.run(server, account, action, detail, Date.now());
  function discardImage(url) {
    if (url.startsWith(mediaPath)) removeUnusedImage.run({ id: url.slice(mediaPath.length), url });
  }
  function removeChannel(channel) {
    deleteChannel.run(channel.id);
    unlinkDefault.run(channel.conversationId);
    // Keep the empty backing ID so old URLs cannot point to a new chat.
    eraseMessages.run(channel.conversationId);
  }

  const canEditProfile = (server, account) => Boolean(access(server, account)?.canAdmin);

  return {
    audit, emojiStore, canEditProfile,
    history(server, account, before) {
      if (!access(server, account)?.canAdmin) return fail(403, 'Only server administrators can view the activity log.');
      const rows = auditHistory.all(server, before);
      return { entries: rows.slice(0, 50), hasOlder: rows.length > 50 };
    },
    kick(server, account, target) {
      const actor = access(server, account);
      if (!actor?.canAdmin) return fail(403, 'Only server administrators can remove members.');
      const person = access(server, target);
      if (!person) return fail(404, 'Server member not found.');
      if (target === account || target === actor.ownerId || (person.canAdmin && account !== actor.ownerId)) {
        return fail(403, 'You cannot remove this member.');
      }
      return transaction(() => {
        clearMemberRoles.run(target, server);
        deleteMember.run(server, target);
        audit(server, account, 'Removed member', accountById.get(target).displayName);
        return {};
      });
    },
    leave(server, account) {
      return transaction(() => {
        const membership = access(server, account);
        if (!membership) return fail(404, 'Server membership not found.');
        if (membership.ownerId === account) return fail(403, 'The server owner cannot leave this server.');
        const recipients = invitesFrom.all(server, account).map(row => row.id);
        cancelInvitesFrom.run(server, account);
        clearInvite.run(server, account);
        clearMemberRoles.run(account, server);
        deleteMember.run(server, account);
        audit(server, account, 'Left server');
        return { recipients };
      });
    },
    editServer(server, account, data, media) {
      if (!canEditProfile(server, account)) return fail(403, 'Only server administrators can change server settings.');
      const name = nameOf(data);
      if (!name || name.length > 80) return fail(400, 'Enter a server name up to 80 characters.');
      const existing = serverProfile.get(server);
      const theme = data.theme ?? existing.theme;
      if (!['horizon','basic-light','basic-mid','basic-dark','vanilla','sage','cinnamon','lavender','nutmeg','clove','d2-steel','burnt-titanium'].includes(theme)) return fail(400, 'Choose a supported server theme.');
      if (data.background !== undefined) return fail(400, 'Server backgrounds have been replaced by themes.');
      return transaction(() => {
        const images = media.update({ avatar: data.icon, banner: '' }, existing);
        if (images.error) return fail(400, images.error);
        updateServerStyle.run(name, images.avatarUrl, theme, server);
        if (theme !== existing.theme) audit(server, account, 'Changed server theme', theme);
        if (name !== existing.name) audit(server, account, 'Renamed server', existing.name + ' to ' + name);
        if (images.avatarUrl !== existing.avatarUrl) {
          discardImage(existing.avatarUrl);
          audit(server, account, images.avatarUrl ? 'Changed server icon' : 'Removed server icon');
        }
        if (images.bannerUrl !== existing.bannerUrl) {
          discardImage(existing.bannerUrl);
          audit(server, account, images.bannerUrl ? 'Changed server background' : 'Removed server background');
        }
        return {};
      });
    },
    removeServer(server, account, name) {
      if (access(server, account)?.ownerId !== account) return fail(403, 'Only the server owner can delete this server.');
      const existing = serverProfile.get(server);
      if (existing.name !== name) return fail(400, 'Enter the full server name to confirm deletion.');
      return transaction(() => {
        const viewers = [...new Set([...memberIds.all(server), ...inviteRecipients.all(server)].map(row => row.id))];
        for (const channel of channels.all(server).sort((a, b) => b.depth - a.depth)) removeChannel(channel);
        deleteRoles.run(server);
        deleteInvites.run(server);
        deleteMembers.run(server);
        emojiStore.removeServer(server);
        deleteServer.run(server);
        discardImage(existing.avatarUrl);
        discardImage(existing.bannerUrl);
        return { viewers };
      });
    },
    editEmoji(server, account, data) {
      const policy = roleAccess(server, account);
      if (!policy?.has('canManageEmojis')) return fail(403, 'You cannot manage server emojis.');
      return emojiStore.edit(server, data, {
        canPurge: policy.owner,
        audit: (action, detail) => audit(server, account, action, detail),
      });
    },
    mentionRecipients(conversation, account, body, online = () => false) {
      const channel = channelForConversation.get(conversation);
      if (!channel || !body.includes('$')) return [];
      const policy = channelActions(conversation, account);
      if (!policy?.canSend) return [];
      const tokens = new Set([...body.matchAll(/(?:^|[^\p{L}\p{N}_])\$(?:\{([^}]+)\}|([\p{L}\p{N}_-]+(?:#[a-z0-9]{4})?))/giu)].map(match => (match[1] || match[2]).normalize('NFKC').toLowerCase()));
      const broad = policy.canMentionRoles;
      const mentionedRoles = new Set(broad ? serverRoles(channel.serverId).filter(role => tokens.has(role.name.toLowerCase())).map(role => role.id) : []);
      const roleMembers = new Set(assignments.all(channel.serverId).filter(row => mentionedRoles.has(row.roleId)).map(row => row.accountId));
      const names = db.prepare('SELECT display_name AS name, public_tag AS tag FROM accounts WHERE id = ?');
      return memberIds.all(channel.serverId).map(row => row.id).filter(id => {
        if (id === account || !visible(conversation,id)) return false;
        const person = names.get(id);
        const handle = (person.name + '#' + person.tag).normalize('NFKC').toLowerCase();
        return tokens.has(handle) || tokens.has(person.name.normalize('NFKC').toLowerCase()) ||
          broad && (tokens.has('everyone') || tokens.has('here') && online(id) || roleMembers.has(id));
      });
    },
    seed: (server, conversation) => seed.run(server, conversation),
    channel: conversation => channelForConversation.get(conversation),
    visible,
    channelActions,
    canManageChannels: (server, viewer) => Boolean(roleAccess(server, viewer)?.canManageChannels),
    members: server => memberIds.all(server).map(row => row.id),
    decorate(server, account) {
      const policy = roleAccess(server.id, account);
      const visibleChannels = channels.all(server.id).filter(channel => visible(channel.conversationId, account));
      const managed = Boolean(policy.canManageChannels);
      return { ...server, theme: serverProfile.get(server.id).theme, inviteCode: policy.canInvite ? policy.inviteCode : null,
        canInvite: Boolean(policy.canInvite), canManageChannels: managed,
        canAdmin: Boolean(policy.canAdmin),
        canManageRoles: policy.canManageRoles, isOwner: policy.owner,
        canManageEmojis: policy.has('canManageEmojis'),
        editableRoleIds: serverRoles(server.id).filter(policy.canEdit).map(role => role.id),
        conversationId: visibleChannels.find(channel => channel.parentId === null && channel.kind !== 'separator')?.conversationId
          ?? visibleChannels.find(channel => channel.kind !== 'separator')?.conversationId ?? null,
        channels: visibleChannels.map(({ everyoneVisibility, messageRules, ...channel }) => {
          Object.assign(channel, channelActions(channel.conversationId, account, policy));
          if (!managed) return channel;
          const roleRules = channelRoleRules.all(channel.id);
          const roleIds = roleRules.filter(rule => rule.visibility === 1).map(rule => rule.roleId);
          return { ...channel, everyoneVisibility, roleRules, roleIds, messageRules: JSON.parse(messageRules) };
        }),
        roles: serverRoles(server.id),
        ...emojiStore.catalog(server.id, policy.owner),
        assignments: assignments.all(server.id),
      };
    },
    editRole(server, account, id, data, remove) {
      const policy = roleAccess(server, account);
      if (!policy?.canManageRoles) return fail(403, 'You cannot manage roles on this server.');
      const available = serverRoles(server);
      const role = available.find(entry => entry.id === id);
      if (id && (!role || !policy.canEdit(role))) return fail(403, 'You can only manage roles below your highest role.');
      if (data.move === 'up' || data.move === 'down') {
        if (!role) return fail(404, 'Role not found.');
        const neighbor = available[available.indexOf(role) + (data.move === 'up' ? -1 : 1)];
        if (!neighbor || !policy.canEdit(neighbor)) return fail(403, 'You cannot move the role to that position.');
        return transaction(() => {
          moveRole.run(neighbor.position, role.id);
          moveRole.run(role.position, neighbor.id);
          audit(server, account, 'Moved role', role.name);
          return {};
        });
      }
      if (remove) {
        if (roleInUse.get(id, server) || channels.all(server).some(channel => Object.values(JSON.parse(channel.messageRules))
          .some(rule => rule.roles?.some(entry => entry.roleId === id)))) {
          return fail(409, 'Remove this role from channel rules before deleting it.');
        }
        return transaction(() => {
          deleteRole.run(id, server);
          audit(server, account, 'Deleted role', role.name);
          return {};
        });
      }
      const name = nameOf(data);
      if (!name || name.length > 48) return fail(400, 'Enter a role name up to 48 characters.');
      const flags = Object.fromEntries(['canInvite', 'canManageChannels', 'administrator', ...settingsFlags]
        .map(key => [key, data[key] === undefined ? (role?.[key] ?? (key === 'canAttach' && policy.has('canAttach'))) : data[key] === true]));
      if (!policy.owner && Object.keys(flags).some(key => flags[key] && !(role && (role[key] ?? (key === 'canAttach'))) && !policy.has(key))) {
        return fail(403, 'You can only grant permissions you have.');
      }
      const color = data.color ?? role?.color ?? [];
      if (!Array.isArray(color) || color.length > 3 || !color.every((stop, index) => stop &&
          typeof stop.value === 'string' && /^#[0-9a-f]{6}$/i.test(stop.value) && Number.isInteger(stop.offset) && stop.offset >= 0 && stop.offset <= 100 &&
          (!index || stop.offset > color[index - 1].offset))) return fail(400, 'Choose valid colors and increasing gradient stops.');
      try {
        return transaction(() => {
          const options = JSON.stringify({ ...Object.fromEntries(settingsFlags.map(key => [key, Boolean(flags[key])])), color });
          const values = [Number(flags.canInvite), Number(flags.canManageChannels), Number(flags.administrator), options];
          if (!id) {
            // New roles start at the bottom of the hierarchy.
            insertRole.run(server, name, ...values, available.length ? available.at(-1).position - 1 : 1);
          } else updateRole.run(name, ...values, id, server);
          audit(server, account, id ? 'Updated role' : 'Created role', name);
          return {};
        });
      } catch (error) {
        if (error.errcode === 2067) return fail(409, 'That role name already exists.');
        throw error;
      }
    },
    assignRoles(server, account, target, data) {
      const policy = roleAccess(server, account);
      if (!policy?.canManageRoles) return fail(403, 'You cannot assign roles on this server.');
      if (!member.get(server, target)) return fail(404, 'Server member not found.');
      if (!validRoles(server, data?.roleIds)) return fail(400, 'Choose roles from this server.');
      const current = accountRoles(server, target);
      const selected = serverRoles(server).filter(role => data.roleIds.includes(role.id));
      if (!policy.owner && (target === policy.ownerId || target === account || current.some(role => !policy.canEdit(role)) ||
          selected.some(role => !policy.canEdit(role) || (!current.some(entry => entry.id === role.id) &&
            ['canInvite', 'canManageChannels', 'administrator', ...settingsFlags].some(key =>
              (role[key] ?? (key === 'canAttach')) && !policy.has(key)))))) return fail(403, 'You can only assign roles below your highest role.');
      return transaction(() => {
        clearMemberRoles.run(target, server);
        for (const id of data.roleIds) addMemberRole.run(id, target);
        audit(server, account, 'Changed member roles', accountById.get(target).displayName + ' â€” ' +
          (selected.map(role => role.name).join(', ') || 'No roles'));
        return {};
      });
    },
    editChannel(server, account, id, data, remove) {
      const policy = access(server, account);
      if (!policy?.canManageChannels) return fail(403, 'You cannot manage channels on this server.');
      const existing = id && channelById.get(id, server);
      if (id && (!existing || !visible(existing.conversationId, account))) return fail(404, 'Channel not found.');
      if (remove) {
        const nodes = subtree.all(id);
        if (nodes.some(channel => !visible(channel.conversationId, account))) {
          return fail(403, 'You need access to every channel in this branch to delete it.');
        }
        return transaction(() => {
          for (const channel of nodes) removeChannel(channel);
          audit(server, account, 'Deleted channel', '#' + existing.name + ' (' + nodes.length + ' removed)');
          return {};
        });
      }
      if (data.move) {
        if (!existing) return fail(404, 'Channel not found.');
        const { targetId, placement } = data.move;
        if (!['before', 'after', 'inside', 'root'].includes(placement) ||
            (placement !== 'root' && (!Number.isSafeInteger(targetId) || targetId === id))) {
          return fail(400, 'Choose a valid channel position.');
        }
        return transaction(() => {
          const channel = channelById.get(id, server);
          const target = placement === 'root' ? null : channelById.get(targetId, server);
          if (placement !== 'root' && (!target || !visible(target.conversationId, account))) return fail(404, 'Destination not found.');
          if (placement === 'inside' && target.kind === 'separator') return fail(400, 'Separators cannot contain channels.');
          const parentId = placement === 'inside' ? target.id : target?.parentId ?? null;
          const parent = parentId && channelById.get(parentId, server);
          const nodes = subtree.all(id);
          if (nodes.some(node => node.id === parentId)) return fail(400, 'A channel cannot be moved into its own branch.');
          if (nodes.some(node => !visible(node.conversationId, account))) return fail(403, 'You need access to every channel in this branch to move it.');
          const offset = (parent?.depth ?? -1) + 1 - channel.depth;
          if (nodes[0].depth + offset >= 8) return fail(400, 'Channels can nest up to eight levels deep.');
          const ordered = siblings.all(server, parentId).map(row => row.id).filter(row => row !== id);
          const index = ['before', 'after'].includes(placement) ? ordered.indexOf(target.id) + Number(placement === 'after') : ordered.length;
          ordered.splice(index, 0, id);
          placeChannel.run(parentId, index + 1, id);
          ordered.forEach((channelId, position) => setPosition.run(position + 1, channelId));
          if (offset) for (const node of nodes) shiftDepth.run(offset, node.id);
          audit(server, account, 'Moved channel', channel.name);
          return { channelId: id };
        });
      }
      const name = (!existing && data.kind === 'separator') ? 'Separator' : nameOf(data);
      if (!name || name.length > 65) return fail(400, 'Enter a channel name up to 65 characters.');
      const legacy = Array.isArray(data.roleIds) && data.roleRules === undefined && data.everyoneVisibility === undefined;
      const currentRules = existing ? channelRoleRules.all(id) : [];
      const legacyAllows = currentRules.filter(rule => rule.visibility === 1).map(rule => rule.roleId);
      const legacyUnchanged = legacy && existing && legacyAllows.length === data.roleIds.length &&
        legacyAllows.every(roleId => data.roleIds.includes(roleId));
      if (legacy && existing && !legacyUnchanged &&
          (currentRules.length !== legacyAllows.length || existing.everyoneVisibility !== (legacyAllows.length ? -1 : 0))) {
        return fail(409, 'Refresh Horizon Chat to edit advanced visibility rules.');
      }
      const everyoneVisibility = legacyUnchanged ? existing.everyoneVisibility
        : legacy ? (data.roleIds.length ? -1 : 0) : data.everyoneVisibility;
      const rules = legacyUnchanged ? currentRules
        : legacy ? data.roleIds.map(roleId => ({ roleId, visibility: 1 })) : data.roleRules;
      if (![-1, 0, 1].includes(everyoneVisibility) || !Array.isArray(rules) ||
          rules.some(rule => !rule || ![-1, 1].includes(rule.visibility)) ||
          !validRoles(server, rules.map(rule => rule.roleId))) {
        return fail(400, 'Choose valid visibility rules for roles from this server.');
      }
      const kind = existing?.kind ?? data.kind ?? 'text';
      if (!['text', 'voice', 'forum', 'map', 'timeline', 'separator'].includes(kind)) return fail(400, 'Choose a supported channel type.');
      const requested = data.messageRules ?? JSON.parse(existing?.messageRules || '{}');
      if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return fail(400, 'Invalid channel message rules.');
      const messageRules = {};
      for (const key of ['send', 'manage']) {
        const rule = requested[key];
        if (rule === undefined) continue;
        if (!rule || ![-1, 0, 1].includes(rule.everyone) || !Array.isArray(rule.roles) ||
            rule.roles.some(entry => !entry || ![-1, 1].includes(entry.value)) ||
            !validRoles(server, rule.roles.map(entry => entry.roleId))) return fail(400, 'Invalid channel message rules.');
        messageRules[key] = { everyone: rule.everyone, roles: rule.roles.map(({ roleId, value }) => ({ roleId, value })) };
      }
      const savedMessageRules = JSON.stringify(messageRules);
      const topic = data.topic === undefined ? (existing?.topic || '') : data.topic;
      if (typeof topic !== 'string' || topic.length > 1024) return fail(400, 'Use up to 1,024 characters for the channel topic.');
      const parentId = existing ? existing.parentId : data.parentId ?? null;
      if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId < 1)) return fail(400, 'Choose a valid parent channel.');
      const parent = parentId && channelById.get(parentId, server);
      if (parentId && (!parent || !visible(parent.conversationId, account) || parent.kind === 'separator')) {
        return fail(404, 'Parent channel not found or cannot contain channels.');
      }
      if (parent?.depth >= 7) return fail(400, 'Channels can nest up to eight levels deep.');
      return transaction(() => {
        if (existing) updateChannel.run(name, topic.trim(), everyoneVisibility, savedMessageRules, id);
        else {
          const owner = policy.ownerId;
          const conversation = Number(newConversation.run(owner, owner, nextBackingId.get(owner).id).lastInsertRowid);
          id = Number(newChannel.run(server, parentId, conversation, name, (parent?.depth ?? -1) + 1, topic.trim(), everyoneVisibility, kind, savedMessageRules, lastPosition.get(server, parentId).position + 1).lastInsertRowid);
        }
        clearChannelRoles.run(id);
        for (const { roleId, visibility } of rules) addChannelRole.run(id, roleId, visibility);
        const names = new Map(roles.all(server).map(role => [role.id, role.name]));
        const selected = rules.map(rule => (rule.visibility === 1 ? 'Allow ' : 'Deny ') + names.get(rule.roleId));
        if (everyoneVisibility) selected.unshift(everyoneVisibility === -1 ? 'Private' : 'Allow @everyone');
        const label = existing && existing.name !== name ? '#' + existing.name + ' to #' + name : '#' + name;
        audit(server, account, existing ? 'Updated channel' : 'Created channel', label + ' â€” ' + (selected.join(', ') || 'Inherited access'));
        return { channelId: id };
      });
    },
    invite(server, account, recipient, deliver) {
      if (!access(server, account)?.canInvite) return fail(403, 'You cannot invite people to this server.');
      if (!Number.isSafeInteger(recipient) || !accountById.get(recipient)) return fail(404, 'Account not found.');
      if (member.get(server, recipient)) return fail(409, 'This person already belongs to the server.');
      return transaction(() => {
        if (sendInvite.run(server, account, recipient).changes) audit(server, account, 'Invited member', accountById.get(recipient).displayName);
        return deliver(db.prepare('SELECT * FROM server_invites WHERE server_id = ? AND recipient_id = ?').get(server, recipient));

      });
    },
    answerInvite(id, account, accept) {
      const entry = invitation.get(id, account);
      if (!entry) return fail(404, 'Invite not found.');
      return transaction(() => {
        if (accept) join.run(entry.server_id, account);
        db.prepare('UPDATE server_invite_messages SET status = ? WHERE invite_id = ?').run(accept ? 'accepted' : 'denied', id);
        audit(entry.server_id, account, accept ? 'Accepted invitation' : 'Dismissed invitation');
        clearInvite.run(entry.server_id, account);
        return { serverId: entry.server_id };
      });
    },
    clearInvite: (server, account) => clearInvite.run(server, account),
  };
}

