import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { voiceIceConfig } from './voice-ice.mjs';
import { createVoiceCalls } from './voice-calls.mjs';

test('coturn REST credentials are short-lived, scoped and available only to voice members', () => {
  const secret = 'fixture-only secret';
  const ice = voiceIceConfig({
    HORIZON_VOICE_STUN_URLS: '',
    HORIZON_VOICE_TURN_URLS: 'turn:relay.example.test:3478?transport=udp,turn:relay.example.test:3478?transport=tcp,turns:relay.example.test:5349?transport=tcp',
    HORIZON_VOICE_TURN_SECRET: secret,
    HORIZON_VOICE_TURN_TTL: '300',
  });
  let now = 1_000_000;
  const voice = createVoiceCalls({ ice, clock: () => now, authorized: (_, id) => id === 1, directRecipient: () => null, ring: () => {} });
  const invoke = (action, input, id = 1, token = 'authorized') =>
    voice(action, { conversation: 7, ...input }, { id, username: 'fixture' }, token);
  assert.equal(invoke('ice', {}, 2).status, 403);
  assert.equal(invoke('ice', {}).status, 410);
  const joined = invoke('join', { client: crypto.randomUUID() }).data;
  const turn = joined.ice.iceServers[0];
  assert.equal(turn.username, '1300:' + joined.id);
  assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
  assert.equal(turn.urls.length, 3);
  assert.equal(joined.ice.expiresAt, 1_300_000);
  assert.equal(joined.ice.bitrate, 12_000);
  assert.equal(voiceIceConfig({ HORIZON_VOICE_OPUS_KBPS: '24' })('fixture', now).bitrate, 24_000);
  assert.equal(JSON.stringify(joined).includes(secret), false);
  assert.equal(invoke('ice', { id: joined.id }, 1, 'other-session').status, 410);
  now += 11_000;
  assert.equal(invoke('ice', { id: joined.id }).data.ice.expiresAt, 1_311_000);
  assert.equal(invoke('ice', { id: joined.id }).status, 429);
  assert.throws(() => voiceIceConfig({ HORIZON_VOICE_TURN_URLS: 'turn:relay.example.test' }), /shared secret/);
});
