import { bindEmojiSuggestions, copyEmojiSelection, customEmoji, emojiText, insertEmojiClipboard } from './emojis.js?v=emoji-display';
import { languages } from './language-catalog.js';

const tags = new Set(['p', 'div', 'br', 'strong', 'em', 'u', 's', 'sup', 'sub', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'span', 'h2', 'h3', 'table', 'tbody', 'tr', 'td', 'th']);
const aliases = { b: 'strong', i: 'em', strike: 's', font: 'span' };
const fonts = new Set(['Open Sans', 'Noto Serif', 'Liberation Mono', 'DejaVu Sans', 'Milonga', 'Play', 'Shippori Mincho B1', 'Noto Sans']);
const $ = id => document.getElementById(id);
const syntaxIds = new Set(languages.map(([id]) => id));
const grammars = new Map();

export function highlight(contents, language) {
  const highlighter = window.hljs;
  const id = language === 'html' ? 'xml' : language;
  if (!highlighter || id === 'plaintext' || !syntaxIds.has(id)) return;
  function apply() {
    if (!highlighter.getLanguage(id)) return;
    contents.className = 'language-' + id;
    highlighter.highlightElement(contents);
  }
  if (highlighter.getLanguage(id)) {
    apply();
    return;
  }
  if (!grammars.has(id)) {
    const script = document.createElement('script');
    script.src = './syntax/' + id + '.min.js';
    grammars.set(id, new Promise(resolve => {
      script.onload = resolve;
      script.onerror = () => {
        grammars.delete(id);
        script.remove();
        resolve();
      };
    }));
    document.head.append(script);
  }
  void grammars.get(id).then(apply);
}

const draftEmojiText = value => emojiText(value, [], true);

