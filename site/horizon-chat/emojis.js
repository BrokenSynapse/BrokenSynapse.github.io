import { apiUrl } from './platform.js';
import { artwork, shortcodes } from './twemoji/catalog.js';

const reference = /^<e:([1-9a-f][0-9a-f]{0,12}(?:\.[1-9a-f][0-9a-f]{0,12})?)>$/;
const assetBase = new URL('./twemoji/svg/', import.meta.url).href;
const segmenter = new Intl.Segmenter();
const builtin = shortcodes.flatMap(([unicode, aliases]) => {
  const identity = artworkFor(unicode) || unicode;
  return aliases.map(name => ({ identity, name, unicode }));
});
const clipboardType = 'application/x-horizon-emoji';

function artworkFor(value) {
  if (!/[\u200d\u20e3\ufe0f\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(value) || value.includes('\ufe0e')) return null;
  const id = Array.from(value, char => char.codePointAt(0).toString(16)).join('-');
  if (artwork.has(id)) return id;
  const basic = id.replace(/-fe0f(?=-|$)/g, '');
  return artwork.has(basic) ? basic : null;
}

function art(src, label, loading = 'lazy') {
  const image = document.createElement('img');
  image.className = 'inline-emoji';
  image.src = src;
  image.alt = label;
  image.draggable = false;
  image.loading = loading;
  return image;
}

export function customEmoji(ref, editing = false, name = '') {
  const id = reference.exec(ref)?.[1];
  if (!id) return document.createTextNode(ref || '');
  const token = document.createElement('span');
  token.dataset.emoji = ref;
  token.className = 'emoji-token';
  if (editing) token.contentEditable = 'false';
  const fallback = document.createElement('span');
  fallback.className = 'emoji-reference';
  fallback.textContent = ref;
  const image = art(apiUrl('emoji-art/' + id), name ? ':' + name + ':' : 'Custom emoji');
  image.title = image.alt;
  const hideMissing = () => {
    image.remove();
    token.classList.add('emoji-missing');
    token.title = 'Missing emoji ' + ref;
  };
  image.addEventListener('error', hideMissing, { once: true });
  if (image.complete && !image.naturalWidth) hideMissing();
  token.append(fallback);
  if (!token.classList.contains('emoji-missing')) token.append(image);
  return token;
}

export function emojiText(value, legacy = [], editing = false) {
  const fragment = document.createDocumentFragment();
  const aliases = new Map(legacy.map(emoji => [emoji.name, emoji]));
  function appendUnicode(text) {
    // Fast path for ordinary ASCII and text without emoji presentation characters.
    if (!/[^\x00-\x7f]/.test(text)) {
      fragment.append(text);
      return;
    }
    let start = 0;
    for (const { segment, index } of segmenter.segment(text)) {
      const id = artworkFor(segment);
      if (!id) continue;
      const image = art(assetBase + id + '.svg', segment);
      image.addEventListener('error', () => {
        if (editing) {
          image.parentElement?.classList.add('emoji-native');
          image.remove();
        } else {
          image.replaceWith(segment);
        }
      }, { once: true });
      fragment.append(text.slice(start, index));
      if (editing) {
        const token = document.createElement('span');
        token.className = 'emoji-token';
        token.dataset.unicodeEmoji = segment;
        token.contentEditable = 'false';
        const unicode = document.createElement('span');
        unicode.className = 'emoji-reference';
        unicode.textContent = segment;
        token.append(unicode, image);
        fragment.append(token);
      } else {
        fragment.append(image);
      }
      start = index + segment.length;
    }
    fragment.append(text.slice(start));
  }
  let start = 0;
  if (aliases.size) {
    for (const match of value.matchAll(/:([a-z0-9_]{2,32}):/gi)) {
      const emoji = aliases.get(match[1].toLowerCase());
      if (!emoji) continue;
      appendUnicode(value.slice(start, match.index));
      fragment.append(customEmoji(emoji.ref, false, emoji.name));
      start = match.index + match[0].length;
    }
  }
  appendUnicode(value.slice(start));
  return fragment;
}

function insertMarkup(node) {
  const content = document.createElement('div');
  content.append(node);
  document.execCommand('insertHTML', false, content.innerHTML);
}

export function insertEmojiClipboard(event, draft, render) {
  const encoded = event.clipboardData.getData(clipboardType);
  if (!encoded || encoded.length > 200_000) return false;
  let nodes;
  try { nodes = JSON.parse(encoded); } catch { return false; }
  let count = 0;
  function valid(node, depth) {
    if (++count > 1000 || depth > 18) return false;
    if (typeof node === 'string') return true;
    if (!node || typeof node.tag !== 'string') return false;
    if (node.tag === 'emoji') return typeof node.ref === 'string' && reference.test(node.ref);
    return Array.isArray(node.children) && node.children.every(child => valid(child, depth + 1));
  }
  if (!Array.isArray(nodes) || !nodes.every(node => valid(node, 0))) return false;
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes.map(render), '\u200b');
  insertMarkup(fragment);
  watchMissing(draft);
  return true;
}

// insertHTML creates fresh DOM elements and discards listeners from the source nodes.
function watchMissing(draft) {
  for (const image of draft.querySelectorAll('[data-emoji] img, [data-unicode-emoji] img')) {
    const missing = () => {
      const token = image.parentElement;
      token?.classList.add(token.hasAttribute('data-unicode-emoji') ? 'emoji-native' : 'emoji-missing');
      image.remove();
    };
    if (image.complete && !image.naturalWidth) missing();
    else image.addEventListener('error', missing, { once: true });
  }
}

