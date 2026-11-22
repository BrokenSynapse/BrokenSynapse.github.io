import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createVoiceCalls } from './voice-calls.mjs';

const audio = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

test('voice signaling is scoped to each authenticated session and current room access', () => {
  let now = 100_000;
  const denied = new Set();
  const voice = createVoiceCalls({
    authorized: (_, accountId) => !denied.has(accountId),
    directRecipient: () => null, ring: () => {}, clock: () => now,
  });
  const invoke = (accountId, action, input, token = 'session-' + accountId) =>
    voice(action, { conversation: 1, ...input }, { id: accountId, username: String(accountId) }, token);
  const join = accountId => invoke(accountId, 'join', { client: randomUUID() });
  const first = join(1).data.id;
  const second = join(2).data.id;
  assert.equal(invoke(1, 'poll', { id: first }, 'other-session').status, 410);
  assert.equal(invoke(1, 'signal', { id: first, target: second, type: 'offer', sdp: audio + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }).status, 400);
  assert.equal(invoke(1, 'signal', { id: first, target: second, type: 'offer', sdp: audio }).status, 200);
  assert.deepEqual(invoke(2, 'poll', { id: second }).data.signals, [{ from: first, type: 'offer', sdp: audio }]);
  assert.deepEqual(invoke(2, 'poll', { id: second }).data.signals, []);
  const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host', sdpMid: '0',
    sdpMLineIndex: 0, usernameFragment: 'audio' };
  assert.equal(invoke(1, 'signal', { id: first, target: second, type: 'candidate', candidate: { ...candidate, sdpMLineIndex: 1 } }).status, 400);
  assert.equal(invoke(1, 'signal', { id: first, target: 'unrelated', type: 'candidate', candidate }).status, 404);
  assert.equal(invoke(1, 'signal', { id: first, target: second, type: 'candidate', candidate }).status, 200);
  assert.deepEqual(invoke(2, 'poll', { id: second }).data.signals, [{ from: first, type: 'candidate', candidate }]);
  for (let i = 3; i <= 6; i++) assert.equal(join(i).status, 200);
  assert.equal(join(7).status, 409);
  denied.add(2);
  assert.equal(invoke(2, 'poll', { id: second }).status, 403);
  assert.equal(invoke(1, 'signal', { id: first, target: second, type: 'answer', sdp: audio }).status, 404);
  now += 45_000;
  assert.equal(invoke(1, 'poll', { id: first }).status, 410);
  assert.equal(join(7).status, 200);
});

test('DM invitations target the other member and expire after decline', () => {
  const rings = [];
  const voice = createVoiceCalls({
    authorized: (_, id) => id === 1 || id === 2,
    directRecipient: (_, id) => id === 1 ? 2 : 1,
    ring: (...event) => rings.push(event), clock: () => 100_000,
  });
  const invoke = (id, action, input) =>
    voice(action, { conversation: 1, ...input }, { id, username: String(id) }, 'session-' + id);
  const caller = invoke(1, 'join', { client: randomUUID() }).data.id;
  assert.deepEqual(rings, [[2, { conversation: 1, from: '1', id: caller }]]);
  assert.equal(invoke(3, 'join', { client: randomUUID(), invite: caller }).status, 403);
  assert.equal(invoke(2, 'decline', { id: caller }).status, 200);
  assert.equal(invoke(1, 'poll', { id: caller }).status, 410);
  assert.equal(invoke(2, 'join', { client: randomUUID(), invite: caller }).status, 410);
  assert.equal(invoke(1, 'join', { client: randomUUID() }).status, 429);
});
