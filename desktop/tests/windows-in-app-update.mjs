import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

const exe = resolve(process.argv[2]);
const source = await readFile(exe);
const archive = gzipSync(source);
const expected = createHash('sha256').update(archive).digest('hex');

async function until(read) {
  for (let index = 0; index < 150; index++) {
    const value = await read().catch(() => null);
    if (value) return value;
    await delay(200);
  }
  throw new Error('Timed out waiting for Windows Horizon');
}

async function connect(port, previous) {
  const page = await until(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    return (await response.json()).find(tab => tab.type === 'page' && tab.url.startsWith('http://tauri.localhost/') && tab.id !== previous);
  });
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  let serial = 0;
  const phases = new Set();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.bindingCalled' && message.params.name === 'qaPhase') phases.add(message.params.payload);
  });
  function call(method, params = {}) {
    const id = ++serial;
    return new Promise((done, fail) => {
      const listener = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        socket.removeEventListener('message', listener);
        if (message.error || message.result?.exceptionDetails) fail(new Error(JSON.stringify(message)));
        else done(message.result);
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    id: page.id, phases, call, close: () => socket.close(),
    async evaluate(expression) {
      return (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    },
  };
}

const root = await mkdtemp(join(tmpdir(), 'horizon-update-qa-'));
const fixture = createServer((request, response) => {
  if (request.url === '/update.exe.gz') {
    response.writeHead(200, { 'Content-Length': archive.length, 'Content-Type': 'application/gzip' }).end(archive);
  } else {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"account":null}');
  }
}).listen(0, '127.0.0.1');
await once(fixture, 'listening');

async function test(label, digest, successful) {
  const dir = join(root, label);
  await mkdir(dir);
  const target = join(dir, 'horizon-chat-desktop.exe');
  await copyFile(exe, target);
  await appendFile(target, 'ORIGINAL FIXTURE MARKER');
  const old = await readFile(target);
  await writeFile(join(dir, 'update-qa.marker'), '');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(done => reservation.close(done));
  const fixturePort = String(fixture.address().port);
  const child = spawn(target, {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HORIZON_FIXTURE_PORT: fixturePort, HORIZON_FIXTURE_UPDATE_PORT: fixturePort,
      HORIZON_FIXTURE_CONFIG: join(dir, 'config'), HORIZON_FIXTURE_CACHE: join(dir, 'cache'),
      HORIZON_FIXTURE_UPDATE_FOLDER: join(dir, 'updates'),
      HORIZON_FIXTURE_RELEASES: JSON.stringify([{ tag_name: 'horizon-v0.6.3', draft: false, prerelease: false, assets: [{
        name: 'Horizon-Chat-0.6.3-Windows-x64-Update.exe.gz', state: 'uploaded', size: archive.length, digest: 'sha256:' + digest,
      }] }]),
      WEBVIEW2_USER_DATA_FOLDER: join(dir, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
    },
  });
  const exited = once(child, 'exit');
  let before;
  let after;
  try {
    before = await connect(port);
    await before.call('Runtime.enable');
    await before.call('Runtime.addBinding', { name: 'qaPhase' });
    await until(() => before.evaluate("document.querySelector('.horizon-window-update')?.hidden === false"));
    const panel = await before.evaluate("(function(){window.alert=message=>window.qaError=message;addEventListener('horizon-update-progress',event=>qaPhase(event.detail.phase));document.querySelector('.horizon-window-update').click();return !document.querySelector('#horizon-update-panel').hidden;})()");
    assert.ok(panel, 'The branded progress panel did not open');
    if (!successful) {
      assert.match(await until(() => before.evaluate('window.qaError')), /failed verification/);
      assert.ok((await readFile(target)).equals(old));
      assert.equal(child.exitCode, null);
      assert.deepEqual([...before.phases], ['download']);
      return;
    }
    await Promise.race([exited, delay(30_000).then(() => { throw new Error('App did not exit for the update'); })]);
    after = await connect(port, before.id);
    await until(() => after.evaluate("Boolean(document.querySelector('#horizon-window-chrome'))"));
    assert.ok((await readFile(target)).equals(source), 'Verified executable was not installed');
    assert.deepEqual([...before.phases], ['download', 'unpack', 'restart']);
    await after.evaluate("void window.__TAURI_INTERNALS__.invoke('desktop_window_action',{action:'close'});true").catch(() => {});
  } finally {
    if (child.exitCode === null) child.kill();
    before?.close();
    after?.close();
  }
}

try {
  await test('invalid-digest', 'a'.repeat(64), false);
  await test('valid-update', expected, true);
  console.log('Windows updater verified corrupt-download rejection, download and unpack phases, file replacement, and restart.');
} finally {
  fixture.closeAllConnections();
  await new Promise(done => fixture.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
}