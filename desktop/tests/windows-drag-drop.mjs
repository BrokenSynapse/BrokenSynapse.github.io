import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from './horizon-fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const executable = resolve(process.argv[2]);
const fixture = await startFixture();
const root = await mkdtemp(join(tmpdir(), 'horizon-drag-qa-'));
const request = async (route, data) => {
  const response = await fetch(fixture.base + route, {
    ...(data && { method: 'POST', body: JSON.stringify(data) }),
    headers: { Cookie: fixture.writer.cookie, 'X-Horizon-Chat': '1', 'Content-Type': 'application/json' },
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
const route = 'servers/' + fixture.serverId + '/channels';
let desktop;
let desktopBrowser;
let browser;
try {
  const a = await request(route, { name: 'Notes', kind: 'text', everyoneVisibility: 0, roleRules: [] });
  const b = await request(route, { name: 'Media', kind: 'text', everyoneVisibility: 0, roleRules: [] });
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(done => listener.close(done));
  desktop = spawn(executable, [], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(root, 'desktop'),
      HORIZON_FIXTURE_CONFIG: join(root, 'config'), HORIZON_FIXTURE_CACHE: join(root, 'cache'),
      HORIZON_FIXTURE_PORT: String(fixture.port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port },
  });
  let stderr = '';
  desktop.stderr.on('data', chunk => { stderr += chunk; });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.ok).catch(() => false);
    if (ok) break;
    await delay(200);
  }
  desktopBrowser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  const app = desktopBrowser.contexts()[0].pages()[0];
  browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-gpu'],
  });
  const web = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await web.goto('http://127.0.0.1:' + fixture.port + '/horizon-chat/');
  async function signIn(page, native) {
    const user = page.locator('#authentication input[name=username]');
    const pass = page.locator('#authentication input[name=password]');
    await user.waitFor();
    if (native) {
      await page.waitForFunction(() => document.querySelector('#authentication input[name=username]').autocomplete === 'off');
      assert.equal(await user.evaluate(el => el.spellcheck), false);
      assert.ok(await page.evaluate(() => [...document.styleSheets].some(sheet =>
        [...sheet.cssRules].some(rule => rule.selectorText === 'input[type="password"]::-ms-reveal' && rule.style.display === 'none'))));
    } else {
      assert.equal(await user.getAttribute('autocomplete'), 'username');
    }
    await user.fill('FixtureWriter');
    await pass.fill('horizon-fixture');
    await page.locator('#authentication [type=submit]').click();
    await page.locator('[data-server="' + fixture.serverId + '"]').click();
    await page.locator('[data-channel-id="' + a.channelId + '"]').waitFor();
  }
  const aSelector = '[data-channel-id="' + a.channelId + '"]';
  const bSelector = '[data-channel-id="' + b.channelId + '"]';
  async function order(page, from, to) {
    const source = page.locator(from + ' .channel-name');
    const target = page.locator(to + ' .channel-name');
    await source.dragTo(target, { targetPosition: { x: 18, y: 2 } });
    await page.waitForFunction(([source, target]) =>
      Boolean(document.querySelector(source)?.compareDocumentPosition(document.querySelector(target)) & Node.DOCUMENT_POSITION_FOLLOWING), [from, to]);
  }
  async function drop(page, filename) {
    await page.locator('.channel-row .channel-name').first().click();
    await page.locator('#composer').waitFor();
    const data = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ba70e0'; ctx.fillRect(0, 0, 16, 16);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const file = join(root, filename);
    await writeFile(file, Buffer.from(data, 'base64'));
    const box = await page.locator('#draft').boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const session = await page.context().newCDPSession(page);
    const payload = { items: [], files: [file], dragOperationsMask: 1 };
    try {
      for (const type of ['dragEnter','dragOver']) await session.send('Input.dispatchDragEvent', { type, x, y, data: payload });
      await page.locator('.chat-drop-ready').waitFor();
      await session.send('Input.dispatchDragEvent', { type: 'drop', x, y, data: payload });
      await page.locator('.draft-attachment[aria-label="' + filename + '"]').waitFor();
      assert.equal(await page.locator('.chat-drop-ready').count(), 0);
    } finally { await session.detach(); }
  }
  await signIn(app, true);
  await order(app, bSelector, aSelector);
  const channels = (await request('conversations')).servers.find(s => s.id === fixture.serverId).channels;
  assert.ok(channels.findIndex(c => c.id === b.channelId) < channels.findIndex(c => c.id === a.channelId));
  await drop(app, 'desktop-drop.png');
  assert.doesNotMatch(stderr, /Could not configure WebView input controls/);
  await signIn(web, false);
  await order(web, aSelector, bSelector);
  await drop(web, 'browser-drop.png');
  console.log('Packaged WebView and Edge: real pointer channel reordering and file drop to chat passed. Desktop credential controls verified.');
} finally {
  await browser?.close();
  await desktopBrowser?.close();
  if (desktop && desktop.exitCode === null) {
    const done = once(desktop, 'exit');
    desktop.kill();
    await done;
  }
  await fixture.close();
  await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
}