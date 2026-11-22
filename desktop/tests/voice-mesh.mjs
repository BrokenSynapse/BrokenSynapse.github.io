import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from './horizon-fixture.mjs';

process.env.HORIZON_VOICE = '1';
const relayOnly = process.env.HORIZON_TEST_RELAY_ONLY === '1';
if (relayOnly) assert.ok(process.env.HORIZON_VOICE_TURN_URLS && process.env.HORIZON_VOICE_TURN_SECRET,
  'Configure an isolated TURN server before forcing relay-only ICE.');
const fixture = await startFixture();
const { chromium } = createRequire(import.meta.url)('playwright');
const mediaFlags = ['--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: mediaFlags,
});
async function post(route, data, cookie, expected) {
  const res = await fetch(fixture.base + route, {
    method: 'POST',
    headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(data),
  });
  if (expected) assert.equal(res.status, expected, await res.clone().text());
  else assert.ok(res.ok, await res.clone().text());
  return { data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

let desktop;
const instrument = relayOnly => {
  if (window.voicePeers) return;
  window.voicePeers = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    this.volume = 0;
    return play.call(this);
  };
  window.RTCPeerConnection = class extends RTCPeerConnection {
    constructor(config) { super(relayOnly ? { ...config, iceTransportPolicy: 'relay' } : config); window.voicePeers.push(this); }
  };
};

async function desktopPage(executable) {
  const root = await mkdtemp(join(tmpdir(), 'horizon-voice-qa-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(done => probe.close(done));
  desktop = spawn(resolve(executable), [], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
      HORIZON_FIXTURE_CONFIG: join(root, 'config'), HORIZON_FIXTURE_CACHE: join(root, 'cache'),
      HORIZON_FIXTURE_PORT: String(fixture.port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [...mediaFlags, '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=' + port].join(' ') },
  });
  const endpoint = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    if (await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false)) break;
    await delay(200);
  }
  const connection = await chromium.connectOverCDP(endpoint);
  return connection.contexts()[0].pages()[0];
}

async function signIn(username, native = false) {
  const page = native ? await desktopPage(process.argv[2]) : await browser.newPage();
  await page.addInitScript(instrument, relayOnly);
  if (native) {
    await page.locator('#authentication input[name=username]').waitFor();
    await page.evaluate(instrument, relayOnly);
  } else {
    await page.goto('http://127.0.0.1:' + fixture.port + '/horizon-chat/');
  }
  await page.locator('#authentication input[name=username]').fill(username);
  await page.locator('#authentication input[name=password]').fill('horizon-fixture');
  await page.locator('#authentication [type=submit]').click();
  return page;
}

async function directAudio(page, count) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(async ({ expected, relayOnly }) => {
    const peers = window.voicePeers.filter(pc => pc.connectionState === 'connected');
    if (peers.length !== expected) return false;
    return (await Promise.all(peers.map(async pc => {
      const reports = await pc.getStats();
      const stats = [...reports.values()];
      const transport = stats.find(report => report.type === 'transport' && report.selectedCandidatePairId);
      const pair = reports.get(transport?.selectedCandidatePairId);
      const kinds = pair && [pair.localCandidateId, pair.remoteCandidateId].map(id => reports.get(id)?.candidateType);
      return kinds?.every(kind => kind && (kind === 'relay') === relayOnly)
        && stats.some(report => report.type === 'inbound-rtp' && report.kind === 'audio' && report.bytesReceived > 0);
    }))).every(Boolean);
    }, { expected: count, relayOnly })) return;
    await delay(250);
  }
  const stats = await page.evaluate(() => Promise.all(window.voicePeers.map(async pc => {
    const reports = [...(await pc.getStats()).values()];
    return { state: pc.connectionState, reports: reports.filter(entry => ['inbound-rtp', 'outbound-rtp', 'transport', 'candidate-pair'].includes(entry.type))
      .map(({ type, kind, bytesReceived, bytesSent, state, selectedCandidatePairId }) =>
        ({ type, kind, bytesReceived, bytesSent, state, selectedCandidatePairId })) };
  })));
  assert.fail('Direct audio did not arrive. ' + JSON.stringify(stats));
}

