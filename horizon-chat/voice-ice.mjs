import { createHmac } from 'node:crypto';

export function voiceIceConfig(env = process.env) {
  const urls = (value, allowed) => (value ?? '').split(',').map(url => url.trim()).filter(Boolean).map(url => {
    if (!allowed.test(url)) throw new Error('Invalid voice ICE server URL.');
    return url;
  });
  const stun = urls(env.HORIZON_VOICE_STUN_URLS ?? 'stun:stun.cloudflare.com:3478', /^stuns?:[^\s/@?#]+$/i);
  const turn = urls(env.HORIZON_VOICE_TURN_URLS, /^turns?:[^\s/@?#]+(?:\?transport=(?:udp|tcp))?$/i);
  const secret = env.HORIZON_VOICE_TURN_SECRET;
  const mode = env.HORIZON_VOICE_TURN_AUTH ?? 'rest';
  const ttl = Number(env.HORIZON_VOICE_TURN_TTL ?? 3600);
  const bitrate = Number(env.HORIZON_VOICE_OPUS_KBPS ?? 12);
  if (turn.length && (mode !== 'rest' || !secret || !Number.isInteger(ttl) || ttl < 300 || ttl > 86400)) {
    throw new Error('Configure TURN REST authentication, a shared secret and a credential TTL of 300–86400 seconds.');
  }
  if (!Number.isInteger(bitrate) || bitrate < 12 || bitrate > 64) throw new Error('Voice Opus bitrate must be 12–64 Kbps.');
  return (memberId, now) => {
    const iceServers = stun.length ? [{ urls: stun }] : [];
    if (!turn.length) return { iceServers, bitrate: bitrate * 1000 };
    const expiresAt = (Math.floor(now / 1000) + ttl) * 1000;
    const username = `${expiresAt / 1000}:${memberId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    return { iceServers: [...iceServers, { urls: turn, username, credential }], expiresAt, bitrate: bitrate * 1000 };
  };
}
