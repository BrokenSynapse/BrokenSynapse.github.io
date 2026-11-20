import { emojiReference } from './emojis.mjs';

const tags = new Set(['p', 'div', 'br', 'strong', 'em', 'u', 's', 'sup', 'sub', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'span', 'h2', 'h3', 'table', 'tbody', 'tr', 'td', 'th']);
const fonts = new Set(['Open Sans', 'Noto Serif', 'Liberation Mono', 'DejaVu Sans', 'Milonga', 'Play', 'Shippori Mincho B1', 'Noto Sans']);
const alignments = new Set(['left', 'center', 'right', 'justify']);
export const documentThreshold = 4000;
export const messageLimit = 100_000;

export function messageFormat(input, allowAttachment = false) {
  if (input.format == null) return null;
  const format = input.format;
  if (format.kind === 'code' && typeof format.language === 'string' && /^[a-z0-9-]{1,24}$/.test(format.language)) {
    return { kind: 'code', language: format.language };
  }
  if (format.kind !== 'rich' || !Array.isArray(format.nodes)) throw new Error('Invalid message formatting.');
  let count = 0;
  let hasAttachment = false;
  let length = 0;
  function clean(node, depth) {
    if (++count > 1000 || depth > 18) throw new Error('This message has too much formatting.');
    if (typeof node === 'string') {
      length += node.length;
      if (length > messageLimit) throw new Error('Enter a message of up to 100,000 characters.');
      return node;
    }
    if (node?.tag === 'emoji' && typeof node.ref === 'string' && emojiReference.test(node.ref)) {
      length += node.ref.length;
      if (length > messageLimit) throw new Error('Enter a message of up to 100,000 characters.');
      return { tag: 'emoji', ref: node.ref };
    }
    if (allowAttachment && !hasAttachment && node?.tag === 'attachment') {
      hasAttachment = true;
      return { tag: 'attachment' };
    }
    if (!node || !tags.has(node.tag) || !Array.isArray(node.children)) throw new Error('Invalid message formatting.');
    const result = { tag: node.tag, children: node.children.map(child => clean(child, depth + 1)) };
    if (['italic', 'normal'].includes(node.italic)) result.italic = node.italic;
    if (['bold', 'normal'].includes(node.weight)) result.weight = node.weight;
    if (alignments.has(node.align)) result.align = node.align;
    if (fonts.has(node.font)) result.font = node.font;
    if (Number.isInteger(node.size) && node.size >= 10 && node.size <= 72) result.size = node.size;
    if (node.tag === 'a' && typeof node.href === 'string' && node.href.length <= 2048) {
      const link = URL.parse(node.href);
      if (['http:', 'https:'].includes(link?.protocol)) result.href = link.href;
    }
    return result;
  }
  return { kind: 'rich', nodes: format.nodes.map(node => clean(node, 0)) };
}

export function trimRichFormat(format, start, end) {
  const leaves = [];
  function gather(nodes) {
    nodes.forEach((node, index) => {
      if (typeof node === 'string') leaves.push({ nodes, index });
      else if (node.tag === 'emoji') leaves.push({ nodes, index, emoji: true });
      else if (node.tag === 'br') leaves.push({ nodes, index, break: true });
      else if (node.tag !== 'attachment') gather(node.children);
    });
  }
  gather(format.nodes);
  function trim(sequence, count, fromEnd) {
    for (const leaf of sequence) {
      if (!count) break;
      if (leaf.emoji) {
        count -= leaf.nodes[leaf.index]?.ref?.length || 0;
        leaf.nodes[leaf.index] = '';
        if (count < 0) break;
        continue;
      }
      if (leaf.break) {
        leaf.nodes[leaf.index] = '';
        count--;
        continue;
      }
      const value = leaf.nodes[leaf.index];
      const removed = Math.min(value?.length || 0, count);
      leaf.nodes[leaf.index] = fromEnd ? value.slice(0, value.length - removed) : value.slice(removed);
      count -= removed;
    }
  }
  trim(leaves, start, false);
  trim(leaves.reverse(), end, true);
}