try {
  const [writer, reader] = await Promise.all([signIn('FixtureWriter', Boolean(process.argv[2])), signIn('FixtureReader')]);
  const outsider = await post('register', {
    username: 'FixtureThird', displayName: 'Fixture Third', tag: 'T111', password: 'horizon-fixture',
  });
  const voice = name => '[data-voice="' + name + '"]';
  const dm = '[data-typing-thread="' + fixture.dm + '"] .conversation';
  await Promise.all([writer.locator(dm).click(), reader.locator(dm).click()]);
  await post('voice/join', { conversation: fixture.dm, client: crypto.randomUUID() }, outsider.cookie, 403);
  await writer.locator('#voice-start').click();
  await reader.locator(voice('accept')).click();
  await Promise.all([directAudio(writer, 1), directAudio(reader, 1)]);
  for (const page of [writer, reader]) {
    assert.equal(await page.evaluate(() => window.voicePeers[0].getSenders()[0].getParameters().encodings[0].maxBitrate),
      Number(process.env.HORIZON_VOICE_OPUS_KBPS ?? 12) * 1000);
  }
  await writer.locator(voice('mute')).click();
  assert.equal(await writer.evaluate(() => window.voicePeers[0].getSenders()[0].track.enabled), false);
  await reader.locator(voice('deafen')).click();
  assert.equal(await reader.locator('#voice-panel audio').evaluate(audio => audio.muted), true);
  await reader.locator(voice('deafen')).click();
  await writer.locator(voice('mute')).click();
  const route = '**/voice/poll';
  await reader.route(route, entry => entry.abort());
  await reader.waitForFunction(() => window.voicePeers[0].connectionState === 'connected');
  await reader.getByText('Reconnecting to Horizon…').waitFor({ timeout: 20_000 });
  const inboundBytes = () => reader.evaluate(async () => {
    const reports = await window.voicePeers[0].getStats();
    return [...reports.values()].find(report => report.type === 'inbound-rtp' && report.kind === 'audio').bytesReceived;
  });
  const before = await inboundBytes();
  for (let i = 0; i < 10 && await inboundBytes() <= before; i++) await delay(250);
  assert.ok(await inboundBytes() > before, 'Audio should continue while signaling is unavailable.');
  await reader.unroute(route);
  await reader.getByText(relayOnly ? /Connected.*Relay/ : /Connected.*Direct/).waitFor({ timeout: 12_000 });
  const mic = await writer.evaluateHandle(() => window.voicePeers[0].getSenders()[0].track);
  await writer.locator(voice('leave')).click();
  assert.equal(await mic.evaluate(track => track.readyState), 'ended');
  await reader.getByText('The other person left the call.').waitFor();
  const { data: { server } } = await post('servers', { name: 'Voice Mesh' }, fixture.writer.cookie);
  const { data: { channelId } } = await post('servers/' + server.id + '/channels', {
    name: 'Voice Room', kind: 'voice', everyoneVisibility: 0, roleRules: [],
  }, fixture.writer.cookie);
  const groupSize = process.env.HORIZON_TEST_MESH_SIX === '1' ? 6 : 3;
  const additional = await Promise.all(Array.from({ length: groupSize - 3 }, (_, i) =>
    post('register', { username: 'FixtureExtra' + i, displayName: 'Extra ' + i, tag: 'E10' + i, password: 'horizon-fixture' })));
  await Promise.all([fixture.reader.cookie, outsider.cookie, ...additional.map(item => item.cookie)].map(cookie =>
    post('servers/join', { code: server.inviteCode }, cookie)));
  const [third, ...extra] = await Promise.all([
    signIn('FixtureThird'), ...additional.map((_, i) => signIn('FixtureExtra' + i)),
  ]);
  const group = [writer, reader, third, ...extra];
  await Promise.all(group.map(async page => {
    await page.locator('[data-server="' + server.id + '"]').click();
    await page.locator('[data-channel-id="' + channelId + '"] .channel-name').click();
    await page.locator('#voice-start').click();
  }));
  await Promise.all(group.map(page => directAudio(page, groupSize - 1)));
  await third.locator(voice('leave')).click();
  await Promise.all(group.filter(page => page !== third).map(page => directAudio(page, groupSize - 2)));
  await third.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Test denial', 'NotAllowedError'));
  });
  await third.locator('#voice-start').click();
  await third.getByText('Microphone access was denied.').waitFor();
  console.log('Verified ' + (relayOnly ? 'relayed' : 'direct') +
    ' audio in a DM and a ' + groupSize + '-person mesh, authorization, mute, deafen, signaling recovery, microphone denial and cleanup.');
} finally {
  desktop?.kill();
  await browser.close();
  await fixture.close();
}
