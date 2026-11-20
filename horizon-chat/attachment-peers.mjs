import { randomUUID } from 'node:crypto';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const leaseMs = 15_000;
const heartbeatMs = 55_000;
const keyFor = ({ conversation, message, offset }) => `${conversation}/${message}/${offset}`;
const validChunk = value => value && [value.conversation, value.message, value.offset].every(Number.isSafeInteger) &&
  value.conversation > 0 && value.message > 0 && value.offset >= 0 && value.offset < 10 * 1024 * 1024;

export function createAttachmentPeers({ authorize, describe, emit, clock = Date.now }) {
  const peers = new Map();
  const transfers = new Map();
  const reject = (status = 404) => ({ status, data: { error: 'Peer transfer unavailable.' } });
  const ok = data => ({ status: 200, data });
  function unregister(id) {
    peers.delete(id);
    for (const [key, transfer] of transfers) {
      if (transfer.source.id === id || transfer.target.id === id) transfers.delete(key);
    }
  }
  function validPeer(id, account, token) {
    const peer = peers.get(id);
    return peer?.account === account && peer.token === token ? peer : null;
  }
  return function handle(path, input, account, token) {
    const now = clock();
    for (const [id, value] of peers) if (value.expires <= now) unregister(id);
    for (const [id, value] of transfers) if (value.expires <= now) transfers.delete(id);
    if (!input || typeof input.peer !== 'string' || !uuid.test(input.peer)) return reject(400);
    const peer = validPeer(input.peer, account, token);
    if (path === 'hello') {
      if (peer) peer.expires = now + heartbeatMs;
      else {
        if (peers.has(input.peer) || peers.size >= 48 ||
            [...peers.values()].filter(item => item.account === account).length >= 4) return reject(429);
        peers.set(input.peer, { id: input.peer, account, token, expires: now + heartbeatMs, chunks: new Set(), budget: 0, window: now });
      }
      return ok({ registered: true });
    }
    if (!peer) return reject();
    if (path === 'leave') { unregister(peer.id); return ok({ left: true }); }
    if (now - peer.window >= 1000) { peer.window = now; peer.budget = 0; }
    if (++peer.budget > 28) return reject(429);
    if (path === 'advertise' || path === 'discover') {
      if (!validChunk(input) || !authorize(peer, input)) return reject();
      const chunk = { conversation: input.conversation, message: input.message, offset: input.offset };
      const key = keyFor(chunk);
      if (path === 'advertise') {
        if (peer.chunks.size >= 256) peer.chunks.delete(peer.chunks.values().next().value);
        peer.chunks.add(key);
        return ok({ advertised: true });
      }
      const source = [...peers.values()].find(item => item.id !== peer.id && item.chunks.has(key) && authorize(item, chunk) &&
        ![...transfers.values()].some(transfer => transfer.source === item && !transfer.stored));
      if (!source || transfers.size >= 96 || [...transfers.values()].filter(item => item.target === peer).length >= 3) return ok({ ticket: null });
      const descriptor = describe(chunk);
      if (!descriptor) return ok({ ticket: null });
      const ticket = randomUUID();
      transfers.set(ticket, { source, target: peer, chunk, descriptor, expires: now + leaseMs });
      return ok({ ticket, ...descriptor });
    }
    const matched = /^([a-f0-9-]{36})\/(offer|answer|state|seed|store|cancel)$/.exec(path);
    const transfer = matched && transfers.get(matched[1]);
    if (!transfer || (peer !== transfer.source && peer !== transfer.target) ||
        !authorize(transfer.source, transfer.chunk) || !authorize(transfer.target, transfer.chunk)) return reject();
    const [ticket, action] = matched.slice(1);
    const target = peer === transfer.target;
    if (action === 'cancel' && target) { transfers.delete(ticket); return ok({ cancelled: true }); }
    if (action === 'state') return ok(target ? { answer: transfer.answer ?? null } : { offer: transfer.offer ?? null });
    if (action === 'offer' || action === 'answer') {
      if ((action === 'offer') !== target || transfer[action] || typeof input.sdp !== 'string' ||
          input.sdp.length > 24_000 || /\btyp relay\b/.test(input.sdp) || !input.sdp.startsWith('v=0')) return reject(400);
      transfer[action] = input.sdp;
      emit(target ? transfer.source : transfer.target, ticket);
      return ok({ accepted: true });
    }
    if (!transfer.answer || (action === 'seed') === target || (action === 'seed' ? transfer.seeded : !transfer.seeded || transfer.stored)) return reject();
    const current = describe(transfer.chunk);
    if (!current || current.hash !== transfer.descriptor.hash || current.size !== transfer.descriptor.size) return reject();
    transfer[action === 'seed' ? 'seeded' : 'stored'] = true;
    return ok({ ...current, route: `conversations/${transfer.chunk.conversation}/messages/${transfer.chunk.message}/document?offset=${transfer.chunk.offset}&encoding=gzip` });
  };
}
