import { apiAsset, apiEvents, apiFetch, apiUrl, isDesktop } from './platform.js';
import { imageOptions, isChatImage, optimizeChatImage } from './chat-images.js';
import { setupRecoverySettings } from './recovery-settings.js?v=settings-polish';
import { peerAccount, peerSignal, setupPeerSettings } from './attachment-peers.js';
import { setupHostedArchives } from './hosted-archives.js';
import { setupTrustedDevices } from './trusted-devices.js?v=settings-polish';
import { createRestartNotice } from './restart-notice.js?v=restart-notice';
import { createTypingUI } from './typing.js?v=desktop-platform';
import { createElement as createLucideIcon, Sun, Leaf, Moon, Flower2, Sprout, Anvil } from './vendor/lucide/index.mjs';
import { createForumView } from './forum.js?v=media-preferences';
import { createServerRail } from './server-rail.js?v=stable-icons';
import { createTimeline } from './timeline.js?v=1';
import { createChannelMap } from './channel-map.js?v=3';
import { emojiText } from './emojis.js?v=desktop-platform';
import { createComposer, highlight } from './composer.js?v=media-preferences';
import { createDocumentReader } from './documents.js?v=desktop-platform';

const $ = id => document.getElementById(id);
setupPeerSettings($('desktop-peer-settings'));
const hostedArchives = setupHostedArchives($('hosted-archives'));
const trustedDevices = setupTrustedDevices($('trusted-devices'), $('offline-replicas'));
const recoverySettings = setupRecoverySettings($('account-recovery-archives'), {
  onRestore: async () => { if (account) await Promise.all([refreshList(), syncAccountTheme(account)]); },
  onUnauthorized: () => { if (account) setAccount(null); },
});
const auth = $('authentication');
const app = $('app');
const list = $('conversations');
const contactsMenu = $('contacts-menu');
const contactEditor = $('contact-editor');
let contacts = [];
let inboxProxyId = 0;
let broadcastOwnerId = null;
let lastAccountDm = null;
let servers = [];
let serverLayout = [];
const serverRail = createServerRail({ root: $('server-list'), request: call, renderServer: renderServerButton, encodeImage: encodeProfileImage, onError: showError });
const collapsedChannels = new Set();
const serverSettings = $('server-settings-screen');
let previewImages = [];
let activeServerId = null;
const activeServer = () => servers.find(server => server.id === activeServerId);
const activeChannel = () => activeServer()?.channels.find(channel => channel.conversationId === active);
const channelKinds = { text: 'Text', voice: 'Voice', forum: 'Forum', map: 'Map', timeline: 'Timeline' };
const mentionedChannels = new Set();
let pingAudio;
const draftKey = (id, identity = inboxProxyId) => identity + ':' + id;
const activeConversation = () => conversations.find(item => item.id === active && (item.inboxProxyId ?? 0) === inboxProxyId);
const conversationLabel = item => item.broadcast && !item.broadcastWriter
  ? item.displayName + ' · Announcements' : item.displayName;
const history = $('history');
const composer = $('composer');
const nameDialog = $('recipient');
const preferences = $('preferences');
const miniProfile = $('mini-profile');
const messageActions = $('message-actions');
const deleteAction = $('delete-message');
const editAction = $('edit-message');
const replyAction = $('reply-message');
const replyDrafts = new Map();
const editControls = $('message-edit-controls');
const editStatus = $('message-editor-status');
const saveEdit = $('save-message-edit');
const cancelEdit = $('cancel-message-edit');
const composerHome = composer.parentElement;
const composerSibling = composer.nextSibling;
let messageEdit;
const clock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const drafts = new Map();
const renderedMessages = new WeakMap();
let creating = false;
let account = null;
let imageEncoding;
let conversations = [];
let active = null;
let events;
let eventRetry;
let entries = [];
let messageRequest = 0;
let listRequest = 0;
let sending = false;
let proxies = [];
let selectedProxy = null;
const pendingVariantChoices=new Map();
let variantWriteQueue=Promise.resolve(),variantChoiceSequence=0;
let personaPublishQueue=Promise.resolve(),publishedPersonaKey='';
function publishPersona(){if(!account)return;const viewer=account,data={proxyId:selectedProxy?.id||0,variantId:selectedProxy?.variantId||0},key=JSON.stringify([account.id,data]);if(key===publishedPersonaKey)return;publishedPersonaKey=key;personaPublishQueue=personaPublishQueue.catch(()=>{}).then(()=>viewer===account?call('persona',data):null).catch(()=>{if(publishedPersonaKey===key)publishedPersonaKey='';});}
let identityRestored = false;
let editingProxy = null;
let proxyBaseline = '';
let proxySaving = false;
let proxyMutation = false;
let proxyRosterSignature;
let proxyRosterQuery = '';
let proxyUnfilteredScroll = 0;
const proxyGroupStates = new Map();
const imageDrafts = new WeakMap();
const documents = createDocumentReader(highlight);
let customEmojiCatalog = [];
const editor = createComposer(composer, attachFile,
  () => customEmojiCatalog, renderMentionToken);

async function call(route, payload) {
  if (payload !== undefined && /^servers\/\d+\/invite$/.test(route)) {
    payload = { ...payload, proxyId: selectedProxy?.id ?? 0 };
  }
  const response = await apiFetch(route, {
    ...(payload === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Horizon-Chat': '1' },
      body: JSON.stringify(payload),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (response.status >= 500) throw new Error('Horizon Chat is temporarily unavailable.');
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && account) setAccount(null);
    throw new Error(result.error);
  }
  return result;
}

function setMode(registering) {
  creating = registering;
  $('auth-title').textContent = creating ? 'Create an account' : 'Sign in';
  auth.querySelector('[type="submit"]').textContent = $('auth-title').textContent;
  $('auth-mode').textContent = creating ? 'Back to sign in' : 'Create an account';
  $('display-field').hidden = !creating;
  $('tag-field').hidden = !creating;
  $('open-recovery').hidden = creating;
  auth.elements.tag.disabled = !creating;
  auth.elements.username.pattern = creating ? '[a-zA-Z0-9_]{3,24}' : '[a-zA-Z0-9_]{3,24}(:[A-Za-z0-9]{4})?';
  auth.elements.username.maxLength = creating ? 24 : 29;
  auth.elements.password.autocomplete = creating ? 'new-password' : 'current-password';
  $('auth-status').textContent = '';
}

function setAccount(next) {
  trustedDevices.account(next?.id);
  hostedArchives.reset();
  peerAccount(Boolean(next));
  recoverySettings.reset();
  imageEncoding?.abort();
  restartNotice.stop();
  typing.reset();
  pendingVariantChoices.clear();variantChoiceSequence++;
  resetFooterTransition();
  closeMessageEditor();
  documents.reset();
  events?.close();
  clearTimeout(eventRetry);
  account = next;
  if(next)void syncAccountTheme(next);
  proxies = [];
  selectedProxy = null;
  identityRestored = false;
  editingProxy = null;
  proxyBaseline = '';
  proxyGroupStates.clear();
  proxyRosterSignature = undefined;
  proxyRosterQuery = '';
  proxyUnfilteredScroll = 0;
  $('characters-menu').removeAttribute('data-editor-open');
  $('proxy-editor-empty').hidden = false;
  $('proxy-editor').hidden = true;
  updateSpeaker();
  preferences.close();
  $('character-binder').close();
  contactEditor.close();
  contactsMenu.close();
  contacts = [];
  inboxProxyId = 0;
  broadcastOwnerId = null;
  lastAccountDm = null;
  servers = [];
  serverLayout = [];
  serverRail.reset();
  customEmojiCatalog = [];
  collapsedChannels.clear();
  mentionedChannels.clear();
  activeServerId = null;
  for (const id of ['server-create', 'server-join', 'server-invite-dialog', 'channel-editor', 'member-roles', 'invite-person', 'server-settings-screen', 'server-delete']) $(id).close();
  miniProfile.hidePopover();
  active = null;
  conversations = [];
  entries = [];
  drafts.clear();
  replyDrafts.clear();
  editor.restore();
  drawList();
  showThread();
  app.hidden = !next;
  $('welcome').hidden = Boolean(next);
  if (!next) return;
  updateAccountFooter();void typing.connect();restartNotice.start();
  connectEvents();
  void refreshList().catch(showError);
}

function desktopConnection(message) {
  if (!isDesktop) return;
  const status = $('desktop-connection');
  status.textContent = message;
  status.hidden = !message;
}

function connectEvents() {
  events = apiEvents();
  const stream = events;
  stream.addEventListener('attachment-peer', peerSignal);
  stream.onopen = () => desktopConnection('');
  events.addEventListener('ready', () => { void synchronize(); void refreshPresence(); void refreshMentions(); void refreshProfileThemes();void typing.refresh();void restartNotice.refresh(); });
  events.addEventListener('member-persona', () => void refreshList().catch(showError));
  events.addEventListener('profile-theme', event => {const [owner,theme]=event.data.split(':');cacheProfileTheme(Number(owner),theme);});
  events.addEventListener('typing', event => {try{typing.receive(JSON.parse(event.data));}catch{}});
  events.addEventListener('typing-preference', event => {try{typing.preference(JSON.parse(event.data));}catch{}});
  events.addEventListener('profile-updated', event => scheduleProfileUpdate(event.data));
  events.addEventListener('persona-state', () => { if(!pendingVariantChoices.size)void refreshList().catch(showError); });
  events.addEventListener('presence', () => { void refreshPresence(false); });
  events.addEventListener('changed', event => synchronize(Number(event.data)));
  events.addEventListener('incoming', event => {
    const [thread, , identity] = event.data.split(':').map(Number);
    void playDmPing(event.data.split(':')[3] === 'announcement' ? announcementSignal : horizonSignal);
    void synchronize(thread);
  });
  events.addEventListener('forum-update', event => { if (Number(event.data.split(':')[0]) === active) void forum.refresh(); });
  events.addEventListener('timeline-update', event => {
    if (Number(event.data.split(':')[0]) === active) void timeline.refresh();
  });
  events.addEventListener('map-update', event => {
    if (Number(event.data.split(':')[0]) === active) void channelMap.refresh();
  });
  events.addEventListener('server-update', event => {
    if (event.data.endsWith(':invite')) playDmPing();
    void refreshList().then(() => Promise.all([channelMap.refresh(), timeline.refresh(), forum.refresh()])).catch(showError);
  });
  events.addEventListener('role-mention', event => {
    void refreshMentions();
    const [channel] = event.data.split(':').map(Number);
    if (active !== channel || document.hidden) {
      mentionedChannels.add(channel);
      drawServers();
      playDmPing();
    }
  });
  events.addEventListener('contacts-update', () => refreshList().catch(showError));
  events.addEventListener('inbox-read', () => refreshList().catch(showError));
  for (const type of ['reproxy', 'message-edited']) events.addEventListener(type, event => {
    const [thread, id] = event.data.split(':').map(Number);
    if (thread === active) void refreshReproxy(thread, id).catch(showError);
  });
  events.addEventListener('message-deleted', event => {
    const [thread, id] = event.data.split(':').map(Number);
    removeMessage(thread, id);
    if (conversations.some(item => item.id === thread)) void refreshList().catch(showError);
  });
  events.onerror = () => {
    desktopConnection('Disconnected from Horizon. Reconnecting…');
    if (isDesktop && stream.readyState === EventSource.CLOSED) {
      clearTimeout(eventRetry);
      eventRetry = setTimeout(() => {
        if (account && events === stream) connectEvents();
      }, 5000);
    }
    if (document.visibilityState === 'visible') void call('session').then(({ account: current }) => {
      if (!current && account) setAccount(null);
    }).catch(() => {});
  };
}

function profileImage(url, kind) {
  if (!url) return null;
  if (url.startsWith('data:image/webp;base64,')) return url;
  let source;
  try {
    source = new URL(url, location.origin);
  } catch {
    return null;
  }
  if (source.origin === location.origin && /^\/horizon-chat\/api\/profile-media\/[a-f0-9]{64}$/.test(source.pathname)) return isDesktop ? apiAsset(source.pathname) : source.href;
  if (source.origin === 'https://cdn.tupperbox.app' && !source.username && !source.password &&
      source.pathname.startsWith(kind === 'avatar' ? '/pfp/' : '/banner/')) return source.href;
  return null;
}

function appendProfileImage(container, url, kind, lazy = false) {
  const source = profileImage(url, kind);
  if (!source) return;
  const picture = document.createElement('img');
  picture.alt = '';
  if (lazy) picture.loading = 'lazy';
  picture.referrerPolicy = 'no-referrer';
  picture.addEventListener('load', () => picture.classList.add('loaded'), { once: true });
  picture.addEventListener('error', () => picture.remove(), { once: true });
  picture.src = source;
  container.append(picture);
}

function characterAvatar(url, lazy = false) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  appendProfileImage(avatar, url, 'avatar', lazy);
  return avatar;
}

