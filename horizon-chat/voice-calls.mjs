import { randomUUID } from 'node:crypto';

const leaseMs = 45_000;
const maxRoom = 6;

export function createVoiceCalls({ authorized, directRecipient, ring, wake = () => {}, ice, clock = Date.now }) {
  const rooms = new Map();
  const members = new Map();
  const lastRing = new Map();
  let lastSweep = 0;
  const fail = (status, error) => ({ status, data: { error } });
  const ok = (data = {}) => ({ status: 200, data });
  const room = id => rooms.get(id);

  function remove(member) {
    members.delete(member.accountId);
    const current = room(member.conversation);
    current.delete(member.id);
    for (const peer of current.values()) wake(peer.accountId, peer.token);
    if (!current.size) rooms.delete(member.conversation);
  }

  function valid(member, now) {
    return now < member.expires && authorized(member.conversation, member.accountId, member.token);
  }

  function sweep(conversation, now) {
    for (const member of room(conversation)?.values() ?? []) if (!valid(member, now)) remove(member);
  }

  function roster(member) {
    return [...room(member.conversation).values()]
      .filter(peer => peer !== member)
      .map(({ id, name }) => ({ id, name }));
  }

  return (action, input, account, token) => {
    const conversation = input?.conversation;
    if (!Number.isSafeInteger(conversation) || conversation <= 0) return fail(400, 'Choose a voice channel or direct chat.');
    const now = clock();
    if (now - lastSweep >= 10_000) {
      lastSweep = now;
      for (const id of rooms.keys()) sweep(id, now);
      for (const [id, at] of lastRing) if (now - at > 30_000) lastRing.delete(id);
    }
    sweep(conversation, now);
    if (!authorized(conversation, account.id, token)) return fail(403, 'You no longer have access to this call.');
    const previous = members.get(account.id);
    if (previous && !valid(previous, now)) remove(previous);
    const existing = members.get(account.id);
    if (action === 'join') {
      if (existing && (existing.token !== token || existing.conversation !== conversation || input.client !== existing.client)) {
        return fail(409, 'You are already in a call.');
      }
      if (existing) return ok({ id: existing.id, peers: roster(existing), ice: existing.ice });
      if (typeof input.client !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.client)) return fail(400, 'Invalid call client.');
      const current = room(conversation) ?? new Map();
      const recipient = directRecipient(conversation, account.id);
      if (input.invite && (!recipient || current.get(input.invite)?.accountId !== recipient)) {
        return fail(410, 'This call is no longer ringing.');
      }
      if (recipient && !current.size && now - (lastRing.get(account.id) ?? -Infinity) < 12_000) {
        return fail(429, 'Wait a moment before calling again.');
      }
      if (current.size >= (recipient ? 2 : maxRoom)) return fail(409, 'This voice room is full.');
      const member = { id: randomUUID(), accountId: account.id, token, conversation,
        client: input.client, name: account.displayName || account.username, expires: now + leaseMs,
        signals: [], sent: 0 };
      member.ice = ice?.(member.id, now);
      member.lastIce = now;
      current.set(member.id, member);
      rooms.set(conversation, current);
      members.set(account.id, member);
      if (recipient && current.size === 1) {
        lastRing.set(account.id, now);
        ring(recipient, { conversation, from: member.name, id: member.id });
      }
      for (const peer of current.values()) if (peer !== member) wake(peer.accountId, peer.token);
      return ok({ id: member.id, peers: roster(member), ice: member.ice });
    }
    if (action === 'decline') {
      const caller = room(conversation)?.get(input.id);
      if (caller && directRecipient(conversation, caller.accountId) === account.id && room(conversation).size === 1) {
        remove(caller);
      }
      return ok();
    }
    if (!existing || existing.token !== token || existing.conversation !== conversation || existing.id !== input.id) {
      return fail(410, 'This call ended or expired.');
    }
    if (action === 'leave') {
      remove(existing);
      return ok();
    }
    if (action === 'ice') {
      if (now - (existing.lastIce ?? -Infinity) < 10_000) return fail(429, 'Wait before refreshing voice credentials.');
      existing.lastIce = now;
      existing.ice = ice?.(existing.id, now);
      return ok({ ice: existing.ice });
    }
    if (action === 'poll') {
      existing.expires = now + leaseMs;
      return ok({ peers: roster(existing), signals: existing.signals.splice(0) });
    }
    if (action === 'signal') {
      const target = room(conversation).get(input.target);
      const { type, sdp, candidate } = input;
      if (!target || target === existing) return fail(404, 'This participant left the call.');
      if (type === 'candidate') {
        if (typeof candidate?.candidate !== 'string' || !/^candidate:[^\r\n]{1,1000}$/.test(candidate.candidate) ||
            !['string', 'undefined'].includes(typeof candidate.usernameFragment) ||
            (candidate.usernameFragment?.length ?? 0) > 256 ||
            (candidate.sdpMid !== null && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 32)) ||
            candidate.sdpMLineIndex !== 0) return fail(400, 'Invalid ICE candidate.');
      } else if (type !== 'restart' && (!['offer', 'answer'].includes(type) || typeof sdp !== 'string' || sdp.length > 16_000 ||
          !sdp.startsWith('v=0') || !/^m=audio /m.test(sdp) || /^m=(?!audio )/m.test(sdp))) {
        return fail(400, 'Invalid voice signal.');
      }
      if (now - (existing.signalWindow ?? 0) >= 60_000 || existing.signalWindow === undefined) {
        existing.signalWindow = now;
        existing.sent = 0;
      }
      if (existing.sent >= 200 || target.signals.length >= 100) return fail(429, 'Too many voice signals.');
      existing.sent++;
      target.signals.push(type === 'candidate'
        ? { from: existing.id, type, candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment } }
        : { from: existing.id, type, sdp });
      wake(target.accountId, target.token);
      return ok();
    }
    return fail(404, 'Voice action unavailable.');
  };
}