function serialize(node, copying = false) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\u200b/g, '');
    return text ? [text] : [];
  }
  if (!(node instanceof HTMLElement)) return [];
  if (node.dataset.unicodeEmoji) return [node.dataset.unicodeEmoji];
  if (node.dataset.emoji) return [{ tag: 'emoji', ref: node.dataset.emoji }];
  if (node.hasAttribute('data-attachment')) return copying ? [] : [{ tag: 'attachment' }];
  if (copying && node.matches('img.inline-emoji')) return [node.alt];
  const tag = aliases[node.localName] || node.localName;
  const children = [...node.childNodes].flatMap(child => serialize(child, copying));
  if (!tags.has(tag)) return children;
  const value = { tag, children };
  if (['italic', 'normal'].includes(node.style.fontStyle)) value.italic = node.style.fontStyle;
  if (['bold', 'normal', '700', '400'].includes(node.style.fontWeight)) {
    value.weight = ['bold', '700'].includes(node.style.fontWeight) ? 'bold' : 'normal';
  }
  if (node.style.textAlign) value.align = node.style.textAlign;
  const font = (node.style.fontFamily || node.dataset.font || '').replace(/^["']|["']$/g, '');
  if (fonts.has(font)) value.font = font;
  const size = /^([0-9]+)px$/.exec(node.style.fontSize)?.[1] || node.dataset.size;
  if (size) value.size = Number(size);
  if (tag === 'a') value.href = node.href;
  return [value];
}

function renderNode(node, renderAttachment, textNode = value => document.createTextNode(value), editing = false) {
  if (node.tag === 'emoji') return customEmoji(node.ref, editing);
  if (node.tag === 'attachment') return renderAttachment?.() || document.createTextNode('');
  if (typeof node === 'string') return textNode(node);
  const element = document.createElement(tags.has(node.tag) ? node.tag : 'span');
  if (['left', 'center', 'right', 'justify'].includes(node.align)) element.style.textAlign = node.align;
  if (['italic', 'normal'].includes(node.italic)) element.style.fontStyle = node.italic;
  if (['bold', 'normal'].includes(node.weight)) element.style.fontWeight = node.weight;
  if (fonts.has(node.font)) {
    element.dataset.font = node.font;
    element.style.fontFamily = '"' + node.font + '"';
  }
  if (Number.isInteger(node.size) && node.size >= 10 && node.size <= 72) {
    element.dataset.size = String(node.size);
    element.style.fontSize = node.size + 'px';
  }
  if (node.tag === 'a' && typeof node.href === 'string') {
    const link = URL.canParse(node.href) ? new URL(node.href) : null;
    if (['https:', 'http:'].includes(link?.protocol)) {
      element.href = link.href;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    }
  }
  const childText = ['code', 'pre', 'a'].includes(node.tag) ? value => document.createTextNode(value) : textNode;
  element.append(...node.children.map(child => renderNode(child, renderAttachment, childText, editing)));
  return element;
}

export function createComposer(form, attachFile, customCatalog, renderMention = () => null) {
  const draft = $('draft');
  const suggestions = bindEmojiSuggestions(draft, $('emoji-suggestions'), customCatalog);
  const copy = event => copyEmojiSelection(event, node => serialize(node, true));
  document.addEventListener('copy', event => {
    const selection = getSelection();
    const anchor = selection.anchorNode;
    const origin = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (origin?.closest('#draft, #direct-messages')) copy(event);
  });
  draft.addEventListener('cut', copy);
  const code = $('code-draft');
  const language = $('code-language');
  const popular = new Set([...language.options].map(option => option.value));
  const additional = document.createElement('optgroup');
  additional.label = 'More languages';
  additional.append(...languages.filter(([id]) => !popular.has(id)).map(([id, label]) => new Option(label, id)));
  language.append(additional);
  const panel = $('format-panel');
  const toggle = $('format-toggle');
  const familyPicker = $('font-family-select');
  const sizePicker = $('font-size-select');
  const toolButtons = [...panel.querySelectorAll('[data-format]')];
  const alignmentTools = ['left', 'center', 'right'];
  const blockTags = { quote: 'blockquote', code: 'pre', inline: 'code', link: 'a' };
  sizePicker.options[0].textContent = 'Mixed';
  let range = null;
  let file = null;
  let attachmentAlign = 'left';
  let attachmentSelected = false;
  let previewUrl;
  const preview = $('attachment-preview');

  function attachmentPreview() {
    const element = document.createElement('span');
    element.className = 'draft-attachment';
    element.dataset.attachment = '';
    element.contentEditable = 'false';
    element.dataset.align = attachmentAlign;
    element.toggleAttribute('data-selected', attachmentSelected);
    element.tabIndex = 0;
    element.setAttribute('aria-label', file.name);
    element.title = 'Select attachment. Press Delete to remove it.';
    if (previewUrl && /\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
      const image = document.createElement('img');
      image.src = previewUrl;
      image.alt = '';
      image.draggable = false;
      image.onerror = () => {
        image.remove();
        element.dataset.filename = file?.name || '';
      };
      element.append(image);
    } else {
      element.dataset.filename = file.name;
    }
    function select() {
      attachmentSelected = true;
      element.setAttribute('data-selected', '');
      refreshActiveTools();
    }
    element.onfocus = select;
    element.onclick = () => {
      element.focus();
      select();
    };
    element.onkeydown = event => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        draft.querySelector('[data-attachment]')?.remove();
        setFile(null);
        focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        form.requestSubmit();
      } else if (event.key === 'Escape') {
        deselectAttachment();
        focus();
      }
    };
    return element;
  }

  function refreshAttachment() {
    const inline = draft.querySelector('[data-attachment]');
    preview.hidden = !file || (!language.value && Boolean(inline));
    preview.replaceChildren(...(preview.hidden ? [] : [attachmentPreview()]));
  }

  function deselectAttachment() {
    attachmentSelected = false;
    form.querySelector('[data-attachment][data-selected]')?.removeAttribute('data-selected');
    refreshActiveTools();
  }

  function setFile(next, align = 'left') {
    deselectAttachment();
    attachmentAlign = align;
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    file = next;
    previewUrl = file instanceof File ? URL.createObjectURL(file) : file?.preview;
    refreshAttachment();
  }

  function focus() {
    (language.value ? code : draft).focus();
  }

  function selectedText(selectionRange) {
    const walker = document.createTreeWalker(draft, NodeFilter.SHOW_TEXT);
    const selected = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!selectionRange.intersectsNode(node)) continue;
      const start = node === selectionRange.startContainer ? selectionRange.startOffset : 0;
      const end = node === selectionRange.endContainer ? selectionRange.endOffset : node.length;
      if (start < end) selected.push({ node, start, end });
    }
    return selected;
  }

  function refreshFontTools() {
    const selected = range && !range.collapsed ? selectedText(range).map(part => part.node.parentElement) : [];
    const start = range?.startContainer;
    const cursor = start instanceof HTMLElement ? start : start?.parentElement;
    const styles = (selected.length ? selected : [cursor || draft]).map(node => getComputedStyle(node));
    const sizes = new Set(styles.map(style => parseFloat(style.fontSize)));
    const families = new Set(styles.map(style => style.fontFamily.replace(/^["']|["']$/g, '')));
    const [size] = sizes;
    const [family] = families;
    const custom = sizePicker.querySelector('[data-current-size]');
    custom?.remove();
    if (sizes.size === 1 && Number.isFinite(size) && ![...sizePicker.options].some(option => Number(option.value) === size)) {
      const option = new Option(size + ' px', String(size));
      option.dataset.currentSize = 'true';
      sizePicker.append(option);
    }
    sizePicker.value = sizes.size === 1 ? String(size) : '';
    familyPicker.value = families.size === 1 && fonts.has(family) ? family : '';
  }

  function resize() {
    code.style.height = 'auto';
    code.style.height = code.scrollHeight + 2 + 'px';
  }
  function mode() {
    const isCode = Boolean(language.value);
    draft.hidden = isCode;
    code.hidden = !isCode;
    panel.querySelectorAll('[data-format], .format-fonts select').forEach(control => { control.disabled = isCode; });
    resize();
    refreshAttachment();
  }
  function selectedElement(tag) {
    if (!range) return null;
    const elementAt = node => (node instanceof Element ? node : node.parentElement)?.closest(tag);
    const start = elementAt(range.startContainer);
    return start && draft.contains(start) && start === elementAt(range.endContainer) ? start : null;
  }

  function refreshActiveTools() {
    for (const button of toolButtons) {
      const tool = button.dataset.format;
      let active = false;
      if (attachmentSelected) active = tool === attachmentAlign;
      else if (!language.value && range) {
        active = blockTags[tool] ? Boolean(selectedElement(blockTags[tool]))
          : Boolean(commands[tool] && document.queryCommandState(commands[tool]));
      }
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function remember() {
    const selection = getSelection();
    if (selection.rangeCount && draft.contains(selection.anchorNode) && draft.contains(selection.focusNode)) {
      range = selection.getRangeAt(0).cloneRange();
      refreshFontTools();
      refreshActiveTools();
    }
  }
  function restoreRange() {
    draft.focus();
    if (!range || !draft.contains(range.commonAncestorContainer)) return;
    const selection = getSelection();
    const current = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (current && current.startContainer === range.startContainer && current.startOffset === range.startOffset &&
        current.endContainer === range.endContainer && current.endOffset === range.endOffset) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function text() {
    const inline = draft.querySelector('[data-attachment]');
    if (inline) inline.style.display = 'none';
    const value = draft.innerText.replace(/\u200b/g, '');
    if (inline) inline.style.removeProperty('display');
    return value;
  }
  function snapshot() {
    return { nodes: [...draft.childNodes].flatMap(node => serialize(node)), body: text(), code: code.value, language: language.value, file, attachmentAlign };
  }
  function restore(value) {
    suggestions.hide();
    setFile(value?.file || null, value?.attachmentAlign);
    draft.replaceChildren(...(value?.nodes || []).map(node => renderNode(node, file && attachmentPreview, draftEmojiText, true)));
    code.value = value?.code || '';
    language.value = value?.language || '';
    range = null;
    mode();
    refreshFontTools();
    refreshActiveTools();
  }
  toggle.onclick = () => {
    remember();
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    $('format-tray').toggleAttribute('data-open', open);
    panel.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  language.onchange = () => {
    if (language.value && code.hidden) code.value = text();
    if (!language.value && !code.hidden && code.value !== text()) draft.textContent = code.value;
    mode();
    (language.value ? code : draft).focus();
    refreshActiveTools();
  };
  form.addEventListener('pointerdown', event => {
    if (!event.target.closest('[data-attachment]')) deselectAttachment();
  });
  draft.addEventListener('focus', deselectAttachment);
  code.addEventListener('focus', deselectAttachment);
  draft.addEventListener('input', deselectAttachment);
  code.addEventListener('input', deselectAttachment);
  draft.addEventListener('keyup', remember);
  draft.addEventListener('mouseup', remember);
  draft.addEventListener('input', () => {
    if (file && preview.hidden && !draft.querySelector('[data-attachment]')) setFile(null);
    remember();
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === draft) remember();
  });
  panel.addEventListener('pointerdown', remember);
  panel.addEventListener('mousedown', event => {
    if (event.target.closest('[data-format]')) event.preventDefault();
  });
  const commands = {
    bold: 'bold', italic: 'italic', strike: 'strikeThrough', underline: 'underline',
    superscript: 'superscript', subscript: 'subscript', list: 'insertUnorderedList',
    ordered: 'insertOrderedList', left: 'justifyLeft', center: 'justifyCenter',
    right: 'justifyRight', justify: 'justifyFull',
  };
  panel.addEventListener('click', event => {
    const tool = event.target.closest('[data-format]')?.dataset.format;
    if (!tool) return;
    if (attachmentSelected && alignmentTools.includes(tool)) {
      attachmentAlign = tool;
      form.querySelectorAll('[data-attachment]').forEach(element => { element.dataset.align = tool; });
      refreshActiveTools();
      return;
    }
    if (language.value) return;
    deselectAttachment();
    restoreRange();
    if (commands[tool]) document.execCommand(commands[tool]);
    else if (tool === 'quote' || tool === 'code') {
      const tag = blockTags[tool];
      document.execCommand('formatBlock', false, selectedElement(tag) ? 'div' : tag);
    }
    else if (tool === 'link') {
      if (selectedElement('a')) {
        document.execCommand('unlink');
        remember();
        return;
      }
      const url = prompt('Link address');
      const link = url && URL.canParse(url) ? new URL(url) : null;
      if (['https:', 'http:'].includes(link?.protocol)) document.execCommand('createLink', false, link.href);
    } else if (tool === 'inline') {
      const selection = getSelection();
      const inline = selectedElement('code');
      if (inline) {
        const nodes = [...inline.childNodes];
        inline.replaceWith(...nodes);
        if (nodes.length) {
          const next = document.createRange();
          next.setStartBefore(nodes[0]);
          next.setEndAfter(nodes.at(-1));
          selection.removeAllRanges();
          selection.addRange(next);
        }
      } else if (selection.rangeCount && !selection.isCollapsed) {
        const element = document.createElement('code');
        element.textContent = selection.toString();
        document.execCommand('insertHTML', false, element.outerHTML);
      }
    }
    remember();
  });
  for (const [picker, kind] of [[familyPicker, 'font'], [sizePicker, 'size']]) {
    picker.onchange = () => {
      const value = picker.value;
      if (!value) return;
      restoreRange();
      const selection = getSelection();
      if (!selection.rangeCount || !draft.contains(selection.anchorNode)) return;
      const current = selection.getRangeAt(0);
      function styledSpan() {
        const element = document.createElement('span');
        element.dataset[kind] = value;
        if (kind === 'font') element.style.fontFamily = '"' + value + '"';
        else element.style.fontSize = value + 'px';
        return element;
      }
      const result = document.createRange();
      if (current.collapsed) {
        const span = styledSpan();
        const cursor = document.createTextNode('\u200b');
        span.append(cursor);
        current.insertNode(span);
        result.setStart(cursor, 1);
        result.collapse(true);
      } else {
        const segments = selectedText(current);
        if (!segments.length) return;
        const wrappers = segments.map(({ node, start, end }) => {
          if (end < node.length) node.splitText(end);
          const chosen = start ? node.splitText(start) : node;
          const span = styledSpan();
          chosen.before(span);
          span.append(chosen);
          return span;
        });
        result.setStart(wrappers[0].firstChild, 0);
        const last = wrappers.at(-1).firstChild;
        result.setEnd(last, last.length);
      }
      selection.removeAllRanges();
      selection.addRange(result);
      remember();
    };
  }
  function pasteImage(event) {
    const file = [...event.clipboardData.files].find(item => /^image\/(png|jpeg|webp|gif)$/i.test(item.type));
    if (!file) return false;
    event.preventDefault();
    remember();
    const extension = file.type.split('/')[1].toLowerCase();
    attachFile(new File([file], 'pasted-image.' + extension, { type: file.type }));
    return true;
  }
  draft.onpaste = event => {
    if (pasteImage(event)) return;
    event.preventDefault();
    if (!insertEmojiClipboard(event, draft, node => renderNode(node, undefined, draftEmojiText, true))) document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  };
  code.onpaste = event => { pasteImage(event); };
  draft.ondrop = event => event.preventDefault();
  code.oninput = resize;
  for (const field of [draft, code]) {
    field.onkeydown = event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (field === draft) {
          event.preventDefault();
          document.execCommand('insertParagraph');
        } else {
          event.preventDefault();
          if (code.value.length - (code.selectionEnd - code.selectionStart) < code.maxLength) {
            code.setRangeText('\n', code.selectionStart, code.selectionEnd, 'end');
            resize();
          }
        }
        return;
      }
      event.preventDefault();
      form.requestSubmit();
    };
  }
  return {
    snapshot, restore, refreshEmojis: suggestions.refresh,
    restoreMessage(message, thumbnailUrl) {
      const stored = JSON.parse(message.format);
      const attachment = stored?.kind === 'document' ? stored : null;
      const format = attachment ? attachment.caption : stored;
      const isCode = format?.kind === 'code';
      restore({
        nodes: format?.kind === 'rich' ? format.nodes : isCode ? [] : [message.body],
        code: isCode ? message.body : '',
        language: isCode ? format.language : '',
        file: attachment && {
          name: attachment.name,
          preview: attachment.thumbnail
            ? thumbnailUrl + (attachment.thumbnailRevision ? '?v=' + attachment.thumbnailRevision : '')
            : undefined,
        },
        attachmentAlign: attachment?.align,
      });
    },
    focus, remember,
    attach(next) {
      draft.querySelector('[data-attachment]')?.remove();
      setFile(next);
      if (language.value || !text().trim()) {
        focus();
        return;
      }
      restoreRange();
      const selection = getSelection();
      const insertion = range && draft.contains(range.commonAncestorContainer)
        ? range.cloneRange() : document.createRange();
      if (!range || !draft.contains(range.commonAncestorContainer)) insertion.selectNodeContents(draft);
      insertion.collapse(false);
      const cursor = document.createTextNode('\u200b');
      const fragment = document.createDocumentFragment();
      fragment.append(attachmentPreview(), cursor);
      insertion.insertNode(fragment);
      insertion.setStart(cursor, 1);
      insertion.collapse(true);
      selection.removeAllRanges();
      selection.addRange(insertion);
      remember();
      refreshAttachment();
    },
    message() {
      return language.value
        ? { body: code.value, format: { kind: 'code', language: language.value } }
        : { body: text(), format: { kind: 'rich', nodes: snapshot().nodes } };
    },
    insertCode(value, selectedLanguage) {
      language.value = [...language.options].some(option => option.value === selectedLanguage) ? selectedLanguage : 'plaintext';
      code.value = value;
      mode();
      code.focus();
    },
    render(message, renderDocument, legacyEmojis = []) {
      const body = document.createElement('div');
      body.className = 'msgbody';
      let format;
      try { format = message.format && JSON.parse(message.format); } catch { /* Display stored plain text. */ }
      function renderAlignedDocument(file) {
        const card = renderDocument(file);
        if (['center', 'right'].includes(file.align)) card.dataset.align = file.align;
        return card;
      }
      const legacy = format?.emojiVersion ? [] : legacyEmojis;
      const renderEmojiMentions = value => {
        const fragment = document.createDocumentFragment(); let start = 0;
        for (const match of value.matchAll(/\$(?:\{[^}\n]{1,140}\}|[\p{L}\p{N}_-]+(?:#[a-z0-9]{4})?)/giu)) {
          if (match.index && /[\p{L}\p{N}_]/u.test(value[match.index - 1])) continue;
          fragment.append(emojiText(value.slice(start,match.index),legacy));
          const mention = renderMention(match[0]) || document.createElement('span'); if (!mention.className) { mention.className = 'message-mention'; mention.textContent = match[0]; } fragment.append(mention); start = match.index + match[0].length;
        }
        fragment.append(emojiText(value.slice(start),legacy)); return fragment;
      };
      const renderText = value => {
        const fragment = document.createDocumentFragment();
        const pattern = /https?:\/\/[^\s<>"\u0000-\u001f]+/gi;
        let start = 0;
        for (const match of value.matchAll(pattern)) {
          const text = match[0].replace(/[.,!?;:]+$/, '').replace(/\)+$/, tail => {
            const opens = (match[0].match(/\(/g) || []).length;
            return tail.slice(0, Math.max(0, opens - (match[0].match(/\)/g) || []).length + tail.length));
          });
          let url; try { url = new URL(text); } catch { continue; }
          if (url.username || url.password) continue;
          fragment.append(renderEmojiMentions(value.slice(start, match.index)));
          const link = document.createElement('a'); link.href = url.href; link.textContent = text;
          link.target = '_blank'; link.rel = 'noopener noreferrer'; fragment.append(link);
          start = match.index + text.length;
        }
        fragment.append(renderEmojiMentions(value.slice(start)));
        return fragment;
      };
      function embeds() {
        const urls = [...new Set([...body.querySelectorAll('a[href]')].filter(link => !link.closest('pre,code')).map(link => link.href))].slice(0, 3);
        for (const href of urls) {
          const url = new URL(href);
          let media;
          if (/\.(gif|png|jpe?g|webp|avif)$/i.test(url.pathname)) {
            media = document.createElement('img'); media.loading = 'lazy'; media.alt = 'Linked image'; media.referrerPolicy = 'no-referrer'; media.src = href;
          } else if (/\.(mp4|webm|ogg)$/i.test(url.pathname)) {
            media = document.createElement('video'); media.controls = true; media.preload = 'none'; media.src = href;
          } else {
            let source;
            if (['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname)) {
              const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || /^\/(?:shorts|embed)\/([^/]+)/.exec(url.pathname)?.[1];
              if (/^[\w-]{11}$/.test(id || '')) source = 'https://www.youtube-nocookie.com/embed/' + id;
            } else if (['giphy.com','www.giphy.com'].includes(url.hostname)) {
              const id = /\/(?:gifs|embed)\/(?:.*-)?([A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
              if (id) source = 'https://giphy.com/embed/' + id;
            } else if (['tenor.com','www.tenor.com'].includes(url.hostname)) {
              const id = /(?:-|\/)(\d+)$/.exec(url.pathname)?.[1];
              if (id) source = 'https://tenor.com/embed/' + id;
            }
            if (source) { media = document.createElement('iframe'); media.loading = 'lazy'; media.src = source; media.title = 'Embedded media from ' + url.hostname; media.referrerPolicy = 'strict-origin-when-cross-origin'; media.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation'); media.allowFullscreen = true; media.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen'; }
          }
          if (!media) continue;
          const preview = document.createElement('details'); preview.className = 'link-preview'; preview.open = document.documentElement.dataset[/^(?:www\.|m\.)?youtube\.com$|^youtu\.be$/.test(url.hostname)?'youtubeView':'linkedMediaView'] !== 'compact';
          preview.dataset.previewKind=/^(?:www\.|m\.)?youtube\.com$|^youtu\.be$/.test(url.hostname)?'youtube':'linked';
          const source=media.getAttribute('src');media.removeAttribute('src');const load=()=>{if(preview.open&&!media.hasAttribute('src'))media.src=source;};preview.addEventListener('toggle',load);load();
          const summary = document.createElement('summary'); summary.textContent = 'Preview · ' + url.hostname;
          media.addEventListener('error', () => preview.remove(), { once: true });
          preview.append(summary, media); body.append(preview);
        }
      }
      if (format?.kind === 'document' && !format.caption) return renderAlignedDocument(format);
      const attachment = format?.kind === 'document' ? format : null;
      if (attachment) format = attachment.caption;
      if (format?.kind === 'rich') {
        body.classList.add('rich-body');
        let placed = false;
        function insertAttachment() {
          if (!attachment || placed) return document.createTextNode('');
          placed = true;
          return renderAlignedDocument(attachment);
        }
        body.append(...format.nodes.map(node => renderNode(node, insertAttachment, renderText)));
        if (attachment && !placed) body.prepend(renderAlignedDocument(attachment));
        if (!attachment && !body.textContent.trim() && !body.querySelector('.inline-emoji') && message.body.trim()) body.append(renderText(message.body));
        embeds();
        return body;
      }
      if (format?.kind !== 'code') {
        body.classList.add('plain-message');
        if (attachment) body.append(renderAlignedDocument(attachment));
        if (message.body) body.append(renderText(message.body));
        embeds();
        return body;
      }
      const block = document.createElement('div');
      block.className = 'code-wrap';
      const head = document.createElement('div');
      head.className = 'code-head';
      const label = document.createElement('span');
      label.textContent = [...language.options].find(option => option.value === format.language)?.textContent || format.language;
      const copy = document.createElement('button');
      copy.className = 'copy-code';
      copy.textContent = 'Copy';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(message.body);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
      };
      head.append(label, copy);
      const pre = document.createElement('pre');
      if (message.body.split('\n').length > 8) {
        pre.className = 'code-lines-limited';
        pre.tabIndex = 0;
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'copy-code';
        expand.textContent = 'View all';
        expand.onclick = () => {
          const limited = pre.classList.toggle('code-lines-limited');
          pre.classList.toggle('code-expanded-inline', !limited);
          expand.textContent = limited ? 'View all' : 'Collapse';
        };
        head.append(expand);
      }
      const contents = document.createElement('code');
      contents.textContent = message.body;
      highlight(contents, format.language);
      pre.append(contents);
      block.append(head, pre);
      if (attachment) body.append(renderAlignedDocument(attachment));
      body.append(block);
      return body;
    },
  };
}
