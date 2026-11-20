import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

const executable = resolve(process.argv[2] ?? 'horizon-chat-desktop.exe');

async function until(fn) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await delay(350);
  }
  throw new Error('Timed out waiting for the packaged Horizon window');
}

async function run(offline, fixture, browser = false, exercise, profileOverride) {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()));
  const profileRoot = resolve(tmpdir());
  const profile = profileOverride ?? resolve(await mkdtemp(join(profileRoot, 'horizon-package-')));
  assert.equal(dirname(profile), profileRoot);
  const entry = browser ? `http://127.0.0.1:${fixture.port}/horizon-chat/` : 'http://tauri.localhost/';
  const args = browser ? ['--headless=new', '--no-first-run', '--disable-background-networking',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, entry] : offline ? ['--offline'] : [];
  const child = spawn(executable, args, {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
      ...(fixture ? { HORIZON_FIXTURE_PORT: String(fixture.port), HORIZON_FIXTURE_CACHE: join(profile, 'cache') } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}${fixture ? ' --disable-features=WebRtcHideLocalIpsWithMdns' : ''}` },
    windowsHide: true,
    stdio: 'ignore',
  });
  const exited = once(child, 'exit').catch(() => {});
  let socket;
  try {
    const page = await until(async () => {
      const reply = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await reply.json()).find(tab => tab.type === 'page' && tab.url.startsWith(entry));
    });
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    async function evaluate(expression) {
      const messageId = ++id;
      const result = new Promise((done, fail) => {
        function onMessage(event) {
          const message = JSON.parse(event.data);
          if (message.id !== messageId) return;
          socket.removeEventListener('message', onMessage);
          if (message.error || message.result.exceptionDetails) {
            fail(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
          } else {
            done(message.result.result.value);
          }
        }
        socket.addEventListener('message', onMessage);
      });
      socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true } }));
      return result;
    }
    const state = await until(async () => {
      const view = await evaluate(`(() => {
        const status = document.getElementById('desktop-connection');
        const logo = document.querySelector('#brand img');
        if (!status || !logo?.naturalWidth || !document.styleSheets.length) return null;
        return { origin: location.origin, title: document.querySelector('#auth-title')?.textContent,
          status: status.hidden ? '' : status.textContent };
      })()`);
      return view && (offline ? view.status.includes('Horizon is unreachable') : view.status === '') ? view : null;
    });
    assert.equal(state.origin, new URL(entry).origin);
    assert.equal(state.title, 'Sign in');
    if (exercise) {
      await exercise(evaluate);
      return;
    }
    if (fixture) {
      if (process.argv.includes('--recovery-fixture')) {
        const { exerciseRecovery } = await import('./recovery-fixture.mjs');
        await exerciseRecovery(evaluate, until, fixture);
      } else {
        await exerciseAuthenticatedSession(evaluate, fixture, browser);
      }
      return;
    }
    const session = await evaluate(`(async () => {
      const platform = await import('./platform.js');
      const reply = await platform.apiFetch('session', { signal: AbortSignal.timeout(8000) });
      return { status: reply.status, account: reply.ok ? (await reply.json()).account : null };
    })()`);
    assert.deepEqual(session, { status: offline ? 503 : 200, account: null });
    if (offline) {
      const preflight = await evaluate(`(async () => {
        const platform = await import('./platform.js');
        const options = { method: 'POST', body: '{}', signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json', 'X-Horizon-Chat': '1' } };
        const accepted = await platform.apiFetch('session', options);
        delete options.headers['X-Horizon-Chat'];
        const refused = await platform.apiFetch('session', options);
        return [accepted.status, refused.status];
      })()`);
      assert.deepEqual(preflight, [503, 403]);
      if (process.argv.includes('--check-device-ui')) {
        await evaluate("document.getElementById('open-offline-replicas').click()");
        await until(() => evaluate("document.getElementById('offline-replicas').open && document.querySelector('[data-offline-replica=status]').textContent.includes('no complete encrypted replicas')"));
        const keyCanBeExported = await evaluate(`(async () => {
          const { createDeviceKey } = await import('./device-replica-store.js');
          const device = await createDeviceKey();
          return device.privateKey.extractable;
        })()`);
        assert.equal(keyCanBeExported, false);
      }
      if (process.argv.includes('--check-peer-ui')) {
        const peerSettings = await evaluate(`(async () => {
          const source = await (await fetch('./attachment-peers.js')).text();
          return [document.getElementById('peer-mode').value, source.includes('!meterChecked')];
        })()`);
        assert.deepEqual(peerSettings, ['off', true]);
      }
      if (process.argv.includes('--check-recovery')) {
        const verified = await evaluate(`(async () => {
          const { createArchive, newRecoveryKey, openChain } = await import('./recovery-archive.js');
          const key = newRecoveryKey();
          const snapshot = { characters: [], assets: [], theme: 'horizon' };
          const { file } = await createArchive(snapshot, key);
          const opened = await openChain([file], key);
          return opened.manifest.theme === 'horizon' && opened.manifest.parent === null;
        })()`);
        assert.equal(verified, true);
      }
      if (process.argv.includes('--check-codecs')) {
        const encoded = await evaluate(`(async () => {
          const { optimizeChatImage } = await import('./chat-images.js');
          const source = new OffscreenCanvas(64, 64);
          const context = source.getContext('2d');
          context.fillStyle = 'rgba(0, 128, 255, .5)';
          context.fillRect(0, 0, 32, 64);
          const file = new File([await source.convertToBlob()], 'offline.png', { type: 'image/png' });
          const first = await optimizeChatImage(file, {});
          const second = await optimizeChatImage(file, { format: 'webp' });
          return [first.file.type, second.file.type];
        })()`);
        assert.deepEqual(encoded, ['image/avif', 'image/webp']);
      }
    }
    console.log(offline ? 'Packaged frontend renders offline with the connection state' : 'Packaged frontend reaches the live Horizon session API');
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill();
    await exited;
    if (!profileOverride) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

async function exerciseAuthenticatedSession(evaluate, fixture, browser) {
  const step = async (name, expression) => {
    try { return await until(() => evaluate(expression)); }
    catch (error) { throw new Error('Fixture failed at ' + name, { cause: error }); }
  };
  await evaluate(`(() => {
    const form = document.getElementById('authentication');
    form.elements.username.value = 'FixtureWriter';
    form.elements.password.value = 'horizon-fixture';
    form.requestSubmit();
  })()`);
  await step('login and DM list', `!document.getElementById('app').hidden && Boolean(document.querySelector('[data-thread-key^="${fixture.dm}:"]') || document.querySelector('[data-typing-thread="${fixture.dm}"]'))`);
  await evaluate(`document.querySelector('[data-typing-thread="${fixture.dm}"] .conversation').click()`);
  await step('open DM', `document.getElementById('history').textContent.includes('Fixture DM ready')`);
  await step('character rail', `Boolean(document.querySelector('[data-persona="${fixture.proxy}"]'))`);
  await evaluate(`document.querySelector('[data-persona="${fixture.proxy}"]').click()`);
  await step('switch character', `document.querySelector('[data-persona="${fixture.proxy}"]').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.querySelector('[data-persona="0"]').click()`);
  await step('switch account', `document.querySelector('[data-persona="0"]').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.querySelector('[data-server="${fixture.serverId}"]').click()`);
  await step('server channel', `Boolean(document.querySelector('[data-channel-kind="text"]'))`);
  await evaluate(`document.querySelector('[data-channel-kind="text"]').click()`);
  await step('open channel', `!document.getElementById('composer').hidden && document.getElementById('thread-title').textContent.includes('general')`);
  await evaluate(`document.getElementById('inbox').click()`);
  await step('return to DM', `Boolean(document.querySelector('[data-typing-thread="${fixture.dm}"] .conversation'))`);
  await evaluate(`document.querySelector('[data-typing-thread="${fixture.dm}"] .conversation').click()`);
  await step('DM ready for upload', `document.getElementById('history').textContent.includes('Fixture DM ready')`);
  const measurement = await evaluate(`(async () => {
    const { optimizeChatImage } = await import('./chat-images.js');
    const canvas = new OffscreenCanvas(960, 720);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 20, 930, 650);
    gradient.addColorStop(0, 'rgba(25, 160, 220, .4)');
    gradient.addColorStop(1, 'rgba(180, 20, 80, 1)');
    ctx.fillStyle = gradient;
    ctx.fillRect(20, 20, 920, 680);
    const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'fixture.png', { type: 'image/png' });
    const results = {};
    for (const format of ['avif', 'webp']) {
      const before = performance.now();
      const encoded = await optimizeChatImage(file, { format, maximum: 0 });
      const ms = Math.round(performance.now() - before);
      const bitmap = await createImageBitmap(encoded.file);
      const output = new OffscreenCanvas(bitmap.width, bitmap.height);
      const pixels = output.getContext('2d');
      pixels.drawImage(bitmap, 0, 0);
      results[format] = { bytes: encoded.file.size, ms, width: bitmap.width,
        outside: pixels.getImageData(0, 0, 1, 1).data[3], inside: pixels.getImageData(100, 100, 1, 1).data[3] };
      bitmap.close();
    }
    window.fixtureImage = file;
    const animated = new File([Uint8Array.from([71, 73, 70, 56, 57, 97])], 'animated.gif', { type: 'image/gif' });
    results.animationRejected = await optimizeChatImage(animated).then(() => false, error => error.message.includes('animated'));
    const cancellation = new AbortController();
    const cancelled = optimizeChatImage(file, { format: 'avif' }, { signal: cancellation.signal });
    cancellation.abort();
    results.cancelled = await cancelled.then(() => false, error => error.name === 'AbortError');
    const large = new OffscreenCanvas(1400, 700);
    large.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0, 1400, 700);
    const jpeg = new Uint8Array(await (await large.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
    const marker = new Uint8Array([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const sourceWithMetadata = new File([jpeg.slice(0, 2), new Uint8Array([255, 225, 0, marker.length + 2]), marker, jpeg.slice(2)], 'exif.jpg');
    const resized = await optimizeChatImage(sourceWithMetadata, { format: 'webp', maximum: 1280 });
    const resizedBitmap = await createImageBitmap(resized.file);
    results.resize = [resizedBitmap.width, resizedBitmap.height];
    resizedBitmap.close();
    results.exifRemoved = !(await resized.file.text()).includes('EXIF') && !(await resized.file.text()).includes('Exif');
    return { source: file.size, ...results };
  })()`);
  for (const format of ['avif', 'webp']) {
    assert.equal(measurement[format].width, 960);
    assert.equal(measurement[format].outside, 0);
    assert.ok(measurement[format].inside > 0 && measurement[format].inside < 255);
  }
  assert.equal(measurement.animationRejected, true);
  assert.equal(measurement.cancelled, true);
  assert.deepEqual(measurement.resize, [1280, 640]);
  assert.equal(measurement.exifRemoved, true);
  console.log('Image measurements:', JSON.stringify(measurement));
  for (const [index, format] of ['avif', 'webp'].entries()) {
    await evaluate(`(() => {
      document.getElementById('chat-image-format').value = '${format}';
      const transfer = new DataTransfer();
      transfer.items.add(window.fixtureImage);
      const input = document.getElementById('attachment-file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
      document.getElementById('composer').requestSubmit();
    })()`);
    await step(format + ' upload', `document.querySelectorAll('#history [data-media-kind="image"]').length === ${index + 1}`);
  }
  const uploads = fixture.db.prepare("SELECT id, format FROM direct_messages WHERE conversation_id = ? AND json_extract(format, '$.kind') = 'document' ORDER BY id").all(fixture.dm);
  assert.equal(uploads.length, 2);
  for (const [index, format] of ['avif', 'webp'].entries()) {
    const media = JSON.parse(uploads[index].format);
    assert.equal(media.mime, 'image/' + format);
    assert.equal(media.bytes, measurement[format].bytes);
    const chunks = fixture.db.prepare('SELECT content FROM message_document_chunks WHERE message_id = ? ORDER BY offset').all(uploads[index].id);
    const bytes = Buffer.concat(chunks.map(chunk => gunzipSync(chunk.content)));
    assert.equal(bytes.length, measurement[format].bytes);
    assert.equal(format === 'avif' ? bytes.toString('ascii', 4, 12) : bytes.toString('ascii', 8, 12),
      format === 'avif' ? 'ftypavif' : 'WEBP');
  }
  const chunk = `conversations/${fixture.dm}/messages/${uploads[0].id}/document?offset=0&encoding=gzip`;
  const loadChunk = `(async () => {
    const { apiFetch } = await import('./platform.js');
    const response = await apiFetch(${JSON.stringify(chunk)});
    return [response.status, (await response.arrayBuffer()).byteLength];
  })()`;
  const first = await evaluate(loadChunk);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(await evaluate(loadChunk), first);
  assert.equal(fixture.chunks.some(entry => entry.route.endsWith(chunk) && entry.status === 304), !browser);
  fixture.db.exec('UPDATE sessions SET expires = 0');
  assert.equal((await evaluate(loadChunk))[0], 401);
  await evaluate(`(() => {
    document.getElementById('draft').textContent = 'Session expiry probe';
    document.getElementById('composer').requestSubmit();
  })()`);
  await step('expired session returned to sign-in', `document.getElementById('app').hidden && !document.getElementById('welcome').hidden`);
  console.log(browser
    ? 'Browser fixture login, character switch, DM, server, two canonical uploads, and session expiry passed'
    : 'Desktop fixture login, character switch, DM, server, two canonical uploads, cache hit, and session expiry passed');
}

if (process.argv.includes('--device-fixture')) {
  const { startFixture } = await import('./horizon-fixture.mjs');
  const fixture = await startFixture();
  try {
    const { testDeviceReplicas } = await import('./device-replica-fixture.mjs');
    await testDeviceReplicas(run, until, fixture);
  } finally { await fixture.close(); }
} else if (process.argv.includes('--peer-fixture') || process.argv.includes('--hosted-fixture')) {
  const { startFixture } = await import('./horizon-fixture.mjs');
  const fixture = await startFixture();
  try {
    const { testPeers, testHosted } = await import('./distribution-fixture.mjs');
    if (process.argv.includes('--peer-fixture')) await testPeers(run, until, fixture);
    else await run(false, fixture, false, evaluate => testHosted(evaluate, until, fixture));
  } finally { await fixture.close(); }
} else if (process.argv.includes('--fixture') || process.argv.includes('--browser-fixture') || process.argv.includes('--recovery-fixture')) {
  const { startFixture } = await import('./horizon-fixture.mjs');
  const fixture = await startFixture();
  try { await run(false, fixture, process.argv.includes('--browser-fixture')); } finally { await fixture.close(); }
} else {
  await run(true);
  await run(false);
}