// Presentation follows selection; sending and navigation never wait for animation.
let footerIdentity = null;
let footerTarget = null;
let footerGeneration = 0;
let footerRunning = false;
const footerMotion = matchMedia('(prefers-reduced-motion: reduce)');
function resetFooterTransition() {
  footerGeneration++;
  footerRunning = false;
  footerIdentity = footerTarget = null;
  for (const animation of $('own-profile').getAnimations({ subtree: true })) animation.cancel();
  document.querySelector('.account-profile-text').style.opacity = '';
}
function paintFooterCopy(person) {
  if ($('username').textContent !== person.name) $('username').textContent = person.name;
  $('username').title = person.name;
  const status = $('account-status');
  if (status.textContent !== person.status) status.textContent = person.status;
  status.title = person.status;
  status.hidden = !person.status;
}
function paintFooterAvatar(person) {
  if ($('avatar').dataset.footerAvatar === (person.avatar || '')) return;
  const replacement = characterAvatar(person.avatar);
  replacement.id = 'avatar';
  replacement.dataset.footerAvatar = person.avatar || '';
  $('avatar').replaceWith(replacement);
}
async function animateFooter() {
  if (footerRunning) return;
  footerRunning = true;
  const generation = footerGeneration;
  const copy = document.querySelector('.account-profile-text');
  const play = (element, frames, options) => element.animate(frames, options).finished;
  try {
    await play(copy, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-105%)', opacity: 0 }], { duration: 90, easing: 'ease-out', fill: 'forwards' });
    while (generation === footerGeneration && footerIdentity !== footerTarget.key) {
      const target = footerTarget;
      const front = $('avatar');
      const coin = document.createElement('span');
      coin.className = 'account-avatar-coin';
      const inner = document.createElement('span');
      inner.className = 'account-avatar-faces';
      const back = characterAvatar(target.avatar);
      back.dataset.footerAvatar = target.avatar || '';
      front.replaceWith(coin);
      inner.append(front, back);
      coin.append(inner);
      await play(inner, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { duration: 240, easing: 'cubic-bezier(.22,.7,.3,1)', fill: 'forwards' });
      if (generation !== footerGeneration) return;
      back.id = 'avatar';
      front.removeAttribute('id');
      coin.replaceWith(back);
      footerIdentity = target.key;
    }
    if (generation !== footerGeneration) return;
    paintFooterCopy(footerTarget);
    // Cancel the outgoing fill before starting the incoming slide.
    for (const animation of copy.getAnimations()) animation.cancel();
    await play(copy, [{ transform: 'translateX(-105%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 110, easing: 'cubic-bezier(.2,.7,.3,1)' });
  } catch (error) {
    if (error.name !== 'AbortError') console.error(error);
  } finally {
    if (generation === footerGeneration) {
      footerRunning = false;
      if (footerIdentity !== footerTarget.key) void animateFooter();
      else { paintFooterCopy(footerTarget); paintFooterAvatar(footerTarget); }
    }
  }
}
function updateAccountFooter() {
  const person = selectedProxy;
  footerTarget = {
    key: account.id + ':' + (person?.id ?? 0) + ':' + (person?.variantId ?? 0),
    name: person?.name || account.displayName,
    status: person ? person.status || '' : account.status || '',
    avatar: person ? person.avatarUrl : account.avatarUrl,
  };
  $('own-profile').setAttribute('aria-label', 'View profile: ' + footerTarget.name);
  if (footerIdentity === null || footerMotion.matches) {
    resetFooterTransition();
    footerTarget = { key: account.id + ':' + (person?.id ?? 0) + ':' + (person?.variantId ?? 0), name: person?.name || account.displayName,
      status: person ? person.status || '' : account.status || '', avatar: person ? person.avatarUrl : account.avatarUrl };
    // A cancelled coin can still contain the previous face.
    const coin = document.querySelector('.account-avatar-coin');
    if (coin) coin.replaceWith($('avatar'));
    footerIdentity = footerTarget.key;
    paintFooterAvatar(footerTarget);
    paintFooterCopy(footerTarget);
  } else if (!footerRunning && footerIdentity === footerTarget.key) {
    paintFooterAvatar(footerTarget);
    paintFooterCopy(footerTarget);
  } else void animateFooter();
  drawPersonaRail();
  updateVariantControls();
}

function showError(error) {
  $('chat-status').textContent = error.message;
}

async function synchronize(changed) {
  try {
    await refreshList();
    if (active && (!changed || active === changed)) await refreshMessages(false, !changed);
  } catch (error) {
    showError(error);
  }
}

async function refreshList() {
  const wasLocked=Boolean(activeChannel()?.locked);
  const request = ++listRequest;
  const viewer = account;
  const result = await call('conversations');
  if (request !== listRequest || viewer !== account) return;
  const previous = activeConversation();
  conversations = result.conversations;
  const ownerChanged = broadcastOwnerId !== result.broadcastOwnerId;
  broadcastOwnerId = result.broadcastOwnerId;
  if (previous?.broadcast && !activeConversation()) {
    await openThread(null, 0);
  }
  contacts = result.contacts || [];
  if (result.proxies) {
    proxies = applyPendingVariants(result.proxies);
    if (!identityRestored) {
      let id = 0;
      try { id = Number(localStorage.getItem('horizon-persona-' + account.id)); } catch {}
      selectedProxy = proxies.find(proxy => proxy.id === id) ?? null;
      inboxProxyId = selectedProxy?.id ?? 0;
      identityRestored = true;
    } else if (selectedProxy) selectedProxy = proxies.find(proxy => proxy.id === selectedProxy.id) ?? null;
    updateAccountFooter();
    updateSpeaker();publishPersona();
    if (!$('characters-menu').hidden) drawProxyRoster();
  }
  servers = result.servers || [];
  serverLayout = result.serverLayout || [];
  customEmojiCatalog = servers.flatMap(server => server.emojis.map(emoji => ({ ...emoji, server: server.name })));
  editor.refreshEmojis();
  const server = activeServer();
  if (activeServerId) updateChannelControls(activeChannel(),server);
  if (activeServerId && (!server || !server.channels.some(channel => channel.conversationId === active))) {
    const next = server?.conversationId ?? null;
    if (next !== active || !server) {
      await openThread(next, inboxProxyId, server?.id ?? null);
      return;
    }
  }
  drawList();
  updateThreadHeading();
  if (activeServerId || ownerChanged) drawMessages();
  if(wasLocked && active && !activeChannel()?.locked) await refreshMessages();
}

function drawList() {
  drawServers();
  if ($('character-binder').open) drawCharacterBinder();
  const focused = document.activeElement?.dataset.conversation;
  const identity = proxies.find(proxy => proxy.id === inboxProxyId);
  $('inbox-title').textContent = identity ? identity.name + ' · Inbox' : 'Direct Messages';
  const hasUnread = conversations.some(item => !item.inboxProxyId && item.unread);
  drawPersonaRail();
  $('dm-unread').hidden = $('chat-unread').hidden = !hasUnread;
  $('inbox').setAttribute('aria-label', hasUnread ? 'Direct messages, unread' : 'Direct messages');
  if (contactsMenu.open) drawContacts();
  const existingRows = new Map([...list.children].map(row=>[row.dataset.threadKey,row]));
  const nextRows = conversations.filter(item => (item.broadcastWriter || (item.inboxProxyId ?? 0) === inboxProxyId)).map(item => {
    const key = item.id + ':' + (item.inboxProxyId ?? 0);
    const signature = JSON.stringify(item);
    const previous = existingRows.get(key);
    if (previous?.dataset.threadSignature === signature) { previous.querySelector('.conversation').setAttribute('aria-current',String(item.id === active)); return previous; }
    const row = document.createElement('li');
    const button = document.createElement('button');
    const avatar = characterAvatar(item.avatarUrl);
    const profile = item.broadcastWriter ? document.createElement('span') : profileButton(item, 'profile-avatar', true);
    if (item.broadcastWriter) profile.className = 'profile-avatar';
    const label = document.createElement('span');
    button.className = 'conversation';
    button.dataset.conversation = item.id;
    button.setAttribute('aria-current', String(item.id === active));
    label.textContent = conversationLabel(item);
    profile.append(avatar);
    button.append(label);
    const unread = unreadBadge(item.unread);
    if (unread) {
      button.append(unread);
      button.title = 'Unread from ' + (item.unreadSender || item.displayName);
    }
    button.onclick = () => openThread(item.id, item.inboxProxyId ?? 0);
    row.className = 'conversation-row';
    row.dataset.threadKey = key; row.dataset.threadSignature = signature;row.dataset.typingThread=item.id;
    row.oncontextmenu = event => {
      event.preventDefault();
      if (!item.broadcastWriter) openPersonActions(item, event, button, item);
    };
    row.append(profile, button);
    return row;
  });
  const retained = new Set(nextRows);
  for (const row of [...list.children]) if (!retained.has(row)) row.remove();
  let cursor = list.firstElementChild;
  for (const row of nextRows) { if (row === cursor) cursor = cursor.nextElementSibling; else list.insertBefore(row,cursor); }
  if (focused) list.querySelector('[data-conversation="' + focused + '"]')?.focus();
  typing.paint();
}

function openPersonActions(person, event, trigger, item) {
  const recipient = person.senderId ?? person.peerId ?? person.id;
  const server = activeServer();
  const member = server?.members.find(entry => entry.id === recipient);
  const view = $('dm-view-profile');
  const close = $('close-dm');
  const invite = $('invite-person-action');
  const assign = $('member-roles-action');
  const kick = $('kick-member-action');
  view.hidden = close.hidden = !item;
  invite.hidden = !recipient || recipient === account.id || !servers.some(server => server.canInvite);
  assign.hidden = !canAssignMember(server, member);
  const isAdmin = member && server.assignments.some(entry =>
    entry.accountId === member.id && server.roles.some(role => role.id === entry.roleId && role.administrator));
  kick.hidden = !server?.canAdmin || !member || member.id === account.id || member.id === server.ownerId ||
    (isAdmin && !server.isOwner);
  if (close.hidden && invite.hidden && assign.hidden && kick.hidden) return;
  event.preventDefault();
  event.stopPropagation();
  invite.onclick = () => {
    $('dm-actions').hidePopover();
    openInvitePicker(person.displayName, recipient);
  };
  assign.onclick = () => {
    $('dm-actions').hidePopover();
    openMemberRoles(server, member);
  };
  const menu = $('dm-actions');
  kick.onclick = async () => {
    menu.hidePopover();
    if (!confirm('Remove ' + member.displayName + ' from ' + server.name + '?')) return;
    try {
      await call('servers/' + server.id + '/kick/' + member.id, {});
      miniProfile.hidePopover();
      await refreshList();
    } catch (error) {
      showError(error);
    }
  };
  placeContextMenu(menu, event, trigger);
  view.onclick = () => {
    menu.hidePopover();
    const anchor = trigger.closest('.conversation-row')?.querySelector('.profile-avatar') || trigger;
    openProfile(person, anchor.isConnected ? anchor : $('inbox-title'));
  };
  close.onclick = () => {
    menu.hidePopover();
    void closeConversation(item);
  };
  [view, close, invite, assign, kick].find(button => !button.hidden).focus();
}

async function closeConversation(item) {
  try {
    const identity = item.inboxProxyId ?? 0;
    await call('conversations/' + item.id + '/close', { inboxProxyId: identity });
    if (active === item.id && inboxProxyId === identity) await openThread(null);
    await refreshList();
  } catch (error) {
    showError(error);
  }
}

function placeContextMenu(menu, event, trigger) {
  if (!menu.matches(':popover-open')) menu.showPopover();
  const bounds = trigger.getBoundingClientRect();
  const x = event.clientX || bounds.left;
  const y = event.clientY || bounds.bottom;
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px';
}

for (const id of ['channel-actions', 'server-actions', 'dm-actions', 'message-actions', 'map-menu']) {
  $(id).addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const actions = [...$(id).querySelectorAll('button:not([hidden]):not(:disabled)')];
    if (!actions.length) return;
    const index = actions.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % actions.length : (index > 0 ? index - 1 : actions.length - 1);
    event.preventDefault();
    actions[next].focus();
  });
}

function control(label, caption, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = caption;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.onclick = action;
  return button;
}

let movingChannel = null;
const channelPlacement = new Set(['before', 'after', 'inside']);
const channelRoute = (server, channel) => 'servers/' + server.id + '/channels' + (channel ? '/' + channel.id : '');

async function changeChannel(server, channel, payload) {
  try {
    await call(channelRoute(server, channel), payload);
    if (activeServerId === server.id) await refreshList();
  } catch (error) {
    showError(error);
  }
}

function removeChannelFromMenu(server, channel) {
  const name = channel.kind === 'separator' ? 'this separator' : '#' + channel.name + ' and any nested channels and their messages';
  if (confirm('Delete ' + name + '?')) void changeChannel(server, channel, { remove: true });
}

function openChannelMenu(server, channel, event, anchor) {
  if (!server?.canManageChannels && !channel?.canSetPassword) return;
  const menu = $('channel-actions');
  const action = (label, callback, danger = false) => {
    const button = control(label, label, callback);
    if (danger) button.classList.add('danger');
    return button;
  };
  const closeAnd = callback => () => {
    menu.hidePopover();
    callback();
  };
  const heading = text => {
    const title = document.createElement('p');
    title.className = 'menu-section-label';
    title.textContent = text;
    return title;
  };
  const types = () => {
    const parentId = channel?.id ?? null;
    const options = Object.entries(channelKinds).map(([kind, title]) =>
      action(title + ' channel', closeAnd(() => openChannelEditor(server, null, parentId, kind))));
    options.push(action('Separator', closeAnd(() => {
      if (parentId) collapsedChannels.delete(parentId);
      void changeChannel(server, null, { kind: 'separator', parentId, everyoneVisibility: 0, roleRules: [] });
    })));
    menu.replaceChildren(heading(channel ? 'Create under ' + channel.name : 'Create channel'), ...options);
  };
  if (!server.canManageChannels) { menu.replaceChildren(action('Password protection',closeAnd(()=>openChannelPassword(channel)))); }
  else if (!channel) types();
  else {
    const neighbors = server.channels.filter(entry => entry.parentId === channel.parentId);
    const index = neighbors.findIndex(entry => entry.id === channel.id);
    const options = [];
    if (channel.canSetPassword && channel.kind !== 'separator') options.push(action('Password protection',closeAnd(()=>openChannelPassword(channel))));
    if (channel.kind !== 'separator') {
      if (channel.depth < 7) options.push(action('Create nested channel ›', () => {
        types();
        placeContextMenu(menu, event, anchor);
        menu.querySelector('button')?.focus();
      }));
      options.push(action('Edit channel', closeAnd(() => openChannelEditor(server, channel))));
    }
    if (index > 0) options.push(action('Move up', closeAnd(() => void changeChannel(server, channel, {
      move: { targetId: neighbors[index - 1].id, placement: 'before' },
    }))));
    if (index < neighbors.length - 1) options.push(action('Move down', closeAnd(() => void changeChannel(server, channel, {
      move: { targetId: neighbors[index + 1].id, placement: 'after' },
    }))));
    if (channel.parentId) options.push(action('Move out one level', closeAnd(() => void changeChannel(server, channel, {
      move: { targetId: channel.parentId, placement: 'after' },
    }))));
    const divider = document.createElement('hr');
    menu.replaceChildren(heading(channel.name), ...options, divider,
      action(channel.kind === 'separator' ? 'Delete separator' : 'Delete channel',
        closeAnd(() => removeChannelFromMenu(server, channel)), true));
  }
  placeContextMenu(menu, event, anchor);
  menu.querySelector('button')?.focus();
}

let channelTreeSignature = '';
function drawChannelTree(server) {
  const signature = JSON.stringify([server,active,[...collapsedChannels],[...mentionedChannels]]);
  if (signature === channelTreeSignature) return;
  channelTreeSignature = signature;
  const tree = $('server-channels');
  const sidebar = $('server-sidebar').parentElement;
  const menuButton = $('channel-menu-button');
  const channels = server?.channels ?? [];
  const children = new Map();
  for (const channel of channels) {
    if (!children.has(channel.parentId)) children.set(channel.parentId, []);
    children.get(channel.parentId).push(channel);
  }
  menuButton.hidden = !server?.canManageChannels;
  menuButton.onclick = event => openChannelMenu(server, null, event, menuButton);
  sidebar.oncontextmenu = event => {
    if (!server?.canManageChannels || event.target.closest('button')) return;
    event.preventDefault();
    openChannelMenu(server, null, event, menuButton);
  };
  sidebar.ondragover = event => {
    if (!movingChannel || movingChannel.server !== server?.id || event.target.closest('.channel-row')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  sidebar.ondrop = event => {
    if (!movingChannel || movingChannel.server !== server?.id || event.target.closest('.channel-row')) return;
    event.preventDefault();
    const source = movingChannel.channel;
    movingChannel = null;
    void changeChannel(server, source, { move: { placement: 'root' } });
  };

  function branch(parent) {
    return (children.get(parent) || []).map(channel => {
      const row = document.createElement('li');
      const line = document.createElement('div');
      line.className = 'channel-row';line.dataset.typingThread=channel.conversationId;
      const separator = channel.kind === 'separator';
      const name = separator ? document.createElement('hr')
        : control('Open ' + channel.name, channel.name, () => openThread(channel.conversationId, 0, server.id));
      if (separator) {
        line.classList.add('channel-separator');
        name.className = 'channel-rule';
      } else {
        name.className = 'channel-name';
        name.title = channelKinds[channel.kind] + ' channel';
        name.dataset.channelKind = channel.kind;
        if (mentionedChannels.has(channel.conversationId)) name.append(unreadBadge(true));
        name.setAttribute('aria-current', String(channel.conversationId === active));
      }
      line.append(name);
      if (children.has(channel.id)) {
        const collapsed = collapsedChannels.has(channel.id);
        const toggle = control((collapsed ? 'Expand ' : 'Collapse ') + channel.name, collapsed ? '›' : '⌄', () => {
          if (collapsed) collapsedChannels.delete(channel.id);
          else collapsedChannels.add(channel.id);
          drawChannelTree(server);
          tree.querySelector('[data-channel-toggle="' + channel.id + '"]')?.focus();
        });
        toggle.dataset.channelToggle = channel.id;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        line.append(toggle);
      }
      if (server.canManageChannels) {
        const more = control('Actions for ' + channel.name, '⋯', event => openChannelMenu(server, channel, event, more));
        more.className = 'channel-more';
        line.append(more);
        line.oncontextmenu = event => {
          event.preventDefault();
          event.stopPropagation();
          openChannelMenu(server, channel, event, more);
        };
        line.draggable = true;
        line.ondragstart = event => {
          movingChannel = { server: server.id, channel };
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', channel.name);
          line.classList.add('dragging-channel');
        };
        line.ondragend = () => {
          movingChannel = null;
          line.classList.remove('dragging-channel');
          for (const target of tree.querySelectorAll('[data-drop-position]')) delete target.dataset.dropPosition;
        };
        line.ondragover = event => {
          if (movingChannel?.server !== server.id || movingChannel.channel.id === channel.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const bounds = line.getBoundingClientRect();
          const relative = (event.clientY - bounds.top) / bounds.height;
          line.dataset.dropPosition = !separator && channel.depth < 7 && relative >= .28 && relative <= .72
            ? 'inside' : relative < .5 ? 'before' : 'after';
        };
        line.ondragleave = () => { delete line.dataset.dropPosition; };
        line.ondrop = event => {
          const placement = line.dataset.dropPosition;
          if (!movingChannel || !channelPlacement.has(placement)) return;
          event.preventDefault();
          event.stopPropagation();
          const source = movingChannel.channel;
          movingChannel = null;
          delete line.dataset.dropPosition;
          if (placement === 'inside') collapsedChannels.delete(channel.id);
          void changeChannel(server, source, { move: { targetId: channel.id, placement } });
        };
      }
      if(!server.canManageChannels && channel.canSetPassword){
        const more=control('Actions for '+channel.name,'⋯',event=>openChannelMenu(server,channel,event,more));more.className='channel-more';line.append(more);
        line.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();openChannelMenu(server,channel,event,more);};
      }
      row.append(line);
      if (children.has(channel.id) && !collapsedChannels.has(channel.id)) {
        const nested = document.createElement('ul');
        nested.className = 'channel-tree';
        nested.append(...branch(channel.id));
        row.append(nested);
      }
      return row;
    });
  }

  tree.replaceChildren(...branch(null));
}

function roleOptions(dialog, server, selected) {
  dialog.querySelector('.role-checkboxes').replaceChildren(...server.roles.map(role => {
    const option = document.createElement('label');
    option.className = 'role-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'roleId';
    checkbox.value = role.id;
    checkbox.checked = selected.includes(role.id);
    option.append(checkbox, document.createTextNode(role.name));
    return option;
  }));
}

function checkedRoles(form) {
  return new FormData(form).getAll('roleId').map(Number);
}

async function submitServerSettings(dialog, action, route, data, section = dialog) {
  const status = section.querySelector('[role="status"]');
  action.disabled = true;
  try {
    const result = await call(route, typeof data === 'function' ? await data() : data);
    if (section === dialog) dialog.close();
    else status.textContent = 'Changes saved.';
    await refreshList();
    return result;
  } catch (error) {
    if (dialog.open) status.textContent = error.message;
    else showError(error);
  } finally {
    action.disabled = false;
  }
}

function showChannelPage(page) {
  const dialog = $('channel-editor');
  for (const button of dialog.querySelectorAll('[data-channel-tab]')) {
    button.setAttribute('aria-pressed', String(button.dataset.channelTab === page));
  }
  for (const section of dialog.querySelectorAll('[data-channel-page]')) {
    section.hidden = section.dataset.channelPage !== page;
  }
}
$('channel-editor').querySelectorAll('[data-channel-tab]').forEach(button => {
  button.onclick = () => showChannelPage(button.dataset.channelTab);
});

function editChannelPermissions(server, channel, parentId) {
  const section = $('channel-permissions');
  const roleList = $('channel-permission-role-list');
  const picker = $('channel-permission-role-picker');
  const add = $('add-channel-permission');
  const privateChannel = $('channel-private');
  const description = $('channel-visibility-description');
  const parentNote = $('channel-parent-permissions');
  const parent = server.channels.find(entry => entry.id === (channel?.parentId ?? parentId));
  parentNote.hidden = !parent;
  parentNote.textContent = parent ? 'Access restrictions from ' + parent.name + ' also apply here.' : '';
  $('channel-advanced-permissions').open = true;
  const rules = new Map((channel?.roleRules || []).map(rule => [rule.roleId, rule.visibility]));
  const messageRules = Object.fromEntries(['send', 'manage'].map(key => {
    const rule = channel?.messageRules?.[key];
    return [key, { everyone: rule?.everyone ?? 0, roles: new Map((rule?.roles || []).map(entry => [entry.roleId, entry.value])) }];
  }));
  let everyoneVisibility = channel?.everyoneVisibility ?? 0;
  let selected = 0;

  function draw(focus = false) {
    const role = server.roles.find(entry => entry.id === selected);
    const listed = id => rules.has(id) || Object.values(messageRules).some(rule => rule.roles.has(id));
    const subjects = [{ id: 0, name: '@everyone' },
      ...server.roles.filter(entry => entry.id === selected || listed(entry.id))];
    roleList.replaceChildren(...subjects.map(subject => {
      const button = control(subject.name, subject.name, () => {
        selected = subject.id;
        draw(true);
      });
      button.setAttribute('aria-pressed', String(subject.id === selected));
      return button;
    }));
    const available = server.roles.filter(entry => entry.id !== selected && !listed(entry.id));
    picker.replaceChildren(new Option('Choose a role', ''), ...available.map(entry => new Option(entry.name, entry.id)));
    add.disabled = !available.length;
    picker.hidden = true;
    add.setAttribute('aria-expanded', 'false');
    privateChannel.checked = everyoneVisibility === -1;
    const visibility = selected ? (rules.get(selected) ?? 0) : everyoneVisibility;
    section.querySelector('input[name="visibility"][value="' + visibility + '"]').checked = true;
    for (const [key, rule] of Object.entries(messageRules)) {
      const value = selected ? (rule.roles.get(selected) ?? 0) : rule.everyone;
      section.querySelector('input[name="' + key + '"][value="' + value + '"]').checked = true;
    }
    description.textContent = role
      ? 'Set access for members with the ' + role.name + ' role. A role deny takes priority over a role allow.'
      : 'Set the default for server members. Deny makes the channel private.';
    if (focus) roleList.querySelector('[aria-pressed="true"]').focus();
  }

  add.onclick = () => {
    picker.hidden = !picker.hidden;
    add.setAttribute('aria-expanded', String(!picker.hidden));
    if (!picker.hidden) picker.focus();
  };
  picker.onchange = () => {
    if (!picker.value) return;
    selected = Number(picker.value);
    draw(true);
  };
  privateChannel.onchange = () => {
    everyoneVisibility = privateChannel.checked ? -1 : 0;
    draw();
  };
  for (const option of section.querySelectorAll('input[name="visibility"]')) {
    option.onchange = () => {
      const value = Number(option.value);
      if (!selected) everyoneVisibility = value;
      else if (value === 0) rules.delete(selected);
      else rules.set(selected, value);
      draw();
    };
  }
  for (const option of section.querySelectorAll('[data-message-rule] input')) {
    option.onchange = () => {
      const value = Number(option.value);
      const rule = messageRules[option.name];
      if (!selected) rule.everyone = value;
      else if (value === 0) rule.roles.delete(selected);
      else rule.roles.set(selected, value);
      draw();
    };
  }
  draw();
  return () => ({
    messageRules: Object.fromEntries(Object.entries(messageRules).map(([key, rule]) => [key, {
      everyone: rule.everyone, roles: [...rule.roles].map(([roleId, value]) => ({ roleId, value })),
    }])),
    everyoneVisibility, roleRules: [...rules].map(([roleId, visibility]) => ({ roleId, visibility })),
  });
}

function openChannelEditor(server, channel, parentId, kind = 'text') {
  const dialog = $('channel-editor');
  const form = dialog.querySelector('form');
  const remove = $('delete-channel');
  const route = 'servers/' + server.id + '/channels' + (channel ? '/' + channel.id : '');
  form.reset();
  form.querySelector('[role="status"]').textContent = '';
  dialog.querySelector('h2').textContent = channel ? channel.name : 'Create ' + channelKinds[kind].toLowerCase() + ' channel';
  showChannelPage('overview');
  form.elements.name.value = channel?.name || '';
  form.elements.topic.value = channel?.topic || '';
  form.elements.kind.value = channel?.kind || kind;
  form.elements.kind.disabled = Boolean(channel);
  form.elements.name.oninvalid = () => showChannelPage('overview');
  const readPermissions = editChannelPermissions(server, channel, parentId);
  remove.hidden = !channel;
  remove.onclick = () => {
    if (confirm('Delete #' + channel.name + ' and any nested channels and their messages?')) {
      void submitServerSettings(dialog, remove, route, { remove: true });
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const result = await submitServerSettings(dialog, form.querySelector('[type="submit"]'), route, {
      name: form.elements.name.value, topic: form.elements.topic.value, kind: form.elements.kind.value, parentId, ...readPermissions(),
    });
    if (!result || channel || activeServerId !== server.id) return;
    if (parentId) collapsedChannels.delete(parentId);
    const created = activeServer()?.channels.find(entry => entry.id === result.channelId);
    if (created) await openThread(created.conversationId, 0, server.id);
  };
  dialog.showModal();
  form.elements.name.select();
}

const rolePermissionFields = ['canManageEmojis', 'canManageRoles', 'canAttach', 'canMentionRoles', 'canManageMessages'];

function paintRole(element, stops = []) {
  element.classList.toggle('gradient-role', stops.length > 1);
  element.style.removeProperty('--role-gradient');
  element.style.color = stops[0]?.value || '';
  if (stops.length > 1) {
    const colors = stops.map(stop => stop.value + ' ' + stop.offset + '%');
    element.style.setProperty('--role-gradient', 'linear-gradient(90deg, ' + colors.join(', ') + ')');
  }
}

function authorRole(server, accountId) {
  return server?.roles.find(role => role.color?.length &&
    server.assignments.some(entry => entry.accountId === accountId && entry.roleId === role.id));
}

function roleColorEditor(role, form) {
  const mode = $('role-color-style');
  const container = $('role-color-stops');
  const preview = $('role-color-preview');
  const defaults = ['#b094f0', '#ec85b9', '#ffce84'];
  let stops = (role?.color || []).map(stop => ({ ...stop }));
  mode.value = String(stops.length);
  const paint = () => {
    preview.textContent = form.elements.name.value || 'Role color preview';
    paintRole(preview, stops);
  };
  function draw() {
    container.replaceChildren(...stops.map((stop, index) => {
      const row = document.createElement('div');
      row.className = 'role-color-stop';
      const color = document.createElement('input');
      color.type = 'color';
      color.value = stop.value;
      color.setAttribute('aria-label', 'Color ' + (index + 1));
      color.oninput = () => { stop.value = color.value; paint(); };
      row.append(color);
      if (stops.length > 1) {
        const offset = document.createElement('input');
        offset.type = 'range';
        offset.min = '0';
        offset.max = '100';
        offset.value = stop.offset;
        offset.setAttribute('aria-label', 'Gradient stop ' + (index + 1));
        const value = document.createElement('output');
        value.textContent = stop.offset + '%';
        offset.oninput = () => {
          const min = index ? stops[index - 1].offset + 1 : 0;
          const max = index < stops.length - 1 ? stops[index + 1].offset - 1 : 100;
          stop.offset = Math.max(min, Math.min(max, Number(offset.value)));
          offset.value = stop.offset;
          value.textContent = stop.offset + '%';
          paint();
        };
        row.append(offset, value);
      }
      return row;
    }));
    paint();
  }
  mode.onchange = () => {
    const count = Number(mode.value);
    stops = Array.from({ length: count }, (_, index) => ({
      value: stops[index]?.value || defaults[index], offset: count === 1 ? 0 : Math.round(index * 100 / (count - 1)),
    }));
    draw();
  };
  form.elements.name.oninput = paint;
  draw();
  return () => stops;
}

function canAssignMember(server, person) {
  if (!server?.canManageRoles || !person || person.id === server.ownerId) return false;
  if (server.isOwner) return true;
  return person.id !== account.id && server.assignments.every(entry =>
    entry.accountId !== person.id || server.editableRoleIds.includes(entry.roleId));
}

function drawEmojiSettings() {
  const server = activeServer();
  const section = $('server-emoji-settings');
  const form = section.querySelector('form');
  const route = 'servers/' + server.id + '/emojis';
  async function update(button, data) {
    if (await submitServerSettings(serverSettings, button, route, data, section)) {
      drawEmojiSettings();
      return true;
    }
    return false;
  }
  function imageFor(emoji) {
    const image = document.createElement('img');
    image.src = apiAsset(emoji.url);
    image.alt = '';
    image.loading = 'lazy';
    return image;
  }
  $('server-emoji-list').replaceChildren(...server.emojis.map(emoji => {
    const row = document.createElement('li');
    const name = document.createElement('input');
    name.value = emoji.name;
    name.maxLength = 32;
    name.setAttribute('aria-label', 'Name for :' + emoji.name + ':');
    const rename = control('Rename :' + emoji.name + ':', 'Rename', () => update(rename, { ref: emoji.ref, name: name.value }));
    const remove = control('Delete :' + emoji.name + ':', 'Delete', () => update(remove, { ref: emoji.ref, remove: true }));
    row.append(imageFor(emoji), name, rename, remove);
    return row;
  }));
  const retired = server.retiredEmojis || [];
  $('retired-emoji-settings').hidden = !retired.length;
  $('retired-emoji-list').replaceChildren(...retired.map(emoji => {
    const row = document.createElement('li');
    const purge = control('Purge :' + emoji.name + ': ' + emoji.ref, 'Purge artwork', () => {
      if (window.confirm('Purge this artwork? Existing messages will show a missing emoji.')) {
        return update(purge, { ref: emoji.ref, purge: true });
      }
    });
    row.append(imageFor(emoji), ':' + emoji.name + ': ' + emoji.ref, purge);
    return row;
  }));
  form.onsubmit = async event => {
    event.preventDefault();
    const file = form.elements.image.files[0];
    const name = form.elements.name.value;
    const data = async () => {
      if (!file || !['image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 220 * 1024) {
        throw new Error('Choose a PNG, WebP, or GIF up to 220 KB.');
      }
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the image.'));
        reader.readAsDataURL(file);
      });
      return { name, image };
    };
    if (await update(form.querySelector('button'), data)) form.reset();
  };
}

function drawRoleEditor(roleId = null) {
  const server = activeServer();
  const section = $('role-editor');
  const form = section.querySelector('form');
  const remove = $('delete-role');
  const role = server.roles.find(entry => entry.id === roleId);
  const editableRoles = server.roles.filter(entry => server.editableRoleIds.includes(entry.id));
  $('server-role-list').replaceChildren(...[{ id: null, name: 'New role' }, ...editableRoles].map(entry => {
    const button = control(entry.name, entry.name, () => {
      drawRoleEditor(entry.id);
      form.elements.name.focus();
    });
    button.setAttribute('aria-pressed', String(entry.id === (role?.id ?? null)));
    paintRole(button, entry.color);
    return button;
  }));
  form.elements.name.value = role?.name || '';
  form.elements.invite.checked = Boolean(role?.canInvite);
  form.elements.channels.checked = Boolean(role?.canManageChannels);
  form.elements.administrator.checked = Boolean(role?.administrator);
  for (const name of rolePermissionFields) {
    form.elements[name].checked = role?.[name] ?? (name === 'canAttach');
  }
  const readColors = roleColorEditor(role, form);
  remove.hidden = !role;
  const status = form.querySelector('[role="status"]');
  status.textContent = '';
  const route = 'servers/' + server.id + '/roles' + (role ? '/' + role.id : '');
  const index = editableRoles.indexOf(role);
  for (const [id, move, enabled] of [
    ['raise-role', 'up', index > 0], ['lower-role', 'down', index >= 0 && index < editableRoles.length - 1],
  ]) {
    const button = $(id);
    button.hidden = !enabled;
    button.onclick = async () => {
      if (await submitServerSettings(serverSettings, button, route, { move }, section)) drawRoleEditor(role.id);
    };
  }
  remove.onclick = async () => {
    if (!confirm('Delete this server role?')) return;
    const result = await submitServerSettings(serverSettings, remove, route, { remove: true }, section);
    if (result && serverSettings.open) drawRoleEditor();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const result = await submitServerSettings(serverSettings, form.querySelector('[type="submit"]'), route, {
      name, canInvite: form.elements.invite.checked,
      canManageChannels: form.elements.channels.checked,
      administrator: form.elements.administrator.checked,
      ...Object.fromEntries(rolePermissionFields.map(key => [key, form.elements[key].checked])),
      color: readColors(),
    }, section);
    if (result && serverSettings.open) {
      drawRoleEditor(activeServer().roles.find(entry => entry.name === name)?.id);
      status.textContent = 'Role saved.';
    }
  };
}

function openServerPage(page) {
  for (const button of serverSettings.querySelectorAll('[data-server-tab]')) {
    button.setAttribute('aria-pressed', String(button.dataset.serverTab === page));
  }
  for (const section of serverSettings.querySelectorAll('[data-server-page]')) {
    section.hidden = section.dataset.serverPage !== page;
  }
  serverSettings.querySelector('.server-settings-body').scrollTop = 0;
  if (page === 'members') drawSettingsMembers();
  if (page === 'roles') drawRoleEditor();
  if (page === 'audit') loadServerAudit();
  if (page === 'emojis') drawEmojiSettings();
}

serverSettings.querySelectorAll('[data-server-tab]').forEach(button => {
  button.onclick = () => openServerPage(button.dataset.serverTab);
});
$('server-settings-toggle').onclick = () => {
  const server = activeServer();
  if (server.canAdmin) prepareServerProfile();
  $('server-member-search').value = '';
  openServerPage(server.canAdmin ? 'profile' : server.canManageRoles ? 'roles' : 'emojis');
  serverSettings.showModal();
};
serverSettings.addEventListener('close', releasePreviewImages);

function releasePreviewImages() {
  previewImages.forEach(url => URL.revokeObjectURL(url));
  previewImages = [];
}

function prepareServerProfile() {
  const server = activeServer();
  const dialog = $('server-profile-editor');
  const form = dialog.querySelector('form');
  form.reset();
  form.elements.name.value = server.name;
  form.elements.removeIcon.closest('label').hidden = !server.iconUrl;
  form.elements.theme.value = server.theme || 'sage';
  form.querySelector('[role="status"]').textContent = '';
  form.oninput = () => drawServerPreview(server, form);
  drawServerPreview(server, form);
  form.onsubmit = async event => {
    event.preventDefault();
    const icon = form.elements.icon.files[0];
    const result = await submitServerSettings(serverSettings, form.querySelector('[type="submit"]'), 'servers/' + server.id + '/profile', async () => ({
      name: form.elements.name.value,
      icon: icon ? await encodeProfileImage(icon, 'avatar') : form.elements.removeIcon.checked ? '' : undefined,
      theme: form.elements.theme.value,
    }), dialog);
    if (result && serverSettings.open) {
      prepareServerProfile();
      form.querySelector('[role="status"]').textContent = 'Server profile saved.';
    }
  };
}

function drawServerPreview(server, form) {
  releasePreviewImages();
  const imageFor = (field, current, remove, kind) => {
    const file = form.elements[field].files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      previewImages.push(url);
      return url;
    }
    return form.elements[remove].checked ? null : profileImage(current, kind);
  };
  $('server-preview-background').closest('.server-preview').dataset.previewTheme = form.elements.theme.value;
  const icon = imageFor('icon', server.iconUrl, 'removeIcon', 'avatar');
  const name = form.elements.name.value.trim() || server.name;
  $('server-preview-icon').textContent = icon ? '' : serverInitials(name);
  $('server-preview-icon').style.backgroundImage = icon ? 'url("' + icon + '")' : '';
  $('server-preview-name').textContent = name;
  $('server-preview-members').textContent = server.members.length + (server.members.length === 1 ? ' member' : ' members');
}

function loadServerAudit() {
  const server = activeServer();
  const dialog = $('server-audit');
  const list = dialog.querySelector('ol');
  const status = dialog.querySelector('[role="status"]');
  const more = $('older-server-audit');
  let before;
  async function load() {
    more.disabled = true;
    try {
      const result = await call('servers/' + server.id + '/audit' + (before ? '?before=' + before : ''));
      for (const entry of result.entries) {
        const row = document.createElement('li');
        const detail = document.createElement('strong');
        detail.textContent = entry.action + (entry.detail ? ' — ' + entry.detail : '');
        const byline = document.createElement('small');
        byline.textContent = entry.actor + ' · ' + clock.format(entry.recordedAt);
        row.append(detail, byline);
        list.append(row);
        before = entry.id;
      }
      status.textContent = list.children.length ? '' : 'No server activity recorded yet.';
      more.hidden = !result.hasOlder;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      more.disabled = false;
    }
  }
  list.replaceChildren();
  more.hidden = true;
  more.onclick = load;
  status.textContent = 'Loading activity…';
  void load();
}

$('open-server-delete').onclick = () => {
  const server = activeServer();
  const dialog = $('server-delete');
  const form = dialog.querySelector('form');
  form.reset();
  $('confirm-server-name').textContent = 'Enter ' + server.name + ' to confirm.';
  form.querySelector('[role="status"]').textContent = '';
  form.onsubmit = event => {
    event.preventDefault();
    void submitServerSettings(dialog, form.querySelector('[type="submit"]'), 'servers/' + server.id + '/delete', {
      name: form.elements.name.value,
    });
  };
  dialog.showModal();
};


function openMemberRoles(server, person) {
  const dialog = $('member-roles');
  const form = dialog.querySelector('form');
  dialog.querySelector('h2').textContent = 'Roles for ' + person.displayName;
  dialog.querySelector('[role="status"]').textContent = '';
  roleOptions(dialog, { ...server, roles: server.roles.filter(role => server.editableRoleIds.includes(role.id)) }, server.assignments.filter(entry => entry.accountId === person.id).map(entry => entry.roleId));
  form.onsubmit = event => {
    event.preventDefault();
    void submitServerSettings(dialog, form.querySelector('[type="submit"]'),
      'servers/' + server.id + '/members/' + person.id, { roleIds: checkedRoles(form) });
  };
  dialog.showModal();
}

function openInvitePicker(name, recipientId) {
  const dialog = $('invite-person');
  const status = dialog.querySelector('[role="status"]');
  const eligible = servers.filter(server => server.canInvite && !server.members.some(person => person.id === recipientId));
  dialog.querySelector('h2').textContent = 'Invite ' + name;
  status.textContent = eligible.length ? '' : 'There are no eligible servers for this person.';
  dialog.querySelector('.invite-options').replaceChildren(...eligible.map(server =>
    control('Invite to ' + server.name, server.name, async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await call('servers/' + server.id + '/invite', { recipientId });
        status.textContent = 'Invitation sent to ' + name + '.';
        button.remove();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    }),
  ));
  miniProfile.hidePopover();
  dialog.showModal();
}

function serverInitials(name) {
  return name.split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();
}

function drawSettingsMembers() {
  const server = activeServer();
  const search = $('server-member-search').value.trim().toLowerCase();
  const members = server.members.filter(person =>
    [person.displayName, publicHandle(person)].some(value => value?.toLowerCase().includes(search)));
  $('server-member-status').textContent = members.length ? '' : 'No matching members.';
  $('server-settings-member-list').replaceChildren(...members.map(person => {
    const row = document.createElement('li');
    const profile = document.createElement('div');
    const name = document.createElement('strong');
    const roles = document.createElement('small');
    name.textContent = person.displayName;
    paintRole(name, authorRole(server, person.id)?.color);
    roles.textContent = person.id === server.ownerId ? 'Owner' : server.roles
      .filter(role => server.assignments.some(entry => entry.accountId === person.id && entry.roleId === role.id))
      .map(role => role.name).join(', ');
    profile.append(name, roles);
    row.append(characterAvatar(person.avatarUrl), profile);
    if (canAssignMember(server, person)) {
      row.append(control('Manage roles for ' + person.displayName, 'Manage roles', () => openMemberRoles(server, person)));
    }
    return row;
  }));
}
$('server-member-search').oninput = drawSettingsMembers;

function inviteContactsTo(server) {
  const dialog = $('invite-person');
  const status = dialog.querySelector('[role="status"]');
  const eligible = contacts.filter(contact => !server.members.some(member => member.id === contact.id));
  dialog.querySelector('h2').textContent = 'Invite contacts to ' + server.name;
  status.textContent = eligible.length ? '' : 'There are no contacts to invite to this server.';
  dialog.querySelector('.invite-options').replaceChildren(...eligible.map(contact =>
    control('Invite ' + contact.displayName, contact.displayName, async event => {
      const action = event.currentTarget;
      action.disabled = true;
      try {
        await call('servers/' + server.id + '/invite', { recipientId: contact.id });
        status.textContent = 'Invitation sent to ' + contact.displayName + '.';
        action.remove();
      } catch (error) {
        status.textContent = error.message;
        action.disabled = false;
      }
    }),
  ));
  dialog.showModal();
}

function openServerActions(server, event, anchor) {
  if (!server.canInvite && server.isOwner) return;
  event.preventDefault();
  const menu = $('server-actions');
  const label = document.createElement('p');
  label.className = 'menu-section-label';
  label.textContent = server.name;
  const actions = [label];
  if (server.canInvite) actions.push(control('Invite contacts', 'Invite contacts', () => {
    menu.hidePopover();
    inviteContactsTo(server);
  }));
  if (!server.isOwner) {
    const leave = control('Leave server', 'Leave server', async () => {
      menu.hidePopover();
      if (!confirm('Leave ' + server.name + '?')) return;
      try {
        await call('servers/' + server.id + '/leave', {});
        await refreshList();
      } catch (error) {
        showError(error);
      }
    });
    leave.classList.add('danger');
    actions.push(leave);
  }
  menu.replaceChildren(...actions);
  placeContextMenu(menu, event, anchor);
  menu.querySelector('button')?.focus();
}

function renderServerButton(server) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-control';
    button.classList.toggle('selected', server.id === activeServerId);
    button.dataset.server = server.id;
    button.title = server.name;
    button.setAttribute('aria-label', server.name);
    button.setAttribute('aria-current', String(server.id === activeServerId));
    if (profileImage(server.iconUrl, 'avatar')) {
      const icon = document.createElement('span');
      icon.className = 'rail-server-icon';
      icon.setAttribute('aria-hidden', 'true');
      appendProfileImage(icon, server.iconUrl, 'avatar');
      button.classList.add('rail-artwork');
      button.append(icon);
    } else button.textContent = serverInitials(server.name);
    if (server.channels.some(channel => mentionedChannels.has(channel.conversationId))) button.append(unreadBadge(true));
    button.onclick = () => openThread(server.conversationId, 0, server.id);
    button.oncontextmenu = event => openServerActions(server, event, button);
    button.onkeydown = event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openServerActions(server, event, button);
    };
    return button;
}

