import { apiFetch, isDesktop } from './platform.js';

const maxChunk = 320 * 1024;
const packet = 16 * 1024;
const uuid = /^[a-f0-9-]{36}$/;
const connections = new Map();
const downloads = new Map();
let signedIn = false;
let tray = false;
let peer;
let heartbeat;
let mode = 'off';
let kib = 512;
let pauseMetered = true;
let systemMetered = null;
let meterChecked = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function eligible() {
  return isDesktop && signedIn && typeof RTCPeerConnection === 'function' &&
    !(pauseMetered && (!meterChecked || systemMetered === true || navigator.connection?.saveData)) &&
    (mode === 'tray' || mode === 'active' && !tray && !document.hidden);
}

function stop() {
  const old = peer;
  peer = null;
  clearInterval(heartbeat);
  for (const rtc of connections.values()) rtc.close();
  connections.clear();
  downloads.clear();
  if (old) void post('leave', {}, old).catch(() => {});
}

async function post(route, data = {}, owner = peer, signal) {
  const response = await apiFetch('peers/' + route, {
    method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, peer: owner }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3500)]) : AbortSignal.timeout(3500),
  });
  if (!response.ok) throw new Error('Peer request unavailable.');
  return response.json();
}

function synchronize() {
  if (!eligible()) { stop(); return; }
  if (peer) return;
  peer = crypto.randomUUID();
  const registered = peer;
  const hello = () => post('hello', {}, registered).then(() => {
    if (peer !== registered) return post('leave', {}, registered);
  }).catch(() => {});
  void hello();
  heartbeat = setInterval(hello, 20_000);
}

export function peerAccount(active) {
  stop();
  signedIn = active;
  meterChecked = false;
  synchronize();
  void checkNetwork();
}

async function checkNetwork() {
  if (!isDesktop || mode === 'off' || !signedIn || !pauseMetered) return;
  try {
    const reply = await apiFetch('local-peer/metered', {
      method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(2500),
    });
    systemMetered = reply.ok ? (await reply.json()).metered : null;
  } catch { systemMetered = null; }
  finally {
    meterChecked = true;
    synchronize();
  }
}

export function setupPeerSettings(section) {
  if (!isDesktop || !section) return;
  section.hidden = false;
  const $ = id => section.querySelector('#' + id);
  const modeField = $('peer-mode');
  const limitField = $('peer-upload');
  const diskField = $('peer-cache-limit');
  const meteredField = $('peer-metered');
  const status = $('peer-settings-status');
  setInterval(checkNetwork, 10_000);
  try {
    modeField.value = localStorage.getItem('horizon-peer-mode') || 'off';
    limitField.value = localStorage.getItem('horizon-peer-upload') || '512';
    diskField.value = localStorage.getItem('horizon-peer-cache-limit') || '2048';
    meteredField.checked = localStorage.getItem('horizon-peer-metered') !== 'false';
  } catch {}
  function apply() {
    const wasOff = mode === 'off';
    mode = ['active', 'tray'].includes(modeField.value) ? modeField.value : 'off';
    kib = Math.min(8192, Math.max(16, Number(limitField.value) || 512));
    limitField.value = kib;
    pauseMetered = meteredField.checked;
    if (wasOff) meterChecked = false;
    try {
      localStorage.setItem('horizon-peer-mode', mode);
      localStorage.setItem('horizon-peer-upload', kib);
      localStorage.setItem('horizon-peer-metered', pauseMetered);
    } catch {}
    synchronize();
    void checkNetwork();
  }
  for (const element of [modeField, limitField, meteredField]) element.addEventListener('change', apply);
  diskField.addEventListener('change', async () => {
    const value = Number(diskField.value);
    if (!Number.isInteger(value) || value < 0 || value > 8192) return;
    try {
      const reply = await apiFetch('local-peer/cache-limit', {
        method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(value), signal: AbortSignal.timeout(5000),
      });
      if (!reply.ok) throw new Error();
      try { localStorage.setItem('horizon-peer-cache-limit', value); } catch {}
      status.textContent = 'Cache limit saved.';
    } catch { status.textContent = 'The desktop cache is unavailable.'; }
  });
  document.addEventListener('visibilitychange', synchronize);
  navigator.connection?.addEventListener('change', synchronize);
  window.addEventListener('horizon-tray-hidden', () => { tray = true; synchronize(); });
  window.addEventListener('horizon-tray-shown', () => { tray = false; synchronize(); });
  window.addEventListener('pagehide', stop);
  apply();
}

function rtcFor(ticket) {
  const rtc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  });
  connections.set(ticket, rtc);
  return rtc;
}

async function gathering(rtc) {
  const completed = new Promise(resolve => {
    const check = () => { if (rtc.iceGatheringState === 'complete') resolve(); };
    rtc.addEventListener('icegatheringstatechange', check, { once: false });
    check();
  });
  await Promise.race([completed, delay(650)]);
  return rtc.localDescription.sdp;
}