export function copyEmojiSelection(event, serialize) {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return;
  const clone = document.createElement('div');
  clone.append(selection.getRangeAt(0).cloneContents());
  if (!clone.querySelector('[data-emoji], img.inline-emoji')) return;
  const items = [];
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      items.push(node.data.replace(/\u200b/g, ''));
    } else if (node instanceof HTMLElement) {
      if (reference.test(node.dataset.emoji)) items.push({ ref: node.dataset.emoji });
      else if (node.dataset.unicodeEmoji) items.push(node.dataset.unicodeEmoji);
      else if (node.classList.contains('inline-emoji')) items.push(node.getAttribute('alt') || '');
      else {
        for (const child of node.childNodes) visit(child);
        if (node.matches('br, p, div, li, h2, h3, blockquote, tr')) items.push('\n');
      }
    }
  }
  for (const child of clone.childNodes) visit(child);
  event.clipboardData.setData(clipboardType, JSON.stringify([...clone.childNodes].flatMap(serialize)));
  event.clipboardData.setData('text/plain', items.map(item => typeof item === 'string' ? item : item.ref).join(''));
  event.preventDefault();
  if (event.type === 'cut') document.execCommand('delete');
}

export function bindEmojiSuggestions(draft, menu, customCatalog) {
  let lastToken;
  let dismissed;
  let index = 0;
  let results = [];

  function currentToken() {
    const selection = getSelection();
    const node = selection.anchorNode;
    if (document.activeElement !== draft || draft.hidden || !selection.isCollapsed ||
        node?.nodeType !== Node.TEXT_NODE || !draft.contains(node) ||
        node.parentElement.closest('a, code, pre, [contenteditable="false"]')) return null;
    const offset = selection.anchorOffset;
    const before = node.data.slice(0, offset);
    const match = /(?:^|[\s([{])(:([a-z0-9_+-]{1,96}):?)$/i.exec(before);
    if (!match) return null;
    const start = offset - match[1].length;
    const boundary = document.createRange();
    const block = node.parentElement.closest('p, div, li, blockquote, td, th, h2, h3') || draft;
    boundary.setStart(block, 0);
    boundary.setEnd(node, start);
    const prefix = boundary.toString().replace(/\u200b/g, '');
    if (prefix && !/[\s([{]$/.test(prefix) || /(?:\w+:\/\/|www\.)\S*$/i.test(prefix + match[1])) return null;
    const tail = /^[a-z0-9_+-]*:?/i.exec(node.data.slice(offset))[0];
    return { node, start, end: offset + (match[1].endsWith(':') ? 0 : tail.length), offset, query: match[2].toLowerCase() };
  }

  const same = (first, second) => first && second && first.node === second.node &&
    first.start === second.start && first.end === second.end && first.offset === second.offset && first.query === second.query;

  function hide() {
    menu.hidden = true;
    draft.removeAttribute('aria-activedescendant');
  }

  function accept(item) {
    const token = currentToken();
    if (!same(token, lastToken)) return hide();
    const range = document.createRange();
    range.setStart(token.node, token.start);
    range.setEnd(token.node, token.end);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const fragment = document.createDocumentFragment();
    fragment.append(item.unicode ? emojiText(item.unicode, [], true) : customEmoji(item.ref, true, item.name), '\u200b');
    insertMarkup(fragment);
    watchMissing(draft);
    hide();
  }

  function select(next) {
    index = (next + results.length) % results.length;
    [...menu.children].forEach((option, position) => option.setAttribute('aria-selected', position === index));
    draft.setAttribute('aria-activedescendant', menu.children[index].id);
  }

  function update(force = false) {
    const token = currentToken();
    if (!token || same(token, dismissed)) return hide();
    if (!force && !menu.hidden && same(token, lastToken)) return;
    dismissed = null;
    lastToken = token;
    const ranked = [new Map(), new Map(), new Map()];
    for (const catalog of [customCatalog(), builtin]) for (const item of catalog) {
      const rank = item.name === token.query ? 0 : item.name.startsWith(token.query) ? 1 : 2;
      if (rank === 2 && !item.name.includes(token.query)) continue;
      const identity = item.identity || item.ref;
      if (!ranked[rank].has(identity)) ranked[rank].set(identity, item);
    }
    results = [];
    const seen = new Set();
    for (const matches of ranked) {
      for (const [identity, item] of matches) {
        if (seen.has(identity)) continue;
        seen.add(identity);
        results.push(item);
        if (results.length === 7) break;
      }
      if (results.length === 7) break;
    }
    if (!results.length) return hide();
    menu.replaceChildren(...results.map((item, position) => {
      const option = document.createElement('div');
      option.id = 'emoji-suggestion-' + position;
      option.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.textContent = ':' + item.name + ':';
      option.append(item.unicode ? emojiText(item.unicode) : customEmoji(item.ref, false, item.name), name);
      if (item.server) {
        const server = document.createElement('small');
        server.textContent = item.server;
        option.append(server);
      }
      option.onpointerdown = event => event.preventDefault();
      option.onclick = () => accept(item);
      return option;
    }));
    menu.hidden = false;
    select(0);
  }

  draft.addEventListener('input', event => { if (!event.isComposing) update(); });
  draft.addEventListener('compositionend', () => update());
  draft.addEventListener('blur', hide);
  document.addEventListener('selectionchange', () => update());
  draft.addEventListener('keydown', event => {
    if (menu.hidden || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const actions = {
      ArrowDown: () => select(index + 1),
      ArrowUp: () => select(index - 1),
      Enter: () => accept(results[index]),
      Tab: () => accept(results[index]),
      Escape: () => { dismissed = lastToken; hide(); },
    };
    if (!Object.hasOwn(actions, event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    actions[event.key]();
  }, true);
  return { hide, refresh: () => update(true) };
}