let serverPeopleSignature = '';
function drawServers() {
  const current = activeServer();
  const focused = document.activeElement?.dataset.server;
  serverRail.update(servers, serverLayout, [...mentionedChannels].sort().join(','));
  for (const button of $('server-list').querySelectorAll('[data-server]')) {
    const selected = Number(button.dataset.server) === activeServerId;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-current', String(selected));
  }
  serverLayout = null;
  if (focused) $('server-list').querySelector('[data-server="' + focused + '"]')?.focus();
  $('inbox').classList.toggle('selected', !current);
  $('server-name').textContent = current?.name || '';
  $('server-invite').hidden = !current?.inviteCode;
  const settingsAllowed = current?.canAdmin || current?.canManageRoles || current?.canManageEmojis;
  $('server-settings-toggle').hidden = !settingsAllowed;
  $('server-settings-title').textContent = current?.name || 'Server settings';
  if (!settingsAllowed && serverSettings.open) {
    $('server-delete').close();
    $('member-roles').close();
    serverSettings.close();
  }
  if (serverSettings.open && !$('server-settings-members').hidden) drawSettingsMembers();
  $('edit-server-profile').hidden = $('view-server-audit').hidden = !current?.canAdmin;
  $('manage-server-roles').hidden = !current?.canManageRoles;
  $('manage-server-emojis').hidden = !current?.canManageEmojis;
  $('open-server-delete').hidden = !current?.isOwner;
  if (serverSettings.open && serverSettings.querySelector('[data-server-tab][aria-pressed="true"]')?.hidden) {
    $('server-delete').close();
    const available = [...serverSettings.querySelectorAll('[data-server-tab]')].find(button => !button.hidden);
    if (available) openServerPage(available.dataset.serverTab);
  }
  applyServerTheme();
  drawChannelTree(current);
  typing.paint();
  const peopleSignature = JSON.stringify([current?.id, current?.ownerId, current?.members, current?.roles, current?.assignments,selectedProxy]);
  if (peopleSignature !== serverPeopleSignature) {
  serverPeopleSignature = peopleSignature;
  const memberRows=new Map([...$('server-people').children].map(row=>[row.dataset.memberId,row]));
  const nextRows=(current?.members || []).map(person => {
    const own=person.id===account.id,identity=own?(selectedProxy?{displayName:selectedProxy.name,bio:selectedProxy.description,...selectedProxy,proxyId:selectedProxy.id,senderId:account.id}:null):person.activeIdentity;
    const shown=identity?{...person,...identity,id:person.id,publicTag:undefined}:person;
    const signature=JSON.stringify([shown,current.ownerId,current.roles,current.assignments]);
    const previous=memberRows.get(String(person.id));if(previous?.dataset.signature===signature)return previous;
    const row = document.createElement('li');
    row.dataset.memberId=String(person.id);row.dataset.signature=signature;
    const button = profileButton(shown, 'server-person');
    const label = document.createElement('span');
    label.textContent = person.displayName;
    paintRole(label, authorRole(current, person.id)?.color);
    button.append(characterAvatar(shown.avatarUrl), label);
    if (person.id === current.ownerId) {
      const badge = document.createElement('small');
      badge.textContent = 'Owner';
      button.append(badge);
    }
    row.append(button);
    const roles = current.roles.filter(role => current.assignments.some(entry => entry.accountId === person.id && entry.roleId === role.id));
    if (roles.length) {
      const tags = document.createElement('small');
      tags.className = 'member-role-label';
      tags.textContent = roles.map(role => role.name).join(', ');
      row.append(tags);
    }
    return row;
  });
  const list=$('server-people');nextRows.forEach((row,index)=>{if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);});for(const row of [...list.children])if(!nextRows.includes(row))row.remove();
  }
}

function updateThreadHeading() {
  const thread = activeConversation();
  const server = activeServer();
  const channel = activeChannel();
  $('history').setAttribute('aria-label', channel ? channel.name + ' channel history' : 'Conversation history');
  $('draft').dataset.placeholder = thread?.broadcastWriter ? 'Message Everyone' : channel ? 'Message ' + channel.name : 'Message...';
  $('close-broadcast').hidden = !thread?.broadcast || Boolean(thread.broadcastWriter);
  $('thread-title').textContent = server ? (channel ? channel.name : server.name) : thread ? conversationLabel(thread) : $('inbox-title').textContent;
  const topic = $('channel-topic');
  topic.textContent = channel?.topic || '';
  topic.title = topic.textContent;
  topic.hidden = !topic.textContent;
  $('thread-title').disabled = !thread || Boolean(thread.broadcastWriter);
  $('thread-title').title = thread && !thread.broadcastWriter ? 'View profile' : '';
  const kind = $('channel-kind');
  kind.textContent = channelKinds[channel?.kind] || '';
  kind.hidden = !channel || channel.kind === 'text';
  updateChannelControls(channel, server);
}

let showChannelView = true;
const timeline = createTimeline({ request: call });
const channelMap = createChannelMap({
  request: call,
  encodeImage: encodeMapImage,
  openChat(id) {
    if (activeServer()?.channels.some(channel => channel.conversationId === id)) {
      void openThread(id, 0, activeServerId);
    }
  },
  showDetails(visible) {
    const panel = $('server-member-panel');
    const opened = visible && !panel.hidden;
    panel.hidden = visible;
    if (opened) {
      app.setAttribute('data-show-members', '');
      $('toggle-server-members').setAttribute('aria-expanded', 'true');
    }
  },
});

$('toggle-map-view').onclick = () => {
  showChannelView = !showChannelView;
  updateThreadHeading();
  drawMessages();
};

let forumEditorState = null;
const forumRichEditor = {
  mount(target, body, format, submit) {
    this.unmount();
    closeMessageEditor();
    const tray = $('format-tray');
    forumEditorState = { viewer: account, snapshot: editor.snapshot(), toolbarHidden: tray.hidden, toggleHidden: $('format-toggle').hidden, expanded: $('format-toggle').getAttribute('aria-expanded'), nodes: [composer].map(node => ({ node, parent: node.parentNode, next: node.nextSibling, hidden: node.hidden })),
      inert: $('format-panel').inert, open: tray.hasAttribute('data-open'), submit: event => { event.preventDefault(); event.stopImmediatePropagation(); submit(); } };
    let parsed; try { parsed = format && JSON.parse(format); } catch {}
    editor.restore(parsed?.kind === 'code' ? { code: body, language: parsed.language } : { nodes: parsed?.kind === 'rich' ? parsed.nodes : [body] });
    for (const { node } of forumEditorState.nodes) { target.append(node); node.hidden = false; }
    tray.hidden = false; $('format-toggle').hidden = false;
    tray.removeAttribute('data-open'); $('format-panel').inert = true; $('format-toggle').setAttribute('aria-expanded','false');
    composer.addEventListener('submit', forumEditorState.submit, true);
    editor.focus();
  },
  unmount() {
    if (!forumEditorState) return;
    const state = forumEditorState; forumEditorState = null;
    composer.removeEventListener('submit', state.submit, true);
    for (const { node, parent, next, hidden } of state.nodes) { parent.insertBefore(node, next?.parentNode === parent ? next : null); node.hidden = hidden; }
    $('format-tray').toggleAttribute('data-open', state.open); $('format-panel').inert = state.inert;
    $('format-tray').hidden = state.toolbarHidden; $('format-toggle').hidden = state.toggleHidden; $('format-toggle').setAttribute('aria-expanded',state.expanded);
    editor.restore(state.viewer === account ? state.snapshot : undefined);
  },
  message: () => editor.message(),
  render: (body, format) => editor.render({ body, format }, () => document.createTextNode(''), activeServer()?.legacyEmojis),
};
const forum = createForumView({
  richEditor: forumRichEditor,
  history, request: call, identity: () => ({ proxyId: selectedProxy?.id, variantId: selectedProxy?.variantId, inboxProxyId }), onError: showError,
  renderMessage: (post, thread) => editor.render({ body: post.title, format: post.format }, file => documents.render(file, thread, post.id), activeServer()?.legacyEmojis),
  canEdit: post => post.senderId === account?.id,
  canDelete: post => post.senderId === account?.id || activeChannel()?.canManageMessages || account?.id === broadcastOwnerId,
  messageMenu: (thread, post, x, y, trigger, edit) => openMessageActions(thread, post, x, y, trigger, { replyable: false, editable: Boolean(edit), deletable: post.senderId === account?.id || activeChannel()?.canManageMessages || account?.id === broadcastOwnerId, edit }),
  onSelect: () => {
    closeMessageEditor();typing.changed();
    replyDrafts.delete(draftKey(active));
    editor.restore(); entries = []; messageRequest++;
    updateChannelControls(activeChannel(), activeServer()); drawMessages();
    return refreshMessages().catch(showError);
  },
});

function updateChannelControls(channel, server) {
  const locked=Boolean(channel?.locked);
  const gate=$('channel-password-gate');const newGate=gate.hidden||gate.dataset.conversation!==String(channel?.conversationId);
  gate.hidden=!locked;gate.dataset.conversation=channel?.conversationId||'';
  if(locked){
    if(newGate){documents.reset();$('unlock-channel').reset();$('unlock-channel').querySelector('[role=status]').textContent='';}
    closeMessageEditor();forum.hide();channelMap.hide();timeline.hide();entries=[];$('direct-messages').replaceChildren();
    history.hidden=composer.hidden=$('format-tray').hidden=$('format-toggle').hidden=true;
    $('channel-readonly').hidden=$('channel-extras').hidden=$('reply-draft').hidden=true;
    return;
  }
  const thread = activeConversation();
  const readOnly = thread?.broadcast && !thread.broadcastWriter;
  const hasCustomView = channel?.kind === 'map' || channel?.kind === 'timeline';
  const viewingChannel = hasCustomView && showChannelView;
  const toggle = $('toggle-map-view');
  toggle.hidden = !hasCustomView;
  toggle.textContent = viewingChannel ? 'Chat' : channelKinds[channel?.kind] || 'Chat';
  const isForum = channel?.kind === 'forum';
  if (isForum) forum.show(channel); else forum.hide();
  const forumList = isForum && !forum.postId;
  if (isForum && forum.composing) { history.hidden = true; return; }
  history.hidden = viewingChannel || forumList;
  if (viewingChannel && channel.kind === 'map') channelMap.show(channel.conversationId, server.channels.filter(entry => entry.kind !== 'separator'));
  else channelMap.hide();
  if (viewingChannel && channel.kind === 'timeline') timeline.show(channel.conversationId);
  else timeline.hide();
  const canSend = Boolean(active && channel?.canSend !== false && !readOnly && !viewingChannel && !forumList);
  if (!canSend && messageEdit) closeMessageEditor();
  composer.hidden = $('format-toggle').hidden = $('format-tray').hidden = !canSend;
  updateReplyDraft();
  updateCharacterCount();
  $('attach-file').hidden = channel?.canAttach === false;
  $('channel-readonly').hidden = forumList || viewingChannel || (!readOnly && (!channel || canSend || channel.kind === 'voice'));
  $('channel-readonly').textContent = readOnly ? 'This chat is read-only.' : 'This channel is read-only.';
  const extras = $('channel-extras');
  extras.replaceChildren();
  extras.hidden = channel?.kind !== 'voice';
  history.dataset.channelKind = channel?.kind || '';
  if (channel?.kind === 'voice') {
    extras.textContent = 'Voice room · Audio is coming later.';

  }
}

function showThread() {
  const server = activeServer();
  app.toggleAttribute('data-server', Boolean(server));
  app.removeAttribute('data-show-members');
  $('toggle-server-members').setAttribute('aria-expanded', 'false');
  $('server-sidebar').hidden = $('server-members').hidden = $('toggle-server-members').hidden = !server;
  updateThreadHeading();
  updateSpeaker();
  app.toggleAttribute('data-thread', Boolean(active || server));
  $('older').hidden = true;
  $('chat-status').textContent = '';
  entries = [];
  drawMessages();
}

const restartNotice=createRestartNotice(call);
const typing=createTypingUI({call,viewer:()=>account,scope:()=>active?{conversationId:active,postId:activeChannel()?.kind==='forum'?forum.postId:null}:null,identity:()=>({proxyId:selectedProxy?.id,variantId:selectedProxy?.variantId,inboxProxyId}),canType:()=>Boolean(account&&active&&!composer.hidden&&!messageEdit&&!forum.composing&&activeChannel()?.canSend!==false)});

async function openThread(id, identity = inboxProxyId, serverId = null) {
  if (forum.composing) forum.cancelCompose();
  closeDice();
  typing.stop();
  closeMessageEditor();
  if (active) drafts.set(draftKey(active), editor.snapshot());
  if (!serverId) {
    inboxProxyId = identity;
    if (id && !identity) lastAccountDm = id;
  }
  if (activeServerId !== serverId) {
    for (const id of ['channel-editor', 'member-roles', 'server-settings-screen', 'server-delete']) $(id).close();
  }
  activeServerId = serverId;
  if (active !== id) showChannelView = true;
  active = id;typing.changed();
  mentionedChannels.delete(id);
  if (id) void call('mentions/read', { conversationId: id }).catch(() => {});
  drawList();
  showThread();
  editor.restore(drafts.get(draftKey(id)));
  if (!id) return;
  try {
    await refreshMessages();
    if (active === id) history.scrollTop = history.scrollHeight;
  } catch (error) {
    showError(error);
  }
}

function unreadBadge(count) {
  if (!count) return null;
  const badge = document.createElement('img');
  badge.className = 'unread-badge';
  badge.dataset.themeImage = 'ping';
  badge.alt = 'Unread';
  return badge;
}