function close(ticket) {
  connections.get(ticket)?.close();
  connections.delete(ticket);
}

function local(route, owner, body, signal) {
  return apiFetch('local-peer/' + route.replace('/', '/' + owner + '/'), {
    method: 'POST', headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/octet-stream' },
    body, signal,
  });
}

async function seed(ticket, owner) {
  if (connections.size >= 4 || connections.has(ticket)) return;
  const signal = AbortSignal.timeout(11_000);
  const existing = await post(ticket + '/state', {}, owner, signal);
  if (!existing.offer || peer !== owner || !eligible()) return;
  const rtc = rtcFor(ticket);
  signal.addEventListener('abort', () => close(ticket), { once: true });
  rtc.ondatachannel = ({ channel }) => {
    channel.onopen = async () => {
      try {
        if (!eligible() || peer !== owner) return;
        const reply = await local(ticket + '/seed', owner, new Uint8Array(), signal);
        if (!reply.ok) return;
        const bytes = new Uint8Array(await reply.arrayBuffer());
        const groupSize = Math.min(64 * 1024, kib * 1024);
        for (let offset = 0; offset < bytes.length; offset += groupSize) {
          const end = Math.min(bytes.length, offset + groupSize);
          await delay((end - offset) / kib * 1000 / 1024);
          if (!eligible() || peer !== owner || signal.aborted || channel.readyState !== 'open') return;
          for (let pos = offset; pos < end; pos += packet) channel.send(bytes.subarray(pos, Math.min(pos + packet, end)));
        }
      } catch {}
    };
  };
  try {
    await rtc.setRemoteDescription({ type: 'offer', sdp: existing.offer });
    await rtc.setLocalDescription(await rtc.createAnswer());
    await post(ticket + '/answer', { sdp: await gathering(rtc) }, owner, signal);
  } catch { close(ticket); }
}

export function peerSignal(event) {
  const [owner, ticket] = event.data.split(':');
  if (eligible() && owner === peer && uuid.test(ticket)) void seed(ticket, owner).catch(() => {});
}

function locationFor(url, offset) {
  const match = /\/conversations\/(\d+)\/messages\/(\d+)\/document$/.exec(new URL(url, location.href).pathname);
  if (!match) return null;
  return { conversation: Number(match[1]), message: Number(match[2]), offset };
}

export function advertiseChunk(url, offset) {
  if (!peer || !eligible()) return;
  const chunk = locationFor(url, offset);
  if (chunk) void post('advertise', chunk).catch(() => {});
}

export function peerEnabled(limit) {
  return Boolean(peer && eligible() && limit >= 512 * 1024);
}

export function peerChunk(url, offset, limit, signal) {
  if (!peerEnabled(limit) || connections.size >= 4) return null;
  const key = url + ':' + offset;
  if (downloads.has(key)) return downloads.get(key);
  const chunk = locationFor(url, offset);
  if (!chunk) return null;
  const job = retrieve(chunk, peer, signal).catch(() => null).finally(() => {
    if (downloads.get(key) === job) downloads.delete(key);
  });
  downloads.set(key, job);
  return job;
}

async function retrieve(chunk, owner, external) {
  const signal = AbortSignal.any([AbortSignal.timeout(8500), ...(external ? [external] : [])]);
  const { ticket, hash, size } = await post('discover', chunk, owner, signal);
  if (!ticket || !uuid.test(ticket) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) ||
      !Number.isInteger(size) || size < 64 * 1024 || size > maxChunk || owner !== peer) return null;
  let succeeded = false;
  try {
    const rtc = rtcFor(ticket);
    const channel = rtc.createDataChannel('horizon-chunk');
    channel.binaryType = 'arraybuffer';
    const result = new Uint8Array(size);
    let received = 0;
    const completed = new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(false), { once: true });
      channel.onclose = () => resolve(false);
      channel.onerror = () => resolve(false);
      channel.onmessage = event => {
        if (!(event.data instanceof ArrayBuffer) || received + event.data.byteLength > size || !eligible() || peer !== owner) {
          resolve(false); return;
        }
        result.set(new Uint8Array(event.data), received);
        received += event.data.byteLength;
        if (received === size) resolve(true);
      };
    });
    await rtc.setLocalDescription(await rtc.createOffer());
    await post(ticket + '/offer', { sdp: await gathering(rtc) }, owner, signal);
    while (!signal.aborted) {
      const { answer } = await post(ticket + '/state', {}, owner, signal);
      if (answer) { await rtc.setRemoteDescription({ type: 'answer', sdp: answer }); break; }
      await delay(250);
    }
    if (signal.aborted || !await completed) return null;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== hash) return null;
    // The recipient's grant is rechecked before the data is accepted.
    const stored = await local(ticket + '/store', owner, result, signal);
    if (!stored.ok) return null;
    succeeded = true;
    return result;
  } finally {
    close(ticket);
    if (!succeeded) void post(ticket + '/cancel', {}, owner).catch(() => {});
  }
}
