import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAttachmentPeers } from './attachment-peers.mjs';

test('peer grants bind both sessions and one chunk, recheck access, and expire', () => {
  let now = 10_000;
  const participants = new Set([1, 2]);
  const events = [];
  const handle = createAttachmentPeers({
    authorize: (peer, chunk) => participants.has(peer.account) && chunk.conversation === 9,
    describe: chunk => chunk.message === 14 && chunk.offset === 0 ? { hash: 'e'.repeat(64), size: 65536 } : null,
    emit: (peer, ticket) => events.push([peer.id, ticket]),
    clock: () => now,
  });
  const source = randomUUID();
  const target = randomUUID();
  const outsider = randomUUID();
  const chunk = { conversation: 9, message: 14, offset: 0 };
  const call = (path, peer, account, payload = {}, token = 'token-' + account) =>
    handle(path, { peer, ...payload }, account, token);
  assert.equal(call('hello', source, 1).status, 200);
  assert.equal(call('hello', target, 2).status, 200);
  assert.equal(call('hello', outsider, 3).status, 200);
  assert.equal(call('advertise', source, 1, chunk).status, 200);
  assert.equal(call('discover', outsider, 3, chunk).status, 404);
  assert.equal(call('discover', target, 2, chunk, 'another-session').status, 404);
  const { ticket } = call('discover', target, 2, chunk).data;
  assert.ok(ticket);
  assert.equal(call(ticket + '/state', outsider, 3).status, 404);
  assert.equal(call(ticket + '/offer', target, 2, { sdp: 'v=0\r\n' }).status, 200);
  assert.deepEqual(events.shift(), [source, ticket]);
  assert.equal(call(ticket + '/answer', source, 1, { sdp: 'v=0\r\n' }).status, 200);
  assert.equal(call(ticket + '/seed', target, 2).status, 404);
  participants.delete(2);
  assert.equal(call(ticket + '/seed', source, 1).status, 404);
  participants.add(2);
  const grant = call(ticket + '/seed', source, 1);
  assert.equal(grant.data.route, 'conversations/9/messages/14/document?offset=0&encoding=gzip');
  assert.equal(call(ticket + '/seed', source, 1).status, 404);
  assert.equal(call(ticket + '/store', target, 2).status, 200);
  assert.equal(call(ticket + '/store', target, 2).status, 404);
  const next = call('discover', target, 2, chunk).data.ticket;
  now += 16_000;
  assert.equal(call(next + '/state', target, 2).status, 404);
  now += 60_000;
  call('hello', target, 2);
  assert.equal(call('discover', target, 2, chunk).data.ticket, null);
});