function identityTile(label, avatarUrl, unread, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inbox-choice inbox-tile';
  const text = document.createElement('span');
  text.textContent = label;
  const face = document.createElement('span');
  face.className = 'inbox-face';
  face.append(characterAvatar(avatarUrl));
  const badge = unreadBadge(unread);
  if (badge) face.append(badge);
  button.append(face, text);
  button.onclick = onClick;
  return button;
}

function contactsIdentity() {
  return selectedProxy?.id ?? 0;
}

function drawContacts() {

  const search = $('contact-search').value.trim().toLowerCase();
  const matches = contacts.filter(person =>
    [person.displayName, publicHandle(person)].some(value => value?.toLowerCase().includes(search)));
  const empty = $('contacts-empty');
  empty.hidden = matches.length > 0;
  empty.textContent = contacts.length ? 'No matching contacts.' : 'Add a contact using their full Horizon Chat handle.';
  const unreadThreads = conversations.filter(thread => (thread.inboxProxyId ?? 0) === (selectedProxy?.id ?? 0) && thread.unread);
  $('contact-unread').hidden = !unreadThreads.length;
  $('contact-unread-list').replaceChildren(...unreadThreads.map(thread => {
    const label = conversationLabel(thread);
    const button = control('Open unread conversation with ' + label, label, () => {
      contactsMenu.close();
      void openThread(thread.id, selectedProxy?.id ?? 0);
    });
    button.className = 'inbox-choice';
    button.append(unreadBadge(true));
    return button;
  }));
  const identity = contactsIdentity();
  const everyone = conversations.find(thread => thread.broadcastWriter);
  const pinned = everyone && identityTile('Everyone', everyone.avatarUrl, false, () => {
    contactsMenu.close();
    void openThread(everyone.id, 0);
  });
  $('contact-options').replaceChildren(...(pinned ? [pinned] : []), ...matches.map(person => {
    const tile = document.createElement('div');
    tile.className = 'picker-tile';
    const unread = conversations.some(thread => (thread.inboxProxyId ?? 0) === identity &&
      thread.peerId === person.id && !thread.proxyId && thread.unread);
    const button = identityTile(person.displayName, person.avatarUrl, unread, async () => {
      try {
        button.disabled = true;
        await startConversation({ recipientId: person.id }, identity);
        contactsMenu.close();
        editor.focus();
      } catch (error) {
        $('contacts-status').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    const remove = control('Remove contact ' + person.displayName, 'Remove', async () => {
      try {
        remove.disabled = true;
        const viewer = account;
        const result = await call('contacts', { contactId: person.id, remove: true });
        if (viewer !== account) return;
        contacts = result.contacts;
        drawContacts();
        $('contact-search').focus();
      } catch (error) {
        $('contacts-status').textContent = error.message;
      } finally {
        remove.disabled = false;
      }
    });
    remove.className = 'picker-secondary';
    tile.append(button, remove);
    return tile;
  }));
}

function openContacts() {
  if (!account) return;
  $('contact-search').value = '';
  $('contacts-status').textContent = '';
  drawContacts();
  contactsMenu.showModal();
  $('contact-search').focus();
  void refreshList().catch(error => { $('contacts-status').textContent = error.message; });
}

$('contact-search').oninput = drawContacts;
$('open-contacts-inbox').onclick = async () => {
  contactsMenu.close();
  await openThread(null, contactsIdentity());
};
$('add-contact').onclick = () => {
  const form = contactEditor.querySelector('form');
  form.reset();
  form.querySelector('[role="status"]').textContent = '';
  contactEditor.showModal();
};
contactEditor.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const viewer = account;
  submit.disabled = true;
  try {
    const result = await call('contacts', Object.fromEntries(new FormData(form)));
    if (viewer !== account) return;
    contacts = result.contacts;
    $('contact-search').value = '';
    drawContacts();
    contactEditor.close();
    $('contact-search').focus();
  } catch (error) {
    form.querySelector('[role="status"]').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

function selectPersona(id) {
  selectedProxy = proxies.find(proxy => proxy.id === id) ?? null;
  try { localStorage.setItem('horizon-persona-' + account.id, String(selectedProxy?.id ?? 0)); } catch {}
  updateAccountFooter();
  updateSpeaker();publishPersona();drawServers();
}

async function switchPersona(id) {
  selectPersona(id);
  if (activeServerId) {
    editor.focus();
    return;
  }
  const current = activeConversation();
  const identity = selectedProxy?.id ?? 0;
  const matching = current && conversations.find(thread => thread.inboxProxyId === identity &&
    thread.peerId === current.peerId && thread.proxyId === current.proxyId);
  await openThread(matching?.id ?? null, identity);
}

const characterBinder = $('character-binder');
const binderSearch = $('character-binder-search');
let binderTrigger = null;
let binderSelecting = false;
let binderSelected = false;
const binderName = value => value.normalize('NFKC').toLocaleLowerCase();

function drawCharacterBinder() {
  if (!account) return;
  const query = binderName(binderSearch.value.trim());
  const identities = [{ id: 0, name: account.displayName, avatarUrl: account.avatarUrl,
    bannerUrl: account.bannerUrl, description: account.bio, publicTag: account.publicTag,
    status: account.status, joinedAt: account.joinedAt, group: 'Main account' }, ...proxies];
  const matches = identities.filter(person => binderName(person.name).includes(query));
  $('character-binder-count').textContent = matches.length + (matches.length === 1 ? ' persona' : ' personas');
  $('character-binder-empty').hidden = matches.length > 0;
  const focused = document.activeElement?.dataset.binderPersona;
  $('character-binder-cards').replaceChildren(...matches.map(person => {
    const card = document.createElement('article');
    card.setAttribute('role','button');card.tabIndex=0;card.className = 'binder-card'; card.dataset.binderPersona = person.id;
    card.setAttribute('aria-label', 'Become ' + person.name);
    const selected = person.id === (selectedProxy?.id ?? 0);
    card.setAttribute('aria-pressed', String(selected));
    card.disabled = binderSelecting;
    const sleeve = document.createElement('div'); sleeve.className = 'binder-sleeve';
    renderPreview(sleeve, { displayName: person.name, avatarUrl: person.avatarUrl, bannerUrl: person.bannerUrl,
      designation: person.id ? person.designation : undefined, bio: person.description,
      publicTag: person.publicTag, status: person.status, joinedAt: person.joinedAt, character: Boolean(person.id), fullBodyUrl: person.fullBodyUrl });
    const footer = document.createElement('div'); footer.className = 'binder-card-footer';
    const group = document.createElement('span'); group.textContent = person.group || 'Character';
    const action = document.createElement('span'); action.textContent = selected ? 'Active persona' : 'Select persona';
    footer.append(group, action); card.append(sleeve, footer);
    card.onclick = event => {if(!event.target.closest('.body-toggle'))void chooseBinderPersona(person.id);};
    card.onkeydown=event=>{if(event.target===card&&['Enter',' '].includes(event.key)){event.preventDefault();void chooseBinderPersona(person.id);}};
    return card;
  }));
  if (focused !== undefined) $('character-binder-cards').querySelector('[data-binder-persona="' + focused + '"]')?.focus({ preventScroll: true });
}

async function chooseBinderPersona(id) {
  if (binderSelecting || !account) return;
  binderSelecting = true;
  $('character-binder-status').textContent = '';
  characterBinder.querySelectorAll('.binder-card').forEach(card => { card.disabled = true; });
  try {
    await switchPersona(id);
    binderSelected = true; characterBinder.close();
  } catch (error) { $('character-binder-status').textContent = error.message; }
  finally { binderSelecting = false; if (characterBinder.open) drawCharacterBinder(); }
}

function openCharacterBinder() {
  if (!account || binderSelecting) return;
  if (characterBinder.open) { characterBinder.close(); return; }
  binderTrigger = document.activeElement;
  binderSelected = false; binderSearch.value = '';
  $('character-binder-status').textContent = '';
  drawCharacterBinder(); characterBinder.showModal();
  characterBinder.querySelector('.binder-pages').scrollTop = 0;
  binderSearch.focus();
  const viewer = account;
  void refreshList().catch(error => { if (characterBinder.open && account === viewer) $('character-binder-status').textContent = error.message; });
}

binderSearch.oninput = () => {
  drawCharacterBinder(); characterBinder.querySelector('.binder-pages').scrollTop = 0;
};
characterBinder.addEventListener('close', () => {
  if (binderSelected && !composer.hidden) editor.focus();
  else if (binderTrigger?.isConnected) binderTrigger.focus({ preventScroll: true });
});
characterBinder.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); characterBinder.close(); return; }
  if (event.key === 'ArrowDown' && document.activeElement === binderSearch) {
    event.preventDefault(); characterBinder.querySelector('.binder-card:not(:disabled)')?.focus();
  } else if (event.key === 'Enter' && document.activeElement === binderSearch) {
    event.preventDefault(); characterBinder.querySelector('.binder-card:not(:disabled)')?.click();
  }
});
document.addEventListener('keydown', event => {
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat &&
      (event.code === 'KeyC' || event.key.toLowerCase() === 'c') && account) {
    event.preventDefault(); openCharacterBinder();
  }
}, true);

let personaRailSignature = '';
function drawPersonaRail() {
  const rail = $('persona-rail');
  const visible = Boolean(account && proxies.length);
  rail.hidden = !visible;
  app.toggleAttribute('data-personas', visible);
  if (!visible) { personaRailSignature = ''; $('persona-list').replaceChildren(); $('account-persona').replaceChildren(); return; }
  const signature = JSON.stringify([account.id, account.displayName, account.avatarUrl, proxies,
    conversations.filter(item => item.unread).map(item => item.inboxProxyId || 0)]);
  if (signature === personaRailSignature) {
    for (const button of rail.querySelectorAll('[data-persona]')) {
      const selected = Number(button.dataset.persona) === (selectedProxy?.id ?? 0);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    return;
  }
  personaRailSignature = signature;
  const focused = document.activeElement?.dataset.persona;
  const main = $('account-persona');
  if(!main.querySelector('.avatar') || main.dataset.avatarSource!==(account.avatarUrl||'')){main.replaceChildren(characterAvatar(account.avatarUrl));main.dataset.avatarSource=account.avatarUrl||'';}
  main.dataset.persona = '0';
  main.title = account.displayName + ' · Return to your account';
  main.setAttribute('aria-label', 'Return to ' + account.displayName);
  main.setAttribute('aria-pressed', String(!selectedProxy));
  main.classList.toggle('selected', !selectedProxy);
  main.onclick = () => void switchPersona(0).catch(showError);
  if (conversations.some(item => !item.inboxProxyId && item.unread)) {if(!main.querySelector('.unread-badge'))main.append(unreadBadge(true));} else main.querySelector('.unread-badge')?.remove();
  const oldButtons=new Map([...$('persona-list').children].map(button=>[Number(button.dataset.persona),button]));
  const buttons=proxies.map(proxy => {
    const unread=conversations.some(item=>item.inboxProxyId===proxy.id&&item.unread);
    const key=JSON.stringify([proxy.name,proxy.avatarUrl,unread]);
    const previous=oldButtons.get(proxy.id);
    if(previous?.dataset.personaSignature===key){const selected=selectedProxy?.id===proxy.id;previous.setAttribute('aria-pressed',String(selected));previous.classList.toggle('selected',selected);return previous;}
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'rail-control persona-button';
    button.dataset.persona = proxy.id;button.dataset.personaSignature=key;
    button.title = proxy.name; button.setAttribute('aria-label', proxy.name);
    const selected = selectedProxy?.id === proxy.id;
    button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('selected', selected);
    button.append(characterAvatar(proxy.avatarUrl));
    if (conversations.some(item => item.inboxProxyId === proxy.id && item.unread)) {
      button.append(unreadBadge(true)); button.title += ' · Unread messages';
    }
    button.onclick = () => void switchPersona(proxy.id).catch(showError);
    return button;
  });
  const keep=new Set(buttons);for(const button of [...$('persona-list').children])if(!keep.has(button))button.remove();
  let cursor=$('persona-list').firstElementChild;for(const button of buttons){if(button===cursor)cursor=cursor.nextElementSibling;else $('persona-list').insertBefore(button,cursor);}
  if (focused !== undefined) rail.querySelector('[data-persona="' + focused + '"]')?.focus({ preventScroll: true });
}

$('persona-rail').addEventListener('keydown', event => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...$('persona-rail').querySelectorAll('button')];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
  event.preventDefault(); buttons[next]?.focus();
});

function primeNotificationAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return null;
  if (!pingAudio || pingAudio.state === 'closed') pingAudio = new Audio();
  if (pingAudio.state === 'suspended') void pingAudio.resume().catch(() => {});
  return pingAudio;
}
// Browsers require a gesture after loading. Keep retrying after suspension too.
for (const type of ['pointerdown','keydown']) document.addEventListener(type, primeNotificationAudio, { capture: true, passive: true });

const horizonSignal = {
  version: 1, name: 'Horizon Signal', masterVolume: .35, attackShape: 'exponential', lead: .012, tail: .01,
  notes: [
    { waveform: 'sine', startHz: 520, endHz: 520, start: 0, duration: .09, gain: .23, attack: .012 },
    { waveform: 'sine', startHz: 780, endHz: 780, start: .105, duration: .09, gain: .23, attack: .012 },
    { waveform: 'sine', startHz: 650, endHz: 480, start: .215, duration: .2, gain: .23, attack: .012 },
  ],
};
const announcementSignal = {
  name: 'Administrative Authority — Faster', masterVolume: .35, attackShape: 'linear', lead: .02, tail: .02,
  notes: [
    { waveform: 'triangle', startHz: 110, endHz: 100, start: 0, duration: .3344, attack: .022, gain: .14 },
    { waveform: 'sine', startHz: 220, endHz: 220, start: .0176, duration: .264, attack: .022, gain: .15 },
    { waveform: 'sine', startHz: 390, endHz: 390, start: .3168, duration: .1584, attack: .022, gain: .23 },
    { waveform: 'sine', startHz: 585, endHz: 585, start: .5016, duration: .1672, attack: .022, gain: .24 },
    { waveform: 'sine', startHz: 488, endHz: 330, start: .7128, duration: .352, attack: .022, gain: .27 },
    { waveform: 'triangle', startHz: 110, endHz: 82, start: .7216, duration: .484, attack: .022, gain: .13 },
    { waveform: 'sine', startHz: 165, endHz: 110, start: .7744, duration: .4312, attack: .022, gain: .08 },
  ],
};
async function playDmPing(signal = horizonSignal) {
  primeNotificationAudio();
  if (!pingAudio) return;
  if (pingAudio.state !== 'running') {
    try {
      const resumed = await Promise.race([pingAudio.resume().then(() => true), new Promise(resolve => setTimeout(() => resolve(false),350))]);
      if (!resumed || pingAudio.state !== 'running') return;
    } catch { return; }
  }
  const now = pingAudio.currentTime + signal.lead;
  for (const note of signal.notes) {
    const tone = pingAudio.createOscillator(), volume = pingAudio.createGain();
    const start = now + note.start, end = start + note.duration;
    tone.type = note.waveform;
    tone.frequency.setValueAtTime(note.startHz,start);
    tone.frequency.exponentialRampToValueAtTime(note.endHz,end);
    volume.gain.setValueAtTime(.0001,start);
    if (signal.attackShape === 'exponential') volume.gain.exponentialRampToValueAtTime(signal.masterVolume * note.gain,start + note.attack);
    else volume.gain.linearRampToValueAtTime(signal.masterVolume * note.gain,start + note.attack);
    volume.gain.exponentialRampToValueAtTime(.0001,end);
    tone.connect(volume); volume.connect(pingAudio.destination);
    tone.start(start); tone.stop(end + signal.tail);
    tone.onended = () => { tone.disconnect(); volume.disconnect(); };
  }
}

function replyText(body, attachment) {
  return body?.trim().replace(/\s+/g, ' ').slice(0, 180) || attachment || 'Attachment';
}

function replySource(message) {
  let attachment;
  try { attachment = JSON.parse(message.format)?.name; } catch { /* Older plain messages have no metadata. */ }
  return { id: message.id, author: message.displayName, avatarUrl: message.avatarUrl,
    text: replyText(message.body, attachment) };
}

function replyContents(source) {
  const avatar = characterAvatar(source.avatarUrl);
  const author = document.createElement('strong');
  const snippet = document.createElement('span');
  author.textContent = source.author;
  snippet.className = 'reply-snippet';
  snippet.append(emojiText(source.text));
  return [avatar, author, snippet];
}

function updateReplyDraft() {
  const source = active && replyDrafts.get(draftKey(active));
  const panel = $('reply-draft');
  panel.hidden = !source || composer.hidden || Boolean(messageEdit);
  if (panel.hidden) {
    $('reply-draft-preview').replaceChildren();
    return;
  }
  $('reply-draft-preview').replaceChildren(...(source.unavailable
    ? ['Original message unavailable'] : ['Replying to ', ...replyContents(source)]));
}

function cancelReply() {
  replyDrafts.delete(draftKey(active));
  updateReplyDraft();
  editor.focus();
}
$('cancel-reply').onclick = cancelReply;

async function jumpToReply(thread, target) {
  try {
    while (active === thread) {
      const row = $('direct-messages').querySelector('[data-message-id="' + target + '"]');
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.remove('reply-target');
        void row.offsetWidth;
        row.classList.add('reply-target');
        return;
      }
      const oldest = entries[0]?.id;
      if (!oldest || oldest <= target || $('older').hidden) break;
      await refreshMessages(true);
      if (entries[0]?.id === oldest) break;
    }
    if (active === thread) $('chat-status').textContent = 'Original message unavailable.';
  } catch (error) {
    if (active === thread) showError(error);
  }
}

function messageReplyPreview(message, thread) {
  if (!message.isReply) return null;
  if (!message.replyTargetId) {
    const missing = document.createElement('span');
    missing.className = 'reply-preview';
    missing.textContent = 'Original message unavailable';
    return missing;
  }
  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'reply-preview';
  preview.append(...replyContents({
    avatarUrl: message.replyAvatarUrl, author: message.replyAuthor,
    text: replyText(message.replyText, message.replyAttachment),
  }));
  preview.title = 'Jump to original message';
  preview.onclick = () => void jumpToReply(thread, message.replyTargetId);
  return preview;
}

function sizeMessageEmojis(body) {
  const count = body.querySelectorAll('.emoji-token, img.inline-emoji:not(.emoji-token img)').length;
  const text = body.cloneNode(true);
  text.querySelectorAll('.emoji-token, img.inline-emoji').forEach(node => node.remove());
  body.classList.toggle('emoji-only', count > 0 && count <= 3 && !text.textContent.trim() &&
    !body.querySelector('.document-card, .media-attachment, pre, table'));
}

function updateCharacterCount() {
  const counter = $('character-count');
  const count = editor.message().body.length;
  counter.hidden = composer.hidden || count <= 3000;
  counter.textContent = count.toLocaleString() + ' / 4,000' + (count > 4000 ? ' · Sends as a file' : '');
  counter.classList.toggle('over-file-threshold', count > 4000);
}
composer.addEventListener('input', updateCharacterCount);
new MutationObserver(updateCharacterCount).observe($('draft'), { childList: true, subtree: true, characterData: true });
$('code-language').addEventListener('change', updateCharacterCount);

const profileMessageFields=new Set(['displayName','avatarUrl','bannerUrl','fullBodyUrl','bio','designation','publicTag','status','joinedAt','variantId','variantName','replyAuthor','replyAvatarUrl','replyText','replyAttachment','replyTargetId','isReply']);
function messageStructure(message){return JSON.stringify(Object.fromEntries(Object.entries(message).filter(([key])=>!profileMessageFields.has(key))));}
function drawMessages() {
  const conversationId = active;
  $('empty').hidden = entries.length > 0;
  const server = activeServer();
  const channel = activeChannel();
  $('empty').hidden ||= channel?.kind === 'voice';
  $('empty').textContent = channel?.kind === 'forum' ? (forum.postId ? 'No replies yet.' : 'No forum posts yet.') : server ? 'Welcome to ' + server.name : active ? 'No messages yet.' : 'Use ＋ to open a conversation by handle.';
  if (messageActions.matches(':popover-open')) messageActions.hidePopover();
  const list = $('direct-messages');
  const editingRow = messageEdit?.row;
  const replyable = !composer.hidden;
  const existing = new Map([...list.children].map(row => [Number(row.dataset.messageId), row]));
  const rows = entries.map((message,index) => {
    if (editingRow && message.id === messageEdit.id) return editingRow;
    const previous = existing.get(message.id);
    let dice;
    try { const format = JSON.parse(message.format); if (format?.kind === 'dice') dice = format; } catch {}
    const editable = !dice && !message.inviteMessageId && message.senderId === account?.id && channel?.canSend !== false;
    const deletable = message.senderId === account?.id || channel?.canManageMessages || account?.id === broadcastOwnerId;
    const authorStyle = authorRole(server, message.senderId);
    const appearance = JSON.stringify([editable, Boolean(deletable), replyable, authorStyle?.color, server?.legacyEmojis]);
    const cached=previous&&renderedMessages.get(previous);
    if(previous&&previous.dataset.appearance===appearance){
      if(cached===message)return previous;
      if(cached&&messageStructure(cached)===messageStructure(message)){
        const avatarChanged=cached.avatarUrl!==message.avatarUrl;
        const replyChanged=JSON.stringify([cached.isReply,cached.replyTargetId,cached.replyAuthor,cached.replyAvatarUrl,cached.replyText,cached.replyAttachment])!==JSON.stringify([message.isReply,message.replyTargetId,message.replyAuthor,message.replyAvatarUrl,message.replyText,message.replyAttachment]);
        Object.assign(cached,message);entries[index]=cached;
        const picture=previous.querySelector(':scope > .profile-avatar');
        if(avatarChanged)picture?.querySelector('.avatar')?.replaceWith(characterAvatar(message.avatarUrl));
        picture?.setAttribute('aria-label','View profile for '+message.displayName);
        const author=previous.querySelector('.message-author');
        if(author){if(author.textContent!==message.displayName)author.textContent=message.displayName;author.setAttribute('aria-label','View profile for '+message.displayName);}
        const result=previous.querySelector('.dice-result');if(result&&dice)result.textContent=message.displayName+' rolled '+(dice.expression||'1d'+dice.sides);
        if(replyChanged){const content=previous.querySelector(':scope > div');content.querySelector(':scope > .reply-preview')?.remove();const preview=messageReplyPreview(message,conversationId);if(preview)content.prepend(preview);}
        return previous;
      }
    }
    const row = document.createElement('li');
    renderedMessages.set(row, message);
    const avatar = characterAvatar(message.avatarUrl);
    const content = document.createElement('div');
    const name = profileButton(message, 'message-author');
    const picture = profileButton(message, 'profile-avatar');
    const time = document.createElement('time');
    const body = editor.render(message, file => documents.render(file, conversationId, message.id), server?.legacyEmojis);
    row.className = dice ? 'message dice-message' : 'message';
    row.dataset.messageId = message.id;
    row.dataset.appearance = appearance;
    name.textContent = message.displayName;
    paintRole(name, authorStyle?.color);
    time.dateTime = new Date(message.sent).toISOString();
    time.textContent = clock.format(message.sent);
    sizeMessageEmojis(body);
    const preview = messageReplyPreview(message, conversationId);
    if (preview) content.append(preview);
    if (dice) {
      const label = document.createElement('strong');
      label.textContent = 'Horizon';
      const result = document.createElement('span');
      result.className = 'dice-result';
      const expression = dice.expression || '1d' + dice.sides;
      const rolls = dice.dice || [{ sides: dice.sides, result: dice.result }];
      result.textContent = message.displayName + ' rolled ' + expression;
      const faces = document.createElement('div');
      faces.className = 'dice-faces';
      const makeDie = (sides, value) => {
        const face = document.createElement('span');
        face.className = 'die-art die-art-d' + sides;
        const art = document.createElement('img');
        art.dataset.dieAsset = sides;
        art.src = diceArtwork(sides);
        art.alt = '';
        art.draggable = false;
        const number = document.createElement('span');
        number.className = 'die-number';
        number.textContent = value;
        face.append(art, number);
        return face;
      };
      for (const die of rolls) {
        const face = document.createElement('span');
        face.className = 'die-face die-d' + die.sides;
        face.title = 'D' + die.sides + ': ' + die.result;
        face.setAttribute('aria-label', face.title);
        if (die.sides === 100) {
          const tens = die.result === 100 ? '00' : String(Math.floor(die.result / 10) * 10).padStart(2, '0');
          const units = String(die.result % 10);
          face.append(makeDie(10, tens), makeDie(10, units));
        } else {
          face.append(makeDie(die.sides, String(die.result)));
        }
        faces.append(face);
      }
      const total = document.createElement('strong');
      total.className = 'dice-total';
      total.textContent = 'Total ' + (dice.total ?? dice.result);
      content.append(label, time, result, faces, total);
    } else content.append(name, time, body);
    if (message.inviteMessageId) {
      body.replaceChildren();
      const card = document.createElement('div');
      card.className = 'server-invite-card';
      const title = document.createElement('strong');
      title.textContent = message.inviteServerName;
      const state = document.createElement('span');
      state.textContent = message.inviteStatus === 'pending' ? 'Server invitation' : 'Invitation ' + message.inviteStatus;
      card.append(title, state);
      if (message.inviteStatus === 'pending' && message.inviteRecipientId === account.id) {
        const actions = document.createElement('div');
        for (const [label, accept] of [['Accept', true], ['Deny', false]]) {
          const button = control(label + ' invite to ' + message.inviteServerName, label, async () => {
            actions.querySelectorAll('button').forEach(action => { action.disabled = true; });
            try {
              await call('server-invites/' + message.inviteId, { accept });
              await refreshList();
              await refreshMessages(false, true);
            } catch (error) { showError(error); actions.querySelectorAll('button').forEach(action => { action.disabled = false; }); }
          });
          actions.append(button);
        }
        card.append(actions);
      }
      body.append(card);
    }
    picture.append(avatar);
    row.append(picture, content);
    if (replyable || deletable) {
      const actions = document.createElement('button');
      actions.type = 'button';
      actions.className = 'message-actions-button';
      actions.textContent = '⋯';
      actions.setAttribute('aria-label', 'Message actions');
      actions.setAttribute('aria-controls', 'message-actions');
      actions.onclick = () => {
        const bounds = actions.getBoundingClientRect();
        openMessageActions(conversationId, message, bounds.left, bounds.bottom, actions, { replyable, editable, deletable });
      };
      row.oncontextmenu = event => {
        event.preventDefault();
        openMessageActions(conversationId, message, event.clientX, event.clientY, actions, { replyable, editable, deletable });
      };
      row.append(actions);
    }
    return row;
  });
  const retained = new Set(rows);
  if (editingRow && !retained.has(editingRow)) closeMessageEditor();
  for (const row of [...list.children]) {
    if (!retained.has(row)) row.remove();
  }
  let cursor = list.firstElementChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
}

