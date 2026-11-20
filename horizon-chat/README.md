# Horizon Chat

Horizon Chat is a self-hosted messenger built with Node 24, SQLite, and a vanilla JavaScript client. Caddy serves the static client and proxies `/horizon-chat/api/` to the Node service. Persistent data lives in the Compose `horizon_data` volume.

## Message architecture

All chat messages use `direct_messages`, including DMs, server channels, announcements, forum posts and comments, dice results, and invitation cards. Character identities change the public sender profile while retaining the owning account for permissions.

`messenger.mjs` owns authentication, conversation access, the shared message lifecycle, and live notifications. New messages use one insertion helper for IDs, reply references, and forum bookkeeping. Text, uploaded files, and dice share character resolution. User message sends and edits use `sendMessage` for permissions, rich-text and emoji handling, attachment storage, transactions, and notifications. Forum description edits enter that same edit path. Invitation creation uses the insertion helper inside the invite transaction so its card and invitation are committed together.

Feature modules store relationships and metadata rather than copies of messages:

- `direct-inboxes.mjs` manages account and character inbox endpoints, unread state, and server membership.
- `broadcasts.mjs` stores one announcement with delivery pointers for recipients.
- `forums.mjs` adds descriptions, comment membership, and one vote per account and post.
- `server-permissions.mjs` manages channel visibility, roles, moderation, and invitations. Invitations appear as DM cards, with their state stored in `server_invite_messages`.
- `message-format.mjs`, `emojis.mjs`, and `message-documents.mjs` validate rich text and custom emoji references and store compressed attachment chunks.
- `channel-maps.mjs` and `timelines.mjs` store map and timeline content separately from each channel's conversation.
- `server-layouts.mjs` stores each account's server order and folders.

The client uses `composer.js` to render saved message formatting in chats and forum post views. `documents.js` handles attachment viewing. Forum discussions use the same composer, message history, editing, replies, and moderation controls as other chats. Server-sent events notify clients to refresh HTTP history, including after reconnecting.

## Run locally

Use a scratch database, never a copied production database for automated tests.

```powershell
$env:HORIZON_PREVIEW = '1'
$env:HORIZON_DB = ':memory:'
node horizon-chat/server.mjs
```

Open http://127.0.0.1:8091/horizon-chat/. Register fresh test accounts through the preview. Stop the process to discard its in-memory data.

Run the backend regression tests from the repository root:

```powershell
node --test horizon-chat/*.test.mjs
```

The tests cover account and character access, message text and formatting, attachments, replies, announcement delivery, permissions, maps, timelines, custom emojis, forums, and personal server layouts. Tests create isolated databases and local HTTP servers.

## Deployment

Back up the live database with SQLite's backup API before updating. Publish backend modules, restart the Horizon service, verify its session endpoint, then publish client modules and styles with the cache-versioned HTML last. Keep the prior files and database backup available for rollback. `set-platform-owner.mjs` manages the transferable platform owner flag.