function openMessageActions(thread, message, x, y, trigger, { replyable, editable, deletable, edit }) {
  const { id } = message;
  replyAction.hidden = !replyable;
  editAction.hidden = !editable;
  deleteAction.hidden = !deletable;
  replyAction.onclick = () => {
    messageActions.hidePopover();
    if (active !== thread || composer.hidden) return;
    closeMessageEditor();
    replyDrafts.set(draftKey(thread), replySource(message));
    updateReplyDraft();
    editor.focus();
  };
  messageActions.showPopover();
  messageActions.style.left = Math.max(0, Math.min(x, innerWidth - messageActions.offsetWidth - 4)) + 'px';
  messageActions.style.top = Math.max(0, Math.min(y, innerHeight - messageActions.offsetHeight - 4)) + 'px';
  editAction.onclick = () => {
    messageActions.hidePopover();
    if (edit) void edit(); else void openMessageEditor(thread, id, trigger);
  };
  deleteAction.onclick = async () => {
    messageActions.hidePopover();
    try {
      await call('conversations/' + thread + '/messages/' + id + '/delete', {});
      removeMessage(thread, id);
    } catch (error) {
      if (thread === active) showError(error);
    }
  };
  messageActions.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      messageActions.hidePopover();
      if (trigger.isConnected) trigger.focus();
    }
  };
  [replyAction, editAction, deleteAction].find(action => !action.hidden)?.focus();
}

async function openMessageEditor(thread, id, trigger) {
  if (sending || messageEdit || thread !== active) return;
  const edit = { thread, id, route: 'conversations/' + thread + '/messages/' + id, trigger };
  messageEdit = edit;
  updateReplyDraft();
  try {
    const { message } = await call(edit.route + '/edit');
    if (messageEdit !== edit) return;
    const row = $('direct-messages').querySelector('[data-message-id="' + id + '"]');
    if (!row) {
      closeMessageEditor();
      return;
    }
    edit.row = row;
    edit.draft = editor.snapshot();
    edit.body = row.querySelector('time').nextElementSibling;
    edit.actions = row.querySelector('.message-actions-button');
    edit.body.hidden = edit.actions.hidden = true;
    closeDice();
    composer.setAttribute('data-editing', '');
    edit.body.after(composer);
    $('draft').classList.add('msgbody', 'rich-body');
    editControls.prepend($('attach-file'));
    editor.restoreMessage(message, apiUrl(edit.route + '/thumbnail'));
    editControls.hidden = false;
    editStatus.textContent = '';
    editor.focus();
  } catch (error) {
    if (messageEdit === edit) {
      closeMessageEditor();
      showError(error);
    }
  }
}

function closeMessageEditor() {
  const edit = messageEdit;
  if (!edit) return;
  messageEdit = null;
  if (edit.row) {
    composerHome.insertBefore(composer, composerSibling);
    composer.removeAttribute('data-editing');
    $('draft').classList.remove('msgbody', 'rich-body');
    composer.insertBefore($('attach-file'), $('draft'));
    edit.body.hidden = edit.actions.hidden = false;
    editor.restore(edit.draft);
  }
  editControls.hidden = true;
  updateReplyDraft();
  saveEdit.disabled = cancelEdit.disabled = false;
  if (edit.trigger.isConnected) edit.trigger.focus();
}

cancelEdit.onclick = closeMessageEditor;
composer.addEventListener('keydown', event => {
  if (event.key === 'Escape' && messageEdit && !messageEdit.saving) {
    event.preventDefault();
    closeMessageEditor();
  } else if (event.key === 'Escape' && !messageEdit && replyDrafts.has(draftKey(active))) {
    event.preventDefault();
    cancelReply();
  }
});

async function saveMessageEdit() {
  const edit = messageEdit;
  if (saveEdit.disabled || !edit?.row) return;
  const { file, attachmentAlign } = editor.snapshot();
  const message = { ...editor.message(), attachmentAlign };
  if (!file && !message.body.trim()) {
    editStatus.textContent = 'Enter a message or add an attachment.';
    return;
  }
  edit.saving = saveEdit.disabled = cancelEdit.disabled = true;
  editStatus.textContent = 'Saving…';
  try {
    const route = edit.route + '/edit';
    const result = file instanceof File ? await sendAttachment(route, message, file)
      : await call(route, { ...message, keepAttachment: Boolean(file) });
    if (messageEdit !== edit) return;
    closeMessageEditor();
    await refreshReproxy(edit.thread, result.updatedId);
  } catch (error) {
    if (messageEdit === edit) {
      editStatus.textContent = error.message;
      edit.saving = saveEdit.disabled = cancelEdit.disabled = false;
    }
  }
}

function removeMessage(thread, id) {
  for (const [key, source] of replyDrafts) {
    if (source.id === id) replyDrafts.set(key, { id, unavailable: true });
  }
  if (thread !== active) return;
  updateReplyDraft();
  entries = entries.filter(entry => entry.id !== id).map(entry => entry.replyTargetId === id
    ? { ...entry, replyTargetId: null, replyAuthor: null, replyAvatarUrl: null, replyText: null, replyAttachment: null }
    : entry);
  drawMessages();
  void refreshMessages(false, true).catch(error => {
    if (thread === active) showError(error);
  });
}

async function refreshReproxy(thread, id) {
  if (activeChannel()?.kind === 'forum') return refreshMessages(false, true);
  if (entries.some(entry => entry.replyTargetId === id)) return refreshMessages(false, true);
  if (!entries.some(entry => entry.id === id)) return;
  const viewer = account;
  const { message } = await call('conversations/' + thread + '/messages?at=' + id);
  if (viewer !== account || thread !== active) return;
  let changed = false;
  entries = entries.map(entry => {
    if (entry.id !== id || JSON.stringify(entry) === JSON.stringify(message)) return entry;
    changed = true; return message;
  });
  if (changed) drawMessages();
}

async function refreshMessages(older = false, reconnect = false) {
  if(activeChannel()?.locked)return;
  const thread = active;
  const forumPostId = activeChannel()?.kind === 'forum' ? forum.postId : null;
  if (activeChannel()?.kind === 'forum') {
    void forum.refresh();
    if (!forumPostId) return;
  }
  if (!thread || (older && !entries.length)) return;
  const request = ++messageRequest;
  const route = 'conversations/' + thread + '/messages';
  const prior = entries.at(-1)?.id;
  const suffix = older ? '?before=' + entries[0].id
    : reconnect && entries.length ? '?after=' + (entries[0].id - 1)
      : prior ? '?after=' + prior : '';
  const postQuery = forumPostId ? (suffix ? '&' : '?') + 'postId=' + forumPostId : '';
  const page = await call(route + suffix + postQuery);
  if (thread !== active || request !== messageRequest || forumPostId !== (activeChannel()?.kind === 'forum' ? forum.postId : null)) return;
  const received = [...page.messages];
  let more = page.hasNewer;
  while (more) {
    const next = await call(route + '?after=' + received.at(-1).id + (forumPostId ? '&postId=' + forumPostId : ''));
    if (thread !== active || request !== messageRequest || forumPostId !== (activeChannel()?.kind === 'forum' ? forum.postId : null)) return;
    received.push(...next.messages);
    more = next.hasNewer;
  }
  const height = history.scrollHeight;
  const atBottom = height - history.scrollTop - history.clientHeight < 42;
  const previous = new Map(entries.map(entry => [entry.id, entry]));
  const known = new Map(reconnect ? [] : previous);
  for (const item of received) {
    const old = previous.get(item.id);
    // Reconnects return fresh objects for unchanged rows. Keep the original row
    // identity so its iframe/media element and playback state remain mounted.
    known.set(item.id, old && JSON.stringify(old) === JSON.stringify(item) ? old : item);
  }
  const nextEntries = [...known.values()].sort((a, b) => a.id - b.id);
  const changed = nextEntries.length !== entries.length || nextEntries.some((entry,index) => entry !== entries[index]);
  entries = nextEntries;
  if (changed) drawMessages();
  if (older || !prior) $('older').hidden = !page.hasOlder;
  if (older) history.scrollTop += history.scrollHeight - height;
  else if (atBottom) history.scrollTop = history.scrollHeight;
  await markThreadRead();
}

async function markThreadRead() {
  const thread = activeConversation();
  const through = entries.at(-1)?.id;
  if (thread?.unread && through && !document.hidden && document.hasFocus()) {
    await call('conversations/' + thread.id + '/read', { inboxProxyId, through });
  }
}


$('auth-mode').onclick = () => setMode(!creating);
auth.onsubmit = async event => {
  event.preventDefault();
  const submit = auth.querySelector('[type="submit"]');
  submit.disabled = true;
  $('auth-status').textContent = '';
  try {
    const result = await call(creating ? 'register' : 'login', Object.fromEntries(new FormData(auth)));
    auth.reset();
    setAccount(result.account);
    if (result.recoveryCode) showRecoveryCode(result.recoveryCode);
  } catch (error) {
    $('auth-status').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

const recoverDialog = $('recover-account');
const recoverForm = $('recover-form');
const recoveryCodeDialog = $('recovery-code-dialog');
const recoveryCodeValue = $('recovery-code-value');

function showRecoveryCode(code) {
  recoveryCodeValue.value = code;
  $('recovery-code-status').textContent = '';
  recoveryCodeDialog.showModal();
  recoveryCodeValue.select();
}
recoveryCodeDialog.addEventListener('close', () => { recoveryCodeValue.value = ''; });
$('copy-recovery-code').onclick = async () => {
  const status = $('recovery-code-status');
  try {
    await navigator.clipboard.writeText(recoveryCodeValue.value);
    status.textContent = 'Copied.';
  } catch {
    recoveryCodeValue.select();
    status.textContent = 'Select and copy the code.';
  }
};
$('open-recovery').onclick = () => {
  recoverForm.reset();
  recoverForm.elements.username.value = auth.elements.username.value;
  $('recover-status').textContent = '';
  recoverDialog.showModal();
};
recoverDialog.addEventListener('close', () => recoverForm.reset());
recoverForm.onsubmit = async event => {
  event.preventDefault();
  const { username, code, newPassword, confirmPassword } = Object.fromEntries(new FormData(recoverForm));
  const status = $('recover-status');
  if (newPassword !== confirmPassword) {
    status.textContent = 'The new passwords do not match.';
    return;
  }
  const submit = recoverForm.querySelector('[type="submit"]');
  submit.disabled = true;
  status.textContent = '';
  try {
    const result = await call('recover', { username, code, newPassword });
    recoverDialog.close();
    auth.reset();
    setAccount(result.account);
    showRecoveryCode(result.recoveryCode);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

const generateRecovery = $('generate-recovery');
const generateRecoveryStatus = $('generate-recovery-status');
generateRecovery.onsubmit = async event => {
  event.preventDefault();
  const submit = generateRecovery.querySelector('[type="submit"]');
  generateRecoveryStatus.textContent = '';
  submit.disabled = true;
  try {
    const { recoveryCode } = await call('recovery-code', { password: generateRecovery.elements.password.value });
    generateRecovery.reset();
    showRecoveryCode(recoveryCode);
  } catch (error) {
    generateRecoveryStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
preferences.addEventListener('close', () => {
  generateRecovery.reset();
  generateRecoveryStatus.textContent = '';
});

window.addEventListener('focus', () => { void markThreadRead().catch(showError); });

async function startConversation(target, identity = inboxProxyId) {
  const viewer = account;
  const { id } = await call('conversations', { ...target, inboxProxyId: identity });
  await refreshList();
  if (viewer !== account) return;
  await openThread(id, identity);
  editor.focus();
}

$('new-message').onclick = () => {
  nameDialog.querySelector('form').reset();
  nameDialog.querySelector('[role="status"]').textContent = '';
  nameDialog.showModal();
};
nameDialog.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await startConversation(Object.fromEntries(new FormData(form)));
    nameDialog.close();
    editor.focus();
  } catch (error) {
    nameDialog.querySelector('[role="status"]').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

function profileButton(person, className, showPresence = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  if (showPresence || className === 'server-person') button.dataset.presenceId = person.senderId ?? person.peerId ?? person.id;
  button.setAttribute('aria-label', 'View profile for ' + person.displayName);
  button.onclick = () => openProfile(person, button);
  button.oncontextmenu = event => {
    if (!button.closest('.conversation-row')) openPersonActions(person, event, button);
  };
  return button;
}

function publicHandle(person) {
  return person.publicTag ? person.displayName + '#' + person.publicTag : '';
}

function showPublicHandle(element, person) {
  const tag = document.createElement('span');
  tag.className = 'profile-number';
  tag.textContent = person.publicTag ? '#' + person.publicTag : '';
  element.replaceChildren(person.publicTag ? person.displayName : '', tag);
  element.hidden = !person.publicTag;
}

let miniProfileAnchor=null,miniProfileBounds=null,miniProfilePerson=null,miniPositionFrame=0;
function currentMainProfile(person){
  if(!person.proxyId||(person.variantId??0)!==0)return person;
  const core=proxies.find(p=>p.id===person.proxyId);
  return core?{...person,displayName:core.baseName??core.name,avatarUrl:core.baseAvatarUrl,bannerUrl:core.baseBannerUrl,fullBodyUrl:core.baseFullBodyUrl,bio:core.baseDescription??core.description,status:core.baseStatus??core.status,designation:core.baseDesignation||core.designation,variantId:0,variantName:'Main'}:person;
}
let miniOpenSequence=0;
async function openProfile(person, anchor, {refresh=false}={}) {
  const sequence=++miniOpenSequence,viewer=account;
  person=currentMainProfile(person);
  const owner=person.senderId??person.peerId??person.id;
  const theme=await profileThemeFor(owner);
  if(sequence!==miniOpenSequence||viewer!==account||anchor&&!anchor.isConnected)return;
  paintMiniTheme(theme);
  const wasBody=refresh&&miniProfile.classList.contains('show-full-body');
  miniProfilePerson=person;miniProfileAnchor=anchor||miniProfileAnchor;
  if(miniProfileAnchor?.isConnected)miniProfileBounds=miniProfileAnchor.getBoundingClientRect();
  resetMiniBody(person);
  if(!refresh)miniProfile.hidePopover();
  miniProfile.oncontextmenu = event => openPersonActions(person, event, miniProfile);
  $('mini-name').textContent = person.displayName;
  appendDesignation($('mini-name'), person.designation);
  if($('mini-avatar').dataset.source!==(person.avatarUrl||'')||!$('mini-avatar').firstElementChild){$('mini-avatar').replaceChildren(characterAvatar(person.avatarUrl));$('mini-avatar').dataset.source=person.avatarUrl||'';}
  const banner = miniProfile.querySelector('.mini-banner');
  if(banner.dataset.source!==(person.bannerUrl||'')){banner.querySelector('img')?.remove();appendProfileImage(banner,person.bannerUrl,'banner');banner.dataset.source=person.bannerUrl||'';}
  showPublicHandle($('mini-handle'), person);
  $('mini-status').textContent = person.status || '';
  $('mini-status').hidden = !person.status;
  $('mini-bio').textContent = person.bio || '';
  $('mini-bio').hidden = !person.bio;
  $('mini-member').hidden = Boolean(person.proxyId) || !person.publicTag;
  $('mini-member').querySelector('dd').textContent = memberSince(person.joinedAt);
  $('mini-settings').hidden = person !== account;
  drawMiniVariants(person);
  const dm = $('mini-dm');
  const recipientId = person.senderId ?? person.peerId ?? person.id;
  dm.hidden = Boolean(person.broadcast) || recipientId === broadcastOwnerId;
  $('mini-dm-status').textContent = '';
  dm.onclick = async () => {
    dm.disabled = true;
    try {
      const destination = person.proxyId ? { recipientId, recipientProxyId: person.proxyId }
        : { recipientId, handle: publicHandle(person) };
      await startConversation(destination, selectedProxy?.id ?? 0);
      miniProfile.hidePopover();
      editor.focus();
    } catch (error) {
      $('mini-dm-status').textContent = error.message;
    } finally {
      dm.disabled = false;
    }
  };
  if(!miniProfile.matches(':popover-open'))miniProfile.showPopover({ source: miniProfileAnchor });
  if(wasBody){miniProfile.classList.add('show-full-body');$('mini-full-body').hidden=false;$('mini-body-toggle').className='body-toggle card-logo';$('mini-body-toggle').setAttribute('aria-label','Back to profile');}
  positionMiniProfile();

}

const settingsPages = [...preferences.querySelectorAll('[data-settings-page]')];
function showSettingsPage(page) {
  if (page !== 'characters' && preferences.open && !$('characters-menu').hidden && !allowProxyNavigation()) return;
  preferences.querySelector('.settings-main').dataset.page = page;
  for (const button of settingsPages) {
    const selected = button.dataset.settingsPage === page;
    button.setAttribute('aria-pressed', String(selected));
    $(button.getAttribute('aria-controls')).hidden = !selected;
  }
  preferences.querySelector('.settings-main').scrollTop = 0;
}
for (const button of settingsPages) button.onclick = () => showSettingsPage(button.dataset.settingsPage);

function setupAppearanceOptions(id, options, storageKey, apply, preview) {
  const group = $(id);
  let selected;
  try { selected = localStorage.getItem(storageKey); } catch {}
  const fallback = options[0][0];
  const current = options.some(([value]) => value === selected) ? selected : fallback;
  apply(current);
  for (const [value, name] of options) {
    const card = document.createElement('label');
    card.className = 'appearance-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = id;
    input.value = value;
    input.checked = current === value;
    input.onchange = () => {
      if (!input.checked) return;
      apply(value);
      try { localStorage.setItem(storageKey, value); } catch {}
    };
    const art = document.createElement('span');
    art.className = 'appearance-option-art';
    art.setAttribute('aria-hidden', 'true');
    art.append(...preview(value));
    const title = document.createElement('span');
    title.className = 'appearance-option-title';
    title.textContent = name;
    card.append(input, art, title);
    group.append(card);
  }
}


const mediaSettings={youtube:'youtubeView',links:'linkedMediaView',images:'imageView','image-loading':'imageLoading',av:'avLoading',documents:'documentLoading'};
for(const [key,dataset] of Object.entries(mediaSettings)){
 const picker=$('appearance-'+key);let value='expanded';
 try{value=localStorage.getItem('horizon-media-'+key) || localStorage.getItem('horizon-media-view') || 'expanded';}catch{}
 picker.value=value==='compact'?'compact':'expanded';document.documentElement.dataset[dataset]=picker.value;
 picker.onchange=()=>{document.documentElement.dataset[dataset]=picker.value;try{localStorage.setItem('horizon-media-'+key,picker.value);}catch{}
  const selector={youtube:'[data-preview-kind=youtube]',links:'[data-preview-kind=linked]',images:'[data-media-kind=image]','image-loading':'[data-media-kind=image]',av:'.media-attachment',documents:'.document-preview'}[key];
  for(const row of $('direct-messages').children)if(row.querySelector(selector))renderedMessages.delete(row);drawMessages();forum.refreshMedia(selector);
 };
}

const diceThemes = { original: null, horizon: 'Horizon', comic: 'Comic_Book', 'neo-noir': 'Neo_Noir', 'ye-olde': 'Ye_Olde' };
let diceTheme = 'original';
function diceArtwork(sides, style = diceTheme) {
  const directory = diceThemes[style];
  return directory ? 'dice/themes/' + directory + '/D' + sides + '.png' : 'dice/d' + sides + '.png';
}
setupAppearanceOptions('appearance-dice-options', [
  ['original', 'Original silver'], ['horizon', 'Horizon'], ['comic', 'Comic Book'],
  ['neo-noir', 'Neo-Noir'], ['ye-olde', 'Ye Olde'],
], 'horizon-dice-theme', value => {
  diceTheme = value;
  document.documentElement.dataset.diceTheme = value;
  for (const image of document.querySelectorAll('[data-die-asset]')) image.src = diceArtwork(image.dataset.dieAsset);
}, value => [6, 20].map(sides => {
  const image = document.createElement('img');
  image.src = diceArtwork(sides, value);
  image.alt = '';
  image.width = image.height = 48;
  return image;
}));

const themePicker = $('appearance-theme');
const defaultTheme = 'horizon';
const themes = {
  horizon: { category: 'horizon', label: 'Horizon', description: 'Gray-purple · Orange accents · Horizon’s signature theme' },
  'basic-light': { category: 'basic', label: 'Basic Light', description: 'White · Soft gray · Charcoal text' },
  'basic-mid': { category: 'basic', label: 'Basic Mid', description: 'Neutral slate-gray · Lighter panels · Near-white text' },
  'basic-dark': { category: 'basic', label: 'Basic Dark', description: 'Charcoal · Dark gray panels · Restrained contrast' },
  'burnt-titanium': { category: 'metals', label: 'Burnt Titanium', description: 'Heat-colored framing · Satin gunmetal' },
  'd2-steel': { category: 'metals', label: 'D2 Steel', description: 'Tool steel · Green-gray alloy · Satin finish' },
  lavender: { category: 'spice', label: 'Lavender', description: 'Dusty lavender · Lilac · Soft plum' },
  nutmeg: { category: 'spice', label: 'Nutmeg', description: 'Toasted taupe · Bronze · Warm brown' },
  clove: { category: 'spice', label: 'Clove', description: 'Deep espresso · Dark walnut · Warm tan' },
  vanilla: { category: 'spice', label: 'Vanilla', description: 'Ivory · Eggshell · Warm beige' },
  sage: { category: 'spice', label: 'Sage', description: 'Slate · Sage · Muted gold' },
  cinnamon: { category: 'spice', label: 'Cinnamon', description: 'Maroon · Graphite · Dark brown' },

};

async function syncAccountTheme(viewer){try{const result=await call('profile-theme');if(account!==viewer)return;if(result.theme)applyTheme(result.theme);else await call('profile-theme',{theme:preferredTheme});}catch{}}
function paintMiniTheme(theme){const chosen=Object.hasOwn(themes,theme)?theme:defaultTheme;miniProfile.classList.add('profile-themed');miniProfile.dataset.theme=chosen;miniProfile.dataset.themeCategory=themes[chosen].category;}
const profileThemes=new Map(),profileThemeRequests=new Map();
try{for(const [id,theme] of JSON.parse(localStorage.getItem('horizon-profile-themes')||'[]'))if(Number.isSafeInteger(id)&&Object.hasOwn(themes,theme))profileThemes.set(id,theme);}catch{}
function cacheProfileTheme(owner,value){const theme=Object.hasOwn(themes,value)?value:defaultTheme;if(!owner||profileThemes.get(owner)===theme)return;profileThemes.set(owner,theme);try{localStorage.setItem('horizon-profile-themes',JSON.stringify([...profileThemes]));}catch{}
 if(miniProfile.matches(':popover-open')&&(miniProfilePerson?.senderId??miniProfilePerson?.peerId??miniProfilePerson?.id)===owner){paintMiniTheme(theme);scheduleMiniPosition();}
}
async function profileThemeFor(owner){if(!owner)return defaultTheme;if(owner===account?.id){cacheProfileTheme(owner,preferredTheme);return preferredTheme;}if(profileThemes.has(owner))return profileThemes.get(owner);
 if(!profileThemeRequests.has(owner)){const request=call('profile-theme/'+owner).then(result=>{cacheProfileTheme(owner,result.theme);return profileThemes.get(owner);}).catch(()=>defaultTheme).finally(()=>profileThemeRequests.delete(owner));profileThemeRequests.set(owner,request);}return profileThemeRequests.get(owner);
}
async function refreshProfileThemes(){const viewer=account;try{const result=await call('profile-themes');if(viewer!==account)return;for(const person of result.themes)cacheProfileTheme(person.id,person.theme);}catch{}}

let preferredTheme = defaultTheme;
let ignoreServerThemePreference = false;
function applyTheme(value, persist = true) {
  const selected = Object.hasOwn(themes, value) ? value : defaultTheme;
  if (persist) {const changed=preferredTheme!==selected;preferredTheme = selected;if(account)cacheProfileTheme(account.id,selected);if(account&&changed)void call('profile-theme',{theme:selected}).catch(showError);}
  themePicker.value = preferredTheme;
  const serverTheme = activeServer()?.theme;
  const effective = !ignoreServerThemePreference && Object.hasOwn(themes, serverTheme) ? serverTheme : preferredTheme;
  const root = document.documentElement;
  root.dataset.theme = effective;
  root.dataset.themeCategory = themes[effective].category;
  const note = $('server-theme-note');
  note.hidden = effective === preferredTheme || ignoreServerThemePreference || !activeServer();
  note.textContent = 'This server uses ' + themes[effective].label + '. Enable Ignore server themes to use your personal theme here.';
  root.setAttribute('data-css-theme', '');
  root.style.removeProperty('--theme-background');
  root.style.removeProperty('--theme-avatar');
  $('dice-button-art').removeAttribute('src');
  for (const image of document.querySelectorAll('[data-theme-image]')) image.removeAttribute('src');
  if (persist) try { localStorage.setItem('horizon-theme', preferredTheme); } catch {}
  for (const button of $('theme-groups').querySelectorAll('.theme-card')) {
    const checked = button.dataset.theme === preferredTheme;
    button.setAttribute('aria-checked', String(checked));
    const groupHasSelection = [...button.parentElement.children].some(card => card.dataset.theme === preferredTheme);
    button.tabIndex = checked || (!groupHasSelection && button === button.parentElement.firstElementChild) ? 0 : -1;
  }
}
const themeIcons = {
  horizon: [Sun, '#d49a67'], 'basic-light': [Sun, '#777d85'], 'basic-mid': [Sun, '#d7dce0'], 'basic-dark': [Moon, '#b7bdc2'],
  vanilla: [Sun, '#C6AD8D'], sage: [Leaf, '#A9A07B'], cinnamon: [Moon, '#B67B7C'],
  lavender: [Flower2, '#9B87AD'], nutmeg: [Sprout, '#C7A17A'], clove: [Moon, '#B78B6C'],
  'd2-steel': [Anvil, '#B2C7BE'], 'burnt-titanium': [Anvil, '#D5D4D9'],
};
for (const option of themePicker.options) {
  const theme = themes[option.value];
  const card = document.createElement('button'); card.type = 'button'; card.className = 'theme-card';
  card.dataset.theme = option.value; card.setAttribute('role', 'radio'); card.setAttribute('aria-label', option.textContent);
  const icon = document.createElement('span'); icon.className = 'theme-card-icon'; icon.setAttribute('aria-hidden', 'true');
  icon.style.backgroundImage = 'url("theme-icons/' + option.value + '.svg?v=lucide-bases")';
  const [iconNode, color] = themeIcons[option.value];
  if (option.value === 'horizon') { const logo = document.createElement('img'); logo.src = 'singularity-logo.png?v=2'; logo.alt = ''; logo.width = logo.height = 34; icon.append(logo); }
  else if (theme.category !== 'basic') icon.append(createLucideIcon(iconNode, { width: 20, height: 20, 'stroke-width': 1.75, color, 'aria-hidden': 'true', focusable: 'false' }));
  const label = document.createElement('span'); label.className = 'theme-card-label';
  const title = document.createElement('strong'); title.textContent = option.textContent;
  const description = document.createElement('small'); description.textContent = theme.description;
  label.append(title, description); card.append(icon, label);
  card.onclick = () => { applyTheme(option.value); try { localStorage.setItem('horizon-theme', option.value); } catch {} };
  $({metals:'metal-theme-gallery',spice:'theme-gallery',basic:'basic-theme-gallery',horizon:'horizon-theme-gallery'}[theme.category]).append(card);
}
$('theme-groups').onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...$('theme-groups').querySelectorAll('.theme-card')];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? buttons.length - 1 : 1)) % buttons.length;
  event.preventDefault(); buttons[next].click(); buttons[next].focus();
};
try { applyTheme(localStorage.getItem('horizon-theme')); } catch { applyTheme(defaultTheme); }
themePicker.onchange = () => {
  applyTheme(themePicker.value);
  try { localStorage.setItem('horizon-theme', themePicker.value); } catch { /* Browser storage is unavailable. */ }
};

const ignoreServerThemes = $('ignore-server-themes');
try {
  ignoreServerThemes.checked = localStorage.getItem('horizon-ignore-server-themes') === 'true';
} catch { /* Browser storage is unavailable. */ }
ignoreServerThemePreference = ignoreServerThemes.checked;
ignoreServerThemes.onchange = () => {
  ignoreServerThemePreference = ignoreServerThemes.checked;
  try {
    localStorage.setItem('horizon-ignore-server-themes', String(ignoreServerThemes.checked));
  } catch { /* Browser storage is unavailable. */ }
  applyServerTheme();
};

function applyServerTheme() {
  document.body.style.removeProperty('--server-background');
  applyTheme(preferredTheme, false);
}

setupAppearanceOptions('appearance-shape-options', [
  ['round', 'Round'], ['square', 'Square'], ['square-rounded', 'Rounded square'],
  ['pentagonal', 'Pentagon'], ['pentagonal-rounded', 'Rounded pentagon'],
], 'horizon-avatar-shape', value => {
  document.documentElement.dataset.avatarShape = value;
}, value => {
  const avatar = document.createElement('span');
  avatar.className = 'shape-preview shape-preview-avatar';
  avatar.dataset.shape = value;
  const initials = document.createElement('span');
  initials.textContent = 'HC';
  avatar.append(initials);
  const server = document.createElement('span');
  server.className = 'shape-preview shape-preview-server';
  server.dataset.shape = value;
  const logo = document.createElement('img');
  logo.src = 'singularity-logo.png?v=2';
  logo.alt = '';
  logo.width = logo.height = 26;
  server.append(logo);
  return [avatar, server];
});

const passwordForm = $('change-password');
const passwordStatus = $('password-status');
passwordForm.onsubmit = async event => {
  event.preventDefault();
  const { currentPassword, newPassword, confirmPassword } = passwordForm.elements;
  if (newPassword.value !== confirmPassword.value) {
    passwordStatus.textContent = 'The new passwords do not match.';
    return;
  }
  const save = passwordForm.querySelector('[type="submit"]');
  save.disabled = true;
  passwordStatus.textContent = '';
  try {
    await call('password', { currentPassword: currentPassword.value, newPassword: newPassword.value });
    passwordForm.reset();
    passwordStatus.textContent = 'Password changed. Other sessions were signed out.';
  } catch (error) {
    passwordStatus.textContent = error.message;
  } finally {
    save.disabled = false;
  }
};
preferences.addEventListener('close', () => {
  passwordForm.reset();
  passwordStatus.textContent = '';
});

function openSettings(page = 'account') {
  if (!account) return;
  miniProfile.hidePopover();
  $('settings-account-handle').textContent = account.username;
  showPublicHandle($('edit-profile-handle'), account);
  $('edit-member-since').textContent = memberSince(account.joinedAt);
  const form = $('edit-profile');
  form.elements.displayName.value = account.displayName;
  form.elements.bio.value = account.bio || '';
  form.elements.status.value = account.status || '';
  resetImages(form);
  previewAccount();
  $('profile-status').textContent = '';
  showSettingsPage(page);
  preferences.showModal();
}
$('settings').onclick = () => openSettings();
$('mini-settings').onclick = () => openSettings('profile');
$('own-profile').onclick = event => openProfile(selectedProxy ? {
  ...selectedProxy, displayName: selectedProxy.name, bio: selectedProxy.description,
  senderId: account.id, proxyId: selectedProxy.id,
} : account, event.currentTarget);
$('close-profile').onclick = () => {miniOpenSequence++;miniProfile.hidePopover();};
$('edit-profile').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const viewer = account;
  const draft = imageDrafts.get(form);
  if (draft.pending) {
    $('profile-status').textContent = 'The image is still loading.';
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await call('profile', {
      displayName: form.elements.displayName.value,
      bio: form.elements.bio.value,
      status: form.elements.status.value,
      ...draft.values,
    });
    if (account !== viewer) return;
    Object.assign(account, result.account);
    showPublicHandle($('edit-profile-handle'), account);
    form.elements.displayName.value = account.displayName;
    form.elements.status.value = account.status || '';
    form.elements.bio.value = account.bio || '';
    updateAccountFooter();
    resetImages(form);
    previewAccount();
    drawMessages();
    $('profile-status').textContent = 'Profile saved.';
  } catch (error) {
    $('profile-status').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
$('open-character-dashboard').onclick = () => {
  if (!account) return;
  showSettingsPage('characters');
  drawProxyRoster();
};
$('proxy-export').onclick = () => showSettingsPage('backups');

function updateSpeaker() {
  const indicator = $('sending-as');
  const thread = activeConversation();
  const speaker = thread?.broadcast ? null : activeServerId ? selectedProxy : inboxProxyId ? proxies.find(proxy => proxy.id === inboxProxyId)
    : thread?.proxyId ? null : selectedProxy;
  indicator.hidden = !active || !speaker;
  indicator.textContent = speaker ? 'Sending as ' + speaker.name + (speaker.variants?.length>1?' · '+(speaker.variantName||'Main'):'') : '';
}

function drawProxies() {
  drawPersonaRail();
  if ($('character-binder').open) drawCharacterBinder();
  drawProxyRoster();
}

function paintProxySelection() {
  for (const row of $('proxy-roster').querySelectorAll('[data-proxy-id]')) {
    row.setAttribute('aria-pressed', String(Number(row.dataset.proxyId) === editingProxy?.id));
  }
}

function drawProxyRoster() {
  const query = $('proxy-search').value.trim().toLowerCase();
  const signature = JSON.stringify([query, proxies.map(proxy =>
    [proxy.id, proxy.name, proxy.group, proxy.prefix, proxy.suffix, proxy.designation, proxy.avatarUrl])]);
  if (signature === proxyRosterSignature) return;
  proxyRosterSignature = signature;
  const terms = query.split(/\s+/);
  const root = $('proxy-roster');
  if (!proxyRosterQuery && query) proxyUnfilteredScroll = root.scrollTop;
  const scroll = proxyRosterQuery && !query ? proxyUnfilteredScroll : root.scrollTop;
  proxyRosterQuery = query;
  const groups = new Map();
  let count = 0;
  for (const proxy of proxies) {
    const trigger = (proxy.prefix ?? '') + 'text' + (proxy.suffix ?? '');
    const searchable = [proxy.name, proxy.group || 'Ungrouped', proxy.prefix, proxy.suffix, proxy.designation, trigger].join(' ').toLowerCase();
    if (!terms.every(term => searchable.includes(term))) continue;
    const group = proxy.group || 'Ungrouped';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(proxy);
    count++;
  }
  $('proxy-count').textContent = (query ? count + ' of ' + proxies.length : String(count)) +
    (proxies.length === 1 ? ' character' : ' characters');
  const rows = document.createDocumentFragment();
  if (!query) {
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'character-choice';
    main.textContent = 'Main account';
    main.onclick = () => {
      if (!allowProxyNavigation()) return;
      void switchPersona(0);
      preferences.close();
    };
    rows.append(main);
  }
  if (!count && query) {
    const message = document.createElement('p');
    message.textContent = 'No characters match your search.';
    rows.append(message);
  }
  for (const [group, members] of groups) {
    const section = document.createElement('details');
    section.open = Boolean(query) || (proxyGroupStates.get(group) ??
      (groups.size === 1 || members.some(proxy => proxy.id === editingProxy?.id)));
    const heading = document.createElement('summary');
    heading.textContent = group;
    if (!query) heading.addEventListener('click', () => proxyGroupStates.set(group, !section.open));
    section.append(heading);
    for (const proxy of members) {
      const button = document.createElement('button');
      button.className = 'character-choice';
      button.type = 'button';
      button.dataset.proxyId = proxy.id;
      const avatar = characterAvatar(proxy.avatarUrl, true);
      const label = document.createElement('span');
      label.textContent = proxy.name;
      button.append(avatar, label);
      if (proxy.prefix || proxy.suffix) {
        const brackets = document.createElement('code');
        brackets.textContent = (proxy.prefix ?? '') + 'text' + (proxy.suffix ?? '');
        brackets.title = brackets.textContent;
        button.append(brackets);
      }
      button.onclick = () => {
        if (editingProxy?.id === proxy.id) showProxyEditorPane(true);
        else if (allowProxyNavigation()) {
          const current = proxies.find(item => item.id === proxy.id);
          if (current) openProxyEditor(current);
        }
      };
      section.append(button);
    }
    rows.append(section);
  }
  root.replaceChildren(rows);
  paintProxySelection();
  root.scrollTop = scroll;
}


function renderPreview(target, person) {
  const banner = document.createElement('div');
  banner.className = 'mini-banner';
  appendProfileImage(banner, person.bannerUrl, 'banner');
  const content = document.createElement('div');
  content.className = 'mini-content';
  const avatar = characterAvatar(person.avatarUrl);
  const title = document.createElement('h3');
  title.textContent = person.displayName;
  appendDesignation(title, person.designation);
  const bio = document.createElement('p');
  bio.textContent = person.bio;
  content.append(avatar, title);
  if (person.publicTag) {
    const handle = document.createElement('p');
    showPublicHandle(handle, person);
    content.append(handle);
  }
  if (person.status) {
    const status = document.createElement('p');
    status.className = 'profile-status-text';
    if (status.textContent !== person.status) status.textContent = person.status;
    content.append(status);
  }
  if (person.bio) content.append(bio);
  if (person.publicTag) {
    const date = document.createElement('dl');
    date.className = 'member-since';
    const label = document.createElement('dt');
    label.textContent = 'Member Since';
    const value = document.createElement('dd');
    value.textContent = memberSince(person.joinedAt);
    date.append(label, value);
    content.append(date);
  }
  target.replaceChildren(banner, content);
  if(person.character)addProfileBodyToggle(target,person.fullBodyUrl);
}

function memberSince(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
    : 'Date unavailable';
}

function appendDesignation(element, designation) {
  if (!designation) return;
  const suffix = document.createElement('span');
  suffix.className = 'profile-number';
  suffix.textContent = ':' + designation;
  element.append(suffix);
}

function resetImages(form) {
  form.elements.avatarFile.value = '';
  form.elements.bannerFile.value = '';
  if(form.elements.fullBodyFile)form.elements.fullBodyFile.value='';
  imageDrafts.set(form, { values: {}, pending: 0 });
}

function draftImage(form, kind, person) {
  const value=imageDrafts.get(form)?.values[kind] ?? person[kind + 'Url'];
  return form.id==='edit-proxy'&&editingVariantId&&!value?(editingProxy?.['base'+kind[0].toUpperCase()+kind.slice(1)+'Url']||''):value;
}

function previewAccount() {
  if (!account) return;
  const form = $('edit-profile');
  const avatar = draftImage(form, 'avatar', account);
  const banner = draftImage(form, 'banner', account);
  $('edit-avatar').replaceChildren(characterAvatar(avatar));
  $('edit-banner').querySelector('img')?.remove();
  appendProfileImage($('edit-banner'), banner, 'banner');
  form.querySelector('[data-remove-image="avatar"]').hidden = !avatar;
  form.querySelector('[data-remove-image="banner"]').hidden = !banner;
}

const proxyFields = ['name', 'group', 'prefix', 'suffix', 'description', 'designation', 'status'];
const proxyImageLabels = { avatar: 'avatar', banner: 'banner', fullBody: 'full-body image' };

function currentProxyVersion() {
  return editingProxy?.variants?.find(version => version.id === editingVariantId) || editingProxy || {};
}

function proxyFormSnapshot() {
  const form = $('edit-proxy');
  return JSON.stringify([...proxyFields, 'variantName'].map(key => form.elements[key].value));
}

function proxyHasChanges() {
  if (!proxyBaseline || $('proxy-editor').hidden) return false;
  const draft = imageDrafts.get($('edit-proxy'));
  return proxyFormSnapshot() !== proxyBaseline || Boolean(draft?.pending || Object.keys(draft?.values || {}).length);
}

function paintProxyDraft() {
  $('proxy-draft-status').textContent = proxySaving ? 'Saving…' : proxyHasChanges() ? 'Unsaved changes' : '';
}

function setProxyMutation(active) {
  proxyMutation = active;
  $('edit-proxy').querySelector('.character-editor-fields').inert = active;
}

window.addEventListener('beforeunload', event => {
  if (!proxyHasChanges() && !proxySaving && !proxyMutation) return;
  event.preventDefault();
  event.returnValue = '';
});

function allowProxyNavigation() {
  if (proxySaving || proxyMutation) return false;
  if (!proxyHasChanges()) return true;
  if (!confirm('Discard unsaved character changes?')) return false;
  if (editingProxy) openProxyEditor(editingProxy, editingVariantId, false);
  else clearProxyEditor();
  return true;
}

function showProxyEditorPane(open) {
  $('characters-menu').toggleAttribute('data-editor-open', open);
}

function clearProxyEditor() {
  editingProxy = null;
  proxyBaseline = '';
  resetImages($('edit-proxy'));
  $('proxy-editor').hidden = true;
  $('proxy-editor-empty').hidden = false;
  showProxyEditorPane(false);
  paintProxySelection();
}

function paintProxyHeader() {
  const form = $('edit-proxy');
  const person = currentProxyVersion();
  const value = key => form.elements[key].value || (editingVariantId ? person[key] || editingProxy?.[key] : '');
  $('proxy-header-name').textContent = value('name') || 'New character';
  const prefix = value('prefix');
  const suffix = value('suffix');
  $('proxy-header-meta').textContent = [
    value('group'), prefix || suffix ? (prefix || '') + 'text' + (suffix || '') : '',
    editingVariantId ? form.elements.variantName.value : '',
  ].filter(Boolean).join(' · ');
}

function previewProxy() {
  const form = $('edit-proxy');
  const person = currentProxyVersion();
  $('proxy-header-avatar').replaceChildren(characterAvatar(draftImage(form, 'avatar', person)));
  for (const [kind, label] of Object.entries(proxyImageLabels)) {
    const url = draftImage(form, kind, person);
    const view = form.querySelector('[data-view-image="' + kind + '"]');
    const pick = form.querySelector('[data-pick-image="' + kind + '"]');
    const remove = form.querySelector('[data-remove-image="' + kind + '"]');
    view.replaceChildren();
    if (url) appendProfileImage(view, url, kind === 'avatar' ? 'avatar' : 'banner');
    else view.textContent = 'No ' + label;
    view.disabled = !url;
    pick.textContent = (url ? 'Replace ' : 'Upload ') + label;
    remove.textContent = editingVariantId ? 'Use Main’s ' + label : 'Remove ' + label;
    remove.hidden = editingVariantId ? !(imageDrafts.get(form)?.values[kind] ?? person[kind + 'Override']) : !url;
  }
  paintProxyHeader();
  paintProxyDraft();
}

for (const view of $('edit-proxy').querySelectorAll('[data-view-image]')) {
  view.onclick = () => {
    const kind = view.dataset.viewImage;
    const source = profileImage(draftImage($('edit-proxy'), kind, currentProxyVersion()), kind === 'avatar' ? 'avatar' : 'banner');
    if (!source) return;
    const label = proxyImageLabels[kind];
    $('proxy-image-title').textContent = label[0].toUpperCase() + label.slice(1);
    $('proxy-image-full').alt = label;
    $('proxy-image-full').src = source;
    $('proxy-image-dialog').showModal();
  };
}
$('proxy-image-dialog').addEventListener('close', () => $('proxy-image-full').removeAttribute('src'));

async function encodeMapImage(file) {

  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 12_000_000) {

    throw new Error('Choose a PNG, JPEG, WebP, or GIF up to 12 MB.');

  }

  const bitmap = await createImageBitmap(file);

  let image = file;

  try {

    const scale = Math.min(1, 1920 / bitmap.width, 1080 / bitmap.height);

    if (scale < 1) {

      const canvas = document.createElement('canvas');

      canvas.width = Math.max(1, Math.round(bitmap.width * scale));

      canvas.height = Math.max(1, Math.round(bitmap.height * scale));

      const context = canvas.getContext('2d');

      context.imageSmoothingQuality = 'high';

      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

      if (!image) throw new Error('Could not resize the map image.');

    }

  } finally {

    bitmap.close();

  }

  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);

    reader.onerror = () => reject(new Error('Could not read the map image.'));

    reader.readAsDataURL(image);

  });

}



async function encodeProfileImage(file, kind) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 12_000_000) {
    throw new Error('Choose a PNG, JPEG, WebP, or GIF under 12 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const maximum = kind === 'avatar' ? 384 : kind === 'fullBody' ? 1600 : 1200;
    const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.62, 0.42, 0.25]) {
      const data = canvas.toDataURL('image/webp', quality);
      if (data.startsWith('data:image/webp;base64,') && data.length <= 300_000) return data;
    }
    throw new Error('This image is too large. Try a smaller image.');
  } finally {
    bitmap.close();
  }
}

function bindImages(form, render, status) {
  const fields = form.querySelector('.image-fields');
  fields?.append($('profile-image-fields').content.cloneNode(true));
  for (const kind of (form.elements.fullBodyFile ? ['avatar','banner','fullBody'] : ['avatar','banner'])) {
    const picker = form.elements[kind + 'File'];
    const trigger = form.querySelector('[data-pick-image="' + kind + '"]');
    if (trigger) trigger.onclick = () => picker.click();
    picker.onchange = async () => {
      const draft = imageDrafts.get(form);
      const file = picker.files[0];
      if (!file) return;
      draft.pending++;
      if (form.id === 'edit-proxy') paintProxyDraft();
      try {
        const value = await encodeProfileImage(file, kind);
        if (imageDrafts.get(form) === draft && picker.files[0] === file) {
          draft.values[kind] = value;
          status.textContent = '';
          render();
        }
      } catch (error) {
        if (imageDrafts.get(form) === draft && picker.files[0] === file) status.textContent = error.message;
      } finally {
        draft.pending--;
        if (form.id === 'edit-proxy') paintProxyDraft();
      }
    };
    form.querySelector('[data-remove-image="' + kind + '"]').onclick = () => {
      picker.value = '';
      imageDrafts.get(form).values[kind] = '';
      render();
    };
  }
  if (fields) form.oninput = render;
}

let editingVariantId=0;
function openProxyEditor(proxy, variantId = proxy?.variantId ?? 0, reveal = true) {
  editingProxy = proxy;
  editingVariantId = variantId;
  const form = $('edit-proxy');
  drawVariantEditor();
  const groups = [...new Set(proxies.map(character => character.group).filter(Boolean))];
  $('proxy-groups').replaceChildren(...groups.map(group => new Option(group)));
  resetImages(form);
  proxyBaseline = proxyFormSnapshot();
  $('proxy-editor').hidden = false;
  $('proxy-editor-empty').hidden = true;
  $('proxy-advanced').hidden = !proxy;
  $('proxy-editor-status').textContent = '';
  if (reveal) {
    showProxyEditorPane(true);
    form.querySelector('.character-editor-fields').scrollTop = 0;
  }
  previewProxy();
  paintProxySelection();
}

bindImages($('edit-profile'), previewAccount, $('profile-status'));
const proxyForm = $('edit-proxy');
bindImages(proxyForm, previewProxy, $('proxy-editor-status'));
proxyForm.addEventListener('input', () => { paintProxyHeader(); paintProxyDraft(); });
proxyForm.addEventListener('invalid', event => { const section = event.target.closest('details'); if (section) section.open = true; }, true);
$('new-proxy').onclick = () => {
  if (!allowProxyNavigation()) return;
  openProxyEditor(null);
  proxyForm.elements.name.closest('details').open = true;
  proxyForm.elements.name.focus();
};
$('proxy-back').onclick = () => {
  if (!allowProxyNavigation()) return;
  showProxyEditorPane(false);
  $('proxy-search').focus();
};
proxyForm.onsubmit = async event => {
  event.preventDefault();
  if (proxySaving || proxyMutation) return;
  const form = event.currentTarget;
  const viewer = account;
  const edited = editingProxy;
  const status = $('proxy-editor-status');
  const draft = imageDrafts.get(form);
  if (draft.pending) {
    status.textContent = 'The image is still loading.';
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  const fieldsPanel = form.querySelector('.character-editor-fields');
  proxySaving = submit.disabled = fieldsPanel.inert = true;
  status.textContent = '';
  paintProxyDraft();
  try {
    const values = Object.fromEntries(proxyFields.map(key => [key, form.elements[key].value]));
    const editVariant = editingVariantId;
    const fields = editVariant ? Object.fromEntries(proxyFields.map(key =>
      [key, edited['base' + key[0].toUpperCase() + key.slice(1)] ?? ''])) : values;
    let result = await call(edited ? 'proxies/' + edited.id : 'proxies', fields);
    if (account !== viewer) return;
    if (!edited) {
      editingProxy = result.proxy;
      proxies = applyPendingVariants(result.proxies);
      drawProxies();
    }
    const { name, ...overrides } = values;
    result = await call('proxies/' + result.proxy.id + '/variants', {
      ...overrides, action: 'save', variantId: editVariant, name: form.elements.variantName.value,
      displayName: name, ...draft.values,
    });
    if (account !== viewer) return;
    proxies = applyPendingVariants(result.proxies);
    if (selectedProxy?.id === result.proxy.id) {
      selectedProxy = result.proxy;
      updateAccountFooter();
      updateSpeaker();
    }
    openProxyEditor(result.proxy, editVariant, false);
    drawProxies();
    status.textContent = 'Character saved.';
  } catch (error) {
    if (account === viewer) status.textContent = error.message;
  } finally {
    proxySaving = submit.disabled = fieldsPanel.inert = false;
    paintProxyDraft();
  }
};
$('delete-proxy').onclick = async event => {
  const proxy = editingProxy;
  if (!proxy || proxySaving || proxyMutation || !confirm('Delete ' + proxy.name + '? Their past messages will remain.')) return;
  const viewer = account;
  const button = event.currentTarget;
  button.disabled = true;
  setProxyMutation(true);
  try {
    const result = await call('proxies/' + proxy.id + '/delete', {});
    if (account !== viewer) return;
    proxies = applyPendingVariants(result.proxies);
    if (selectedProxy?.id === proxy.id) {
      selectPersona(0);
    }
    if (editingProxy === proxy) clearProxyEditor();
    drawProxies();
    $('proxy-status').textContent = 'Character deleted.';
  } catch (error) {
    $('proxy-editor-status').textContent = error.message;
  } finally {
    button.disabled = false;
    setProxyMutation(false);
  }
};

$('proxy-search').oninput = drawProxyRoster;
preferences.addEventListener('cancel', event => {
  if (!$('characters-menu').hidden && !allowProxyNavigation()) event.preventDefault();
});
document.addEventListener('keydown', event => {
  if (!preferences.open || $('characters-menu').hidden || document.querySelector('dialog:modal:not(#preferences)')) return;
  const search = $('proxy-search');
  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (matchMedia('(max-width: 760px)').matches && $('characters-menu').hasAttribute('data-editor-open')) {
      if (!allowProxyNavigation()) return;
      showProxyEditorPane(false);
    }
    search.focus();
    search.select();
  } else if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's' && proxyForm.getClientRects().length) {
    event.preventDefault();
    if (!proxySaving) proxyForm.requestSubmit();
  } else if (event.target === search || event.target.matches('#proxy-roster [data-proxy-id]')) {
    const rows = [...$('proxy-roster').querySelectorAll('details[open] [data-proxy-id]')];
    const index = rows.indexOf(event.target);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      (rows[index + (event.key === 'ArrowDown' ? 1 : -1)] || (event.key === 'ArrowUp' ? search : rows[index]))?.focus();
    } else if (event.key === 'Enter' && event.target === search && rows.length) {
      event.preventDefault();
      rows[0].click();
    } else if (event.key === 'Escape' && (search.value || event.target !== search)) {
      event.preventDefault();
      search.value = '';
      drawProxyRoster();
      search.focus();
    }
  }
});
$('proxy-import').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.export.files[0];
  const viewer = account;
  const submit = form.querySelector('button');
  const status = $('proxy-status');
  if (!file) return;
  submit.disabled = true;
  try {
    if (file.size > 1_048_576) throw new Error('Choose a JSON file under 1 MB.');
    let data;
    try {
      data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('This file is not valid JSON.');
    }
    if (account !== viewer) return;
    const result = await call('proxies/import', data);
    if (account !== viewer) return;
    proxies = applyPendingVariants(result.proxies);
    const summary = ['Imported ' + result.imported];
    if (result.duplicates.length) summary.push('Skipped ' + result.duplicates.length + ' duplicates');
    if (result.invalid) summary.push('Skipped ' + result.invalid + ' invalid entries');
    status.textContent = summary.join('. ') + '.';
    status.title = result.duplicates.join(', ');
    drawProxies();
    form.reset();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
$('thread-title').onclick = event => {
  const person = activeConversation();
  if (person) openProfile(person, event.currentTarget);
};
$('logout').onclick = async () => {
  try {
    await call('logout', {});
    preferences.close();
    setMode(false);
    setAccount(null);
  } catch (error) {
    $('profile-status').textContent = error.message;
  }
};
document.querySelectorAll('[data-close]').forEach(button => {
  button.onclick = () => {
    const dialog = button.closest('dialog');
    if (dialog === preferences && !$('characters-menu').hidden && !allowProxyNavigation()) return;
    dialog.close();
  };
});
$('inbox').onclick = () => {
  const identity = selectedProxy?.id ?? 0;
  const threads = conversations.filter(item => (item.inboxProxyId ?? 0) === identity);
  if (!activeServerId && inboxProxyId === identity && threads.some(item => item.id === active)) return;
  const thread = threads.find(item => item.id === lastAccountDm) || threads[0];
  void openThread(thread?.id ?? null, identity);
};
$('inbox-title').onclick = $('chat-unread').onclick = openContacts;
$('close-broadcast').onclick = () => {
  const thread = activeConversation();
  if (thread?.broadcast && !thread.broadcastWriter) void closeConversation(thread);
};
$('toggle-server-members').onclick = event => {
  const open = app.toggleAttribute('data-show-members');
  event.currentTarget.setAttribute('aria-expanded', String(open));
};

const serverCreate = $('server-create');
const serverJoin = $('server-join');
const createForm = $('create-server-form');
const serverIconFile = $('server-icon-file');
const serverIconPreview = $('server-icon-preview');

function previewServerIcon() {
  if (serverIconPreview.src.startsWith('blob:')) URL.revokeObjectURL(serverIconPreview.src);
  const file = serverIconFile.files[0];
  serverIconPreview.hidden = !file;
  if (file) serverIconPreview.src = URL.createObjectURL(file);
  else serverIconPreview.removeAttribute('src');
}
$('pick-server-icon').onclick = () => serverIconFile.click();
serverIconFile.onchange = previewServerIcon;
$('add-server').onclick = () => {
  createForm.reset();
  previewServerIcon();
  $('server-create-status').textContent = '';
  createForm.elements.name.value = (account.displayName + "'s server").slice(0, 80);
  serverCreate.showModal();
  createForm.elements.name.select();
};
serverCreate.addEventListener('close', () => {
  createForm.reset();
  previewServerIcon();
});
$('open-join-server').onclick = () => {
  serverCreate.close();
  $('join-server-form').reset();
  $('server-join-status').textContent = '';
  serverJoin.showModal();
  $('join-server-form').elements.code.focus();
};

async function submitServer(form, route, payload, dialog, status) {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  status.textContent = '';
  const viewer = account;
  try {
    const { server } = await call(route, await payload());
    if (viewer !== account) return;
    if (!servers.some(item => item.id === server.id)) servers.push(server);
    dialog.close();
    await openThread(server.conversationId, 0, server.id);
    void refreshList().catch(showError);
    editor.focus();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}
createForm.onsubmit = event => {
  event.preventDefault();
  const name = createForm.elements.name.value;
  const file = serverIconFile.files[0];
  void submitServer(createForm, 'servers', async () => ({
    name, icon: file ? await encodeProfileImage(file, 'avatar') : undefined,
  }), serverCreate, $('server-create-status'));
};
$('join-server-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  const code = form.elements.code.value;
  void submitServer(form, 'servers/join', () => ({ code }), serverJoin, $('server-join-status'));
};
$('server-invite').onclick = () => {
  $('server-invite-code').value = activeServer().inviteCode;
  $('server-invite-status').textContent = '';
  $('server-invite-dialog').showModal();
  $('server-invite-code').select();
};
$('copy-server-invite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('server-invite-code').value);
    $('server-invite-status').textContent = 'Invite code copied.';
  } catch {
    $('server-invite-code').select();
    $('server-invite-status').textContent = 'Select and copy the invite code.';
  }
};
$('back').onclick = () => openThread(null);
$('older').onclick = () => refreshMessages(true).catch(showError);
composer.onsubmit = async event => {
  event.preventDefault();
  if (messageEdit) {
    await saveMessageEdit();
    return;
  }
  const { body, format } = editor.message();
  const snapshot = editor.snapshot();
  const { file, attachmentAlign } = snapshot;
  const submitted = JSON.stringify(snapshot);
  const matches = draft => draft?.file === file && JSON.stringify(draft) === submitted;
  const thread = active;
  const key = draftKey(thread);
  const reply = replyDrafts.get(key);
  if (!thread || (!body.trim() && !file) || sending) return;
  if (reply?.unavailable) {
    $('chat-status').textContent = 'Cancel the reply to send your draft as a new message.';
    return;
  }
  sending = true;
  $('chat-status').textContent = '';
  let result;
  try {
    const route = 'conversations/' + thread + '/messages';
    const message = { body, format, proxyId: selectedProxy?.id, variantId: selectedProxy?.variantId, inboxProxyId, replyTo: reply?.id, forumPostId: activeChannel()?.kind === 'forum' ? forum.postId : undefined };
    result = file ? await sendAttachment(route, { ...message, attachmentAlign }, file) : await call(route, message);
    if (replyDrafts.get(key) === reply) replyDrafts.delete(key);
    updateReplyDraft();
    if (active === thread && draftKey(thread) === key && matches(editor.snapshot())) {
      editor.restore();
      editor.focus();
    } else if (matches(drafts.get(key))) {
      drafts.delete(key);
    }
  } catch (error) {
    showError(error);
  } finally {
    sending = false;
  }
  if (result && active === thread) {
    try {
      if (result.updatedId) await refreshReproxy(thread, result.updatedId);
      else await refreshMessages();
      if (active === thread) history.scrollTop = history.scrollHeight;
    } catch (error) {
      if (active === thread) showError(error);
    }
  }
};

const diceTray = $('dice-tray');
const diceToggle = $('dice-toggle');
function closeDice() {
  diceTray.hidden = true;
  diceToggle.setAttribute('aria-expanded', 'false');
}
diceToggle.onclick = () => {
  diceTray.hidden = !diceTray.hidden;
  diceToggle.setAttribute('aria-expanded', String(!diceTray.hidden));
};
diceTray.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeDice(); diceToggle.focus(); }
});
document.addEventListener('pointerdown', event => {
  if (!diceTray.contains(event.target) && !diceToggle.contains(event.target)) closeDice();
});
async function submitDice(payload) {
  if (!active || sending || messageEdit || diceToggle.disabled) return;
  const thread = active;
  const identity = inboxProxyId;
  diceToggle.disabled = true;
  diceTray.querySelectorAll('button').forEach(action => { action.disabled = true; });
  $('dice-status').textContent = '';
  try {
    await call('conversations/' + thread + '/roll', { ...payload, inboxProxyId: identity, proxyId: selectedProxy?.id, variantId: selectedProxy?.variantId, forumPostId: activeChannel()?.kind === 'forum' ? forum.postId : undefined });
    closeDice();
    if (active === thread) await refreshMessages();
  } catch (error) {
    $('dice-status').textContent = error.message;
  } finally {
    diceToggle.disabled = false;
    diceTray.querySelectorAll('button').forEach(action => { action.disabled = false; });
  }
}
function adjustDice(sides, amount) {
  const input = $('dice-expression');
  const expression = input.value.replace(/\s+/g, '').toLowerCase();
  const terms = expression ? expression.split('+') : [];
  const pattern = new RegExp('^(?:[1-9]\\d*)?d' + sides + '$');
  const index = terms.findIndex(term => pattern.test(term));
  if (index >= 0) {
    const count = Number(terms[index].split('d')[0] || 1) + amount;
    if (count > 0) terms[index] = count + 'd' + sides;
    else terms.splice(index, 1);
  } else if (amount > 0) {
    terms.push('1d' + sides);
  }
  input.value = terms.join('+');
  input.focus();
}
for (const button of diceTray.querySelectorAll('[data-die]')) {
  button.onclick = () => adjustDice(button.dataset.die, 1);
  button.oncontextmenu = event => {
    event.preventDefault();
    adjustDice(button.dataset.die, -1);
  };
  button.title = 'Click to add; right-click to subtract';
}
$('roll-expression').onclick = () => void submitDice({ expression: $('dice-expression').value });
$('dice-expression').onkeydown = event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    void submitDice({ expression: event.currentTarget.value });
  }
};

$('attach-file').onpointerdown = editor.remember;
$('attach-file').onclick = () => $('attachment-file').click();
$('attachment-file').onchange = event => {
  const input = event.currentTarget;
  const file = input.files[0];
  input.value = '';
  attachFile(file);
};

function attachFile(file) {
  if (!file || !active) return;
  if (!file.size || file.size > 10 * 1024 * 1024) {
    if (messageEdit) editStatus.textContent = 'Choose a file up to 10 MB.';
    else showError(new Error('Choose a file up to 10 MB.'));
    return;
  }
  editor.attach(file);
  if (messageEdit) editStatus.textContent = '';
  $('chat-status').textContent = '';
}

async function attachmentThumbnail(file) {
  const imageFile = /\.(png|jpe?g|webp|gif)$/i.test(file.name);
  const videoFile = /\.(mp4|m4v|mov|webm|ogv)$/i.test(file.name);
  if (!imageFile && !videoFile) return null;
  let bitmap;
  let video;
  let url;
  try {
    if (imageFile) {
      bitmap = await createImageBitmap(file);
    } else {
      video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      const ready = new Promise((resolve, reject) => {
        const signal = AbortSignal.timeout(4000);
        video.addEventListener('loadeddata', resolve, { once: true, signal });
        video.addEventListener('error', reject, { once: true, signal });
        signal.addEventListener('abort', reject, { once: true });
      });
      url = URL.createObjectURL(file);
      video.src = url;
      await ready;
    }
    const source = bitmap || video;
    const width = bitmap?.width ?? video.videoWidth;
    const height = bitmap?.height ?? video.videoHeight;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    for (const maximum of [320, 230, 160, 100, 64]) {
      const scale = Math.min(1, maximum / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.65, 0.42, 0.25]) {
        const data = canvas.toDataURL('image/webp', quality);
        if (data.startsWith('data:image/webp;base64,') && data.length <= 6400) return data.split(',')[1];
      }
    }
  } catch {
    // Uploads still work if this browser cannot generate a preview.
  } finally {
    bitmap?.close();
    if (video) {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }
  return null;
}
async function sendAttachment(route, message, file) {
  const owner = account;
  let thumbnail;
  if (await isChatImage(file)) {
    const options = imageOptions(Object.fromEntries(['format', 'quality', 'maximum'].map(key => [key, $('chat-image-' + key).value])));
    const cancel = $('cancel-image-encoding');
    const status = messageEdit ? editStatus : $('chat-status');
    const encoder = new AbortController();
    imageEncoding = encoder;
    cancel.hidden = false;
    cancel.onclick = () => encoder.abort(new Error('Image encoding cancelled. Your draft is still available.'));
    try {
      status.textContent = 'Preparing image…';
      if (!(await call('chat-image-formats')).formats?.includes(options.format)) {
        throw new Error('The Horizon server has not enabled this chat image format.');
      }
      const encoded = await optimizeChatImage(file, options, {
        signal: encoder.signal, onProgress: value => { status.textContent = value; },
      });
      file = encoded.file;
      if (encoded.thumbnail) thumbnail = btoa(String.fromCharCode(...new Uint8Array(await encoded.thumbnail.arrayBuffer())));
      message = { ...message, optimizedImage: options.format };
      status.textContent = 'Uploading image…';
    } finally {
      if (imageEncoding === encoder) imageEncoding = null;
      cancel.hidden = true;
      cancel.onclick = null;
    }
  } else {
    thumbnail = await attachmentThumbnail(file);
  }
  if (!owner || account !== owner) throw new Error('The session changed. Sign in and try again.');
  const metadata = new TextEncoder().encode(JSON.stringify(message));
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Horizon-Chat': '1',
    'X-Horizon-Filename': encodeURIComponent(file.name),
    'X-Horizon-Message-Bytes': String(metadata.length),
  };
  if (thumbnail) headers['X-Horizon-Thumbnail'] = thumbnail;
  const response = await apiFetch(route, {
    method: 'POST', headers, body: new Blob([metadata, file]), signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) setAccount(null);
    throw new Error(result.error || 'Could not send the message.');
  }
  if (message.optimizedImage && !messageEdit) $('chat-status').textContent = '';
  return result;
}

for (const key of ['format', 'quality', 'maximum']) {
  const input = $('chat-image-' + key);
  const storage = 'horizon-chat-image-' + key;
  try { input.value = imageOptions({ [key]: localStorage.getItem(storage) ?? undefined })[key]; } catch {}
  input.onchange = () => {
    input.value = imageOptions({ [key]: input.value })[key];
    try { localStorage.setItem(storage, input.value); } catch {}
  };
}

async function checkInitialSession() {
  if (account) return;
  try {
    const result = await call('session');
    desktopConnection('');
    if (!account) setAccount(result.account);
  } catch (error) {
    if (isDesktop) {
      if (account) return;
      desktopConnection('Horizon is unreachable. Online features will reconnect automatically.');
      setTimeout(checkInitialSession, 10000);
    } else {
      $('auth-status').textContent = error.message;
    }
  }
}
if (isDesktop) {
  $('welcome').querySelector('a').href = 'https://brokensynapse.us/';
  desktopConnection('Connecting to Horizon…');
  void checkInitialSession();
} else {
  await checkInitialSession();
}

// Presence is account-wide, including characters, and never replaces an avatar.
let presenceStates = new Map();
let lastInteraction = Date.now();
let presenceRequest = false;
function paintPresence() {
  for (const node of document.querySelectorAll('[data-presence-id]')) {
    let badge = node.querySelector(':scope > .presence-indicator');
    if (!badge) { badge = document.createElement('span'); badge.className = 'presence-indicator'; badge.setAttribute('role','img'); node.append(badge); }
    const state = presenceStates.get(Number(node.dataset.presenceId)) || 'offline';
    badge.dataset.state = state; badge.title = state[0].toUpperCase() + state.slice(1); badge.setAttribute('aria-label',badge.title);
  }
}
async function refreshPresence(push = true) {
  if (!account || presenceRequest) return;
  const viewer = account; presenceRequest = true;
  try {
    const state = document.hidden || Date.now() - lastInteraction > 5 * 60_000 ? 'away' : 'online';
    const result = await call('presence', push ? { state } : undefined);
    if (viewer !== account) return;
    presenceStates = new Map(result.presence.map(person=>[person.id,person.state]));
    paintPresence();
  } catch {} finally { presenceRequest = false; }
}
async function refreshMentions() {
  if (!account) return;
  const viewer = account;
  try {
    const result = await call('mentions');
    if (viewer !== account) return;
    for (const item of result.mentions) {
      if (item.conversationId === active && document.hasFocus() && !document.hidden) {
        void call('mentions/read',{conversationId:active}).catch(()=>{});
      } else mentionedChannels.add(item.conversationId);
    }
    drawServers();
  } catch {}
}
for (const type of ['pointerdown','keydown','pointermove']) document.addEventListener(type, () => {
  const wasAway = Date.now() - lastInteraction > 5 * 60_000;
  lastInteraction = Date.now(); if (wasAway) void refreshPresence();
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) lastInteraction = Date.now(); void refreshPresence(); });
setInterval(() => { void refreshPresence(); }, 30_000);
new MutationObserver(paintPresence).observe(app, { childList: true, subtree: true });

const mentionMenu = document.createElement('div');
mentionMenu.id = 'mention-suggestions'; mentionMenu.hidden = true; mentionMenu.setAttribute('role','listbox'); mentionMenu.setAttribute('aria-label','Mention suggestions'); composer.append(mentionMenu);
let mentionRange = null, mentionIndex = 0, mentionChoices = [], mentionBlurTimer;
function hideMentions() { mentionMenu.hidden = true; mentionRange = null; }
function chooseMention(index) {
  if (!mentionRange || !mentionChoices[index]) return;
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(mentionRange);
  document.execCommand('insertText',false,mentionChoices[index].token + ' '); hideMentions(); editor.remember();
}
function suggestMentions() {
  clearTimeout(mentionBlurTimer);
  const selection = getSelection(); const node = selection.anchorNode;
  if (!selection.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !$('draft').contains(node)) return hideMentions();
  const before = node.textContent.slice(0,selection.anchorOffset);
  const match = /(?:^|\s)\$(?:\{)?([^$\n{}]*)$/.exec(before);
  if (!match) return hideMentions();
  const query = match[1].toLocaleLowerCase();
  const server = activeServer();
  const people = server?.members || contacts;
  const token = name => /\s/.test(name) ? '${' + name + '}' : '$' + name;
  const recency = new Map();
  for (const message of [...entries].reverse()) if (!recency.has(message.senderId)) recency.set(message.senderId, recency.size);
  const members = [...people].sort((a,b)=>(recency.get(a.id) ?? 9999)-(recency.get(b.id) ?? 9999));
  const groups = [
    { heading: query ? 'Members' : 'Recent members', choices: members.filter(person=>[person.displayName,person.publicTag].join('#').toLocaleLowerCase().includes(query)).slice(0,query?6:3).map(person=>({label:person.displayName,detail:person.publicTag?'#'+person.publicTag:'',avatar:person.avatarUrl,type:'member',token:token(person.displayName+(person.publicTag?'#'+person.publicTag:''))})) },
  ];
  if (activeChannel()?.canMentionRoles) {
    groups.push({heading:'Notify a group',choices:[{label:'everyone',detail:'All members',token:'$everyone'},{label:'here',detail:'Online members',token:'$here'}].filter(item=>item.label.includes(query))});
    if(query)groups.push({heading:'Roles',choices:(server?.roles||[]).filter(role=>role.name.toLocaleLowerCase().includes(query)).slice(0,4).map(role=>({label:role.name,token:token(role.name),color:role.color,type:'role'}))});
  }
  mentionChoices = groups.flatMap(group=>group.choices);
  if (!mentionChoices.length) return hideMentions();
  mentionRange = selection.getRangeAt(0).cloneRange();
  mentionRange.setStart(node,before.lastIndexOf('$')); mentionIndex=0;
  mentionMenu.replaceChildren();
  let index=0;
  for(const group of groups) {
    if(!group.choices.length)continue;
    const heading=document.createElement('div');heading.className='mention-group-heading';heading.textContent=group.heading;mentionMenu.append(heading);
    for(const choice of group.choices) {
      const optionIndex=index++;
      const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-label',choice.label);button.setAttribute('aria-selected',String(optionIndex===0));
      if(choice.type==='member')button.append(characterAvatar(choice.avatar));
      else {const symbol=document.createElement('span');symbol.className='mention-symbol';symbol.textContent=choice.type==='role'?'◇':'$';button.append(symbol);}
      const label=document.createElement('span');label.className='mention-option-name';label.textContent=choice.label;button.append(label);
      if(choice.color)paintRole(label,choice.color);
      if(choice.detail){const detail=document.createElement('small');detail.textContent=choice.detail;button.append(detail);}
      button.onpointerdown=event=>event.preventDefault();button.onclick=()=>chooseMention(optionIndex);mentionMenu.append(button);
    }
  }
  mentionMenu.hidden=false;
}
$('draft').addEventListener('input',suggestMentions);
$('draft').addEventListener('keydown',event=>{
  if(mentionMenu.hidden)return;
  if(['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) {
    event.preventDefault();event.stopImmediatePropagation();
    if(event.key==='Escape')return hideMentions();
    if(event.key==='Enter'||event.key==='Tab')return chooseMention(mentionIndex);
    mentionIndex=(mentionIndex+(event.key==='ArrowDown'?1:-1)+mentionChoices.length)%mentionChoices.length;
    [...mentionMenu.querySelectorAll('[role=option]')].forEach((node,index)=>node.setAttribute('aria-selected',String(index===mentionIndex)));
    mentionMenu.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});
  }
},true);
$('draft').addEventListener('focus',()=>clearTimeout(mentionBlurTimer));
$('draft').addEventListener('blur',()=>{mentionBlurTimer=setTimeout(hideMentions,150);});

// Prevent the browser from navigating away when a file is dropped anywhere.
for (const type of ['dragover','drop']) window.addEventListener(type,event=>{
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  if (event.target instanceof Element && event.target.closest('input[type=file]')) return;
  event.preventDefault();
  if(type==='dragover') { event.dataTransfer.dropEffect = active && !composer.hidden ? 'copy' : 'none'; return; }
  event.stopImmediatePropagation();
  const files=[...event.dataTransfer.files];
  if (document.querySelector('dialog[open]') || forum.composing) return;
  if (!active || composer.hidden) { showError(new Error('Open a writable chat before dropping a file.')); return; }
  if (files.length !== 1) { showError(new Error('Drop one file at a time.')); return; }
  attachFile(files[0]);editor.focus();
},{capture:true});

function renderMentionToken(token) {
  const name=token.slice(1).replace(/^\{(.*)\}$/,'$1').normalize('NFKC').toLocaleLowerCase();
  const people=activeServer()?.members || contacts;
  const person=people.find(person=>(person.displayName+'#'+person.publicTag).normalize('NFKC').toLocaleLowerCase()===name || person.displayName.normalize('NFKC').toLocaleLowerCase()===name);
  if(!person)return null;
  const chip=document.createElement('span');chip.className='message-mention member-mention';chip.title=person.displayName+(person.publicTag?'#'+person.publicTag:'');
  chip.append(characterAvatar(person.avatarUrl),document.createTextNode(person.displayName));return chip;
}

function applyVariantChoice(person,variantId){
  const variant=person?.variants?.find(v=>v.id===variantId);return variant?{...person,name:variant.displayName??person.name,description:variant.description??person.description,group:variant.group??person.group,prefix:variant.prefix??person.prefix,suffix:variant.suffix??person.suffix,avatarUrl:variant.avatarUrl,bannerUrl:variant.bannerUrl,fullBodyUrl:variant.fullBodyUrl,status:variant.status??person.baseStatus??person.status,designation:variant.designation||person.baseDesignation||person.designation,variantId:variant.id,variantName:variant.name}:person;
}
function applyPendingVariants(list){return list.map(person=>pendingVariantChoices.has(person.id)?applyVariantChoice(person,pendingVariantChoices.get(person.id).variantId):person);}
function updateVariantControls(){
  const list=selectedProxy?.variants||[];
  $('persona-variant-controls').hidden=!selectedProxy;
  $('chat-variant-selector').hidden=!selectedProxy;
  $('chat-variant-selector').textContent=(selectedProxy?.variantName||'Main')+' ▾';
  const name=selectedProxy?.variantName||'Main';
  $('current-persona-variant').textContent=name;
  $('current-persona-variant').title=(selectedProxy?.name||'')+' · '+name+' · '+Math.max(1,list.findIndex(v=>v.id===selectedProxy?.variantId)+1)+'/'+Math.max(1,list.length);
  $('previous-persona-variant').disabled=$('next-persona-variant').disabled=list.length<2;
  $('previous-persona-variant').title='Previous variant (Alt+Up)';$('next-persona-variant').title='Next variant (Alt+Down)';
}
async function selectCharacterVariant(proxyId,variantId){
  const viewer=account,core=proxies.find(person=>person.id===proxyId);
  if(!core?.variants?.some(v=>v.id===variantId))return;
  const sequence=++variantChoiceSequence;
  pendingVariantChoices.set(proxyId,{variantId,sequence});
  proxies=applyPendingVariants(proxies);
  if(selectedProxy?.id===proxyId){selectedProxy=proxies.find(p=>p.id===proxyId);updateAccountFooter();updateSpeaker();}
  else void switchPersona(proxyId).catch(showError);
  publishPersona();drawServers();
  drawProxies();
  const write=variantWriteQueue.catch(()=>{}).then(async()=>{
    if(viewer!==account)return;
    try{
      const result=await call('proxies/'+proxyId+'/variants',{action:'select',variantId});
      if(viewer!==account)return;
      if(pendingVariantChoices.get(proxyId)?.sequence===sequence){
        proxies=applyPendingVariants(result.proxies);
        await refreshList();
        if(pendingVariantChoices.get(proxyId)?.sequence===sequence)pendingVariantChoices.delete(proxyId);
      }
      return proxies.find(person=>person.id===proxyId);
    }catch(error){
      if(viewer===account&&pendingVariantChoices.get(proxyId)?.sequence===sequence){pendingVariantChoices.delete(proxyId);await refreshList().catch(()=>{});}
      throw error;
    }
  });
  variantWriteQueue=write.catch(()=>{});return write;
}
async function cycleCharacterVariant(step){
  if(!selectedProxy)return;
  const list=selectedProxy.variants||[],index=list.findIndex(v=>v.id===selectedProxy.variantId);
  if(list.length<2)return;
  return selectCharacterVariant(selectedProxy.id,list[(index+step+list.length)%list.length].id);
}
$('previous-persona-variant').onclick=()=>void cycleCharacterVariant(-1).catch(showError);
$('next-persona-variant').onclick=()=>void cycleCharacterVariant(1).catch(showError);
function drawVariantEditor(){
  const list=editingProxy?.variants||[{id:0,name:'Main'}];
  if(!list.some(v=>v.id===editingVariantId))editingVariantId=0;
  $('proxy-edit-variant').replaceChildren(...list.map(v=>new Option(v.name,v.id)));
  $('proxy-edit-variant').value=String(editingVariantId);
  $('variant-label-field').hidden=!editingVariantId;
  const version=list.find(v=>v.id===editingVariantId);
  $('edit-proxy').elements.variantName.value=version?.name||'Main';
  const hash=$('edit-proxy').elements.designation;hash.required=!editingVariantId;hash.value=editingVariantId?(version?.designationOverride||''):(editingProxy?.baseDesignation||editingProxy?.designation||account.publicTag);hash.placeholder=editingVariantId?'Use Main: '+(editingProxy?.baseDesignation||account.publicTag):'';
  $('variant-hash-help').hidden=!editingVariantId;
  const status=$('edit-proxy').elements.status;status.value=editingVariantId?(version?.statusOverride||''):(editingProxy?.baseStatus??editingProxy?.status??'');status.placeholder=editingVariantId?'Use Main: '+(editingProxy?.baseStatus||'No status'):'Add a status';
  $('variant-status-help').hidden=!editingVariantId;
  for(const key of ['name','description','group','prefix','suffix']){const input=$('edit-proxy').elements[key],base=editingProxy?.['base'+key[0].toUpperCase()+key.slice(1)]??editingProxy?.[key]??'';input.value=editingVariantId?(version?.[key+'Override']||''):base;input.placeholder=editingVariantId?'Use Main: '+(base||'Empty'):'';if(key==='name')input.required=!editingVariantId;}
  $('new-character-variant').disabled=!editingProxy;
  $('delete-character-variant').hidden=!editingVariantId;
  $('use-character-variant').disabled=!editingProxy||editingProxy.variantId===editingVariantId;
}
$('proxy-edit-variant').onchange = event => {
  const next = Number(event.target.value);
  if (!allowProxyNavigation()) { event.target.value = String(editingVariantId); return; }
  openProxyEditor(editingProxy, next, false);
};
$('new-character-variant').onclick = () => {
  if (!allowProxyNavigation()) return;
  const dialog = $('new-variant-dialog');
  dialog.querySelector('form').reset();
  dialog.querySelector('[role=status]').textContent = '';
  dialog.showModal();
  dialog.querySelector('input').focus();
};
$('new-variant-dialog').querySelector('form').onsubmit = async event => {
  event.preventDefault();
  if (!editingProxy || proxyMutation) return;
  const viewer = account;
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  setProxyMutation(true);
  try {
    const result = await call('proxies/' + editingProxy.id + '/variants', {
      action: 'create', name: form.elements.name.value, fromVariantId: editingVariantId,
    });
    if (account !== viewer) return;
    proxies = applyPendingVariants(result.proxies);
    openProxyEditor(result.proxy, result.variantId);
    drawProxies();
    $('new-variant-dialog').close();
  } catch (error) {
    form.querySelector('[role=status]').textContent = error.message;
  } finally { submit.disabled = false; setProxyMutation(false); }
};
$('use-character-variant').onclick = async () => {
  if (!editingProxy || !allowProxyNavigation()) return;
  const viewer = account;
  setProxyMutation(true);
  try {
    const person = await selectCharacterVariant(editingProxy.id, editingVariantId);
    if (account === viewer) openProxyEditor(person, editingVariantId);
  } catch (error) { $('proxy-editor-status').textContent = error.message; }
  finally { setProxyMutation(false); }
};
$('delete-character-variant').onclick = async () => {
  if (!editingProxy || !editingVariantId || !allowProxyNavigation() ||
      !confirm('Delete this variant? Existing posts keep their appearance.')) return;
  const viewer = account;
  setProxyMutation(true);
  try {
    const result = await call('proxies/' + editingProxy.id + '/variants', { action: 'delete', variantId: editingVariantId });
    if (account !== viewer) return;
    proxies = applyPendingVariants(result.proxies);
    if (selectedProxy?.id === result.proxy.id) { selectedProxy = result.proxy; updateAccountFooter(); }
    openProxyEditor(result.proxy, 0);
    drawProxies();
  } catch (error) { $('proxy-editor-status').textContent = error.message; }
  finally { setProxyMutation(false); }
};
function fillBodyPanel(panel,url){
  const source=profileImage(url,'banner');
  if(panel.dataset.source===(source||'')&&panel.firstElementChild)return;
  panel.dataset.source=source||'';panel.replaceChildren();
  if(source){const image=document.createElement('img');image.src=source;image.alt='Full-body character image';panel.append(image);}
  else{const text=document.createElement('p');text.textContent='No full-body image has been added for this version.';panel.append(text);}
}
function resetMiniBody(person){
  miniProfile.classList.remove('show-full-body');$('mini-full-body').hidden=true;
  const toggle=$('mini-body-toggle');toggle.hidden=!person.proxyId;toggle.className='body-toggle person-logo';toggle.setAttribute('aria-label','View full-body image');toggle.title='View full-body image';
  fillBodyPanel($('mini-full-body'),person.fullBodyUrl);
}
$('mini-body-toggle').onclick=()=>{
  const show=miniProfile.classList.toggle('show-full-body');$('mini-full-body').hidden=!show;
  const button=$('mini-body-toggle');button.classList.toggle('person-logo',!show);button.classList.toggle('card-logo',show);button.setAttribute('aria-label',show?'Back to profile':'View full-body image');button.title=show?'Back to profile':'View full-body image';
};
function drawMiniVariants(person){
  const core=proxies.find(p=>p.id===person.proxyId);
  const own=(person.senderId??person.peerId??person.id)===account?.id;
  $('mini-variant-controls').hidden=!own||!core||core.variants.length<2;
  $('mini-variant-name').textContent=person.variantName||'Main';
  const cycle=async step=>{if(!core)return;const index=Math.max(0,core.variants.findIndex(v=>v.id===(person.variantId??0)));try{const next=await selectCharacterVariant(core.id,core.variants[(index+step+core.variants.length)%core.variants.length].id);openProfile({...next,displayName:next.name,bio:next.description,senderId:account.id,proxyId:next.id},$('own-profile'));}catch(error){$('mini-dm-status').textContent=error.message;}};
  $('mini-previous-variant').onclick=()=>void cycle(-1);$('mini-next-variant').onclick=()=>void cycle(1);
}
function addProfileBodyToggle(target,url){
  const button=document.createElement('button');button.type='button';button.className='body-toggle person-logo';button.setAttribute('aria-label','View full-body image');button.title='View full-body image';
  const panel=document.createElement('div');panel.className='full-body-panel';panel.hidden=true;fillBodyPanel(panel,url);
  button.onclick=event=>{event.stopPropagation();const show=panel.hidden;panel.hidden=!show;target.classList.toggle('show-full-body',show);button.classList.toggle('person-logo',!show);button.classList.toggle('card-logo',show);button.setAttribute('aria-label',show?'Back to profile':'View full-body image');button.title=show?'Back to profile':'View full-body image';};
  button.onkeydown=event=>event.stopPropagation();target.append(panel,button);
}
let passwordSettingsChannel=null;
function openChannelPassword(channel){
  passwordSettingsChannel=channel;const dialog=$('channel-password-settings'),form=dialog.querySelector('form');form.reset();form.elements.enabled.checked=Boolean(channel.passwordProtected);form.querySelector('[role=status]').textContent='';form.elements.password.placeholder=channel.passwordProtected?'Leave blank to keep the current password':'';updatePasswordField();dialog.showModal();
}
function updatePasswordField(){const form=$('channel-password-settings').querySelector('form');$('new-channel-password-field').hidden=!form.elements.enabled.checked;form.elements.password.required=form.elements.enabled.checked&&!passwordSettingsChannel?.passwordProtected;}
$('channel-password-settings').querySelector('[name=enabled]').onchange=updatePasswordField;
$('channel-password-settings').querySelector('form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,submit=form.querySelector('[type=submit]');submit.disabled=true;
  try{await call('conversations/'+passwordSettingsChannel.conversationId+'/password',{enabled:form.elements.enabled.checked,password:form.elements.password.value});$('channel-password-settings').close();await refreshList();}
  catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{submit.disabled=false;}
};
$('unlock-channel').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,submit=form.querySelector('[type=submit]'),conversation=active;submit.disabled=true;
  try{await call('conversations/'+conversation+'/unlock',{password:form.elements.password.value});form.reset();await refreshList();if(active===conversation){updateChannelControls(activeChannel(),activeServer());await refreshMessages();}}
  catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{submit.disabled=false;}
};

$('channel-password-settings').addEventListener('close',()=>{$('channel-password-settings').querySelector('form').reset();});

function positionMiniProfile(){
  if(!miniProfile.matches(':popover-open'))return;
  if(miniProfileAnchor?.isConnected)miniProfileBounds=miniProfileAnchor.getBoundingClientRect();
  const bounds=miniProfileBounds||{left:8,right:8,top:8};
  const viewport=window.visualViewport,edgeX=(viewport?.offsetLeft||0)+8,edgeY=(viewport?.offsetTop||0)+8;
  const viewWidth=viewport?.width||innerWidth,viewHeight=viewport?.height||innerHeight;
  miniProfile.style.maxHeight=Math.max(80,viewHeight-16)+'px';miniProfile.style.maxWidth=Math.max(100,viewWidth-16)+'px';
  const width=miniProfile.offsetWidth,height=miniProfile.offsetHeight;
  const maxX=edgeX+viewWidth-16-width,maxY=edgeY+viewHeight-16-height;
  const desired=bounds.right+width+8<=edgeX+viewWidth-8?bounds.right+8:bounds.left-width-8;
  miniProfile.style.left=Math.max(edgeX,Math.min(desired,maxX))+'px';
  miniProfile.style.top=Math.max(edgeY,Math.min(bounds.top,maxY))+'px';
}
function scheduleMiniPosition(){cancelAnimationFrame(miniPositionFrame);miniPositionFrame=requestAnimationFrame(positionMiniProfile);}
new ResizeObserver(scheduleMiniPosition).observe(miniProfile);
miniProfile.addEventListener('load',scheduleMiniPosition,true);
window.addEventListener('resize',scheduleMiniPosition,{passive:true});
window.addEventListener('scroll',scheduleMiniPosition,{capture:true,passive:true});
window.visualViewport?.addEventListener('resize',scheduleMiniPosition);
window.visualViewport?.addEventListener('scroll',scheduleMiniPosition);
function openVariantMenu(anchor){
  if(!selectedProxy)return;
  const menu=$('persona-variant-menu');menu.replaceChildren();
  for(const variant of selectedProxy.variants||[]){
    const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(variant.id===selectedProxy.variantId));
    const text=document.createElement('span');text.textContent=variant.name;button.append(characterAvatar(variant.avatarUrl),text);
    button.onpointerdown=event=>event.preventDefault();
    button.onclick=()=>{menu.hidePopover();void selectCharacterVariant(selectedProxy.id,variant.id).catch(showError);if(active&&!composer.hidden)editor.focus();};menu.append(button);
  }
  const manage=document.createElement('button');manage.type='button';manage.textContent='Manage variants…';manage.className='manage-variants';manage.onclick=()=>{menu.hidePopover();openSettings('characters');drawProxyRoster();openProxyEditor(selectedProxy);$('proxy-variants-section').open=true;};menu.append(manage);
  menu.showPopover({source:anchor});
  const box=anchor.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
  menu.style.left=Math.max(8,Math.min(box.left,innerWidth-width-8))+'px';
  const top=box.top-height-6>=8?box.top-height-6:box.bottom+6;
  menu.style.top=Math.max(8,Math.min(top,innerHeight-height-8))+'px';
}
$('current-persona-variant').onclick=event=>openVariantMenu(event.currentTarget);
$('chat-variant-selector').onclick=event=>openVariantMenu(event.currentTarget);
for(const button of [$('previous-persona-variant'),$('next-persona-variant')])button.addEventListener('pointerdown',event=>event.preventDefault());

const profileChanges=new Map();let profileChangeTimer,profileChangeBusy=false;
function scheduleProfileUpdate(data){
  const [actor,subject]=data.split(':');const id=Number(actor);if(!Number.isSafeInteger(id))return;
  if(!profileChanges.has(id))profileChanges.set(id,new Set());profileChanges.get(id).add(subject);
  clearTimeout(profileChangeTimer);profileChangeTimer=setTimeout(refreshLiveProfiles,25);
}
async function refreshLiveProfiles(){
  if(profileChangeBusy||!account)return;
  const viewer=account,changed=new Map(profileChanges);profileChanges.clear();profileChangeBusy=true;
  try{
    if(changed.get(account.id)?.has('account')){
      const session=await call('session');if(viewer!==account)return;if(session.account)Object.assign(account,session.account);
    }
    await refreshList();if(viewer!==account)return;
    const affects=entry=>changed.get(entry.senderId)?.has(entry.proxyId?String(entry.proxyId):'account');
    if(active&&!activeChannel()?.locked&&(entries.some(affects)||entries.some(entry=>entry.isReply)))await refreshMessages(false,true);
    if(viewer!==account)return;
    if(miniProfile.matches(':popover-open')&&miniProfilePerson){
      const person=miniProfilePerson,actor=person.senderId??person.peerId??person.id;
      if(changed.get(actor)?.has(person.proxyId?String(person.proxyId):'account')){
        let fresh;
        if(person.proxyId){
          if(actor===account.id){const core=proxies.find(p=>p.id===person.proxyId),variant=core?.variants.find(v=>v.id===(person.variantId??0));if(core&&variant)fresh={...person,displayName:variant.displayName??core.name,bio:variant.description??core.description,status:variant.status??core.baseStatus??core.status,designation:variant.designation||core.baseDesignation||core.designation,avatarUrl:variant.avatarUrl,bannerUrl:variant.bannerUrl,fullBodyUrl:variant.fullBodyUrl};}
          if(!fresh)fresh=entries.find(entry=>entry.id===person.id&&entry.proxyId===person.proxyId)||conversations.find(thread=>thread.peerId===actor&&thread.proxyId===person.proxyId);
        }else fresh=actor===account.id?account:activeServer()?.members.find(member=>member.id===actor)||conversations.find(thread=>thread.peerId===actor&&!thread.proxyId)||entries.find(entry=>entry.senderId===actor&&!entry.proxyId);
        if(fresh)openProfile(fresh,miniProfileAnchor,{refresh:true});
      }
    }
  }catch(error){if(viewer===account)showError(error);}
  finally{profileChangeBusy=false;if(profileChanges.size)profileChangeTimer=setTimeout(refreshLiveProfiles,0);}
}

document.addEventListener('keydown',event=>{
  if(event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&['ArrowUp','ArrowDown'].includes(event.key)&&selectedProxy&&(selectedProxy.variants?.length||0)>1&&!preferences.open&&!$('character-binder').open){
    event.preventDefault();event.stopImmediatePropagation();void cycleCharacterVariant(event.key==='ArrowUp'?-1:1).catch(showError);
  }
},true);
