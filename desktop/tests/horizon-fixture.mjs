import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createMessenger } from '../../horizon-chat/messenger.mjs';

const site = fileURLToPath(new URL('../../site/horizon-chat/', import.meta.url));
const contentType = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

export async function startFixture() {
  const db = new DatabaseSync(':memory:');
  const parent = resolve(tmpdir());
  const storage = await mkdtemp(join(parent, 'horizon-hosted-fixture-'));
  assert.equal(dirname(storage), parent);
  const previous = process.env.HORIZON_ARCHIVE_STORE;
  const previousPeers = process.env.HORIZON_ATTACHMENT_PEERS;
  const previousTrusted = process.env.HORIZON_TRUSTED_DEVICES;
  process.env.HORIZON_ARCHIVE_STORE = storage;
  process.env.HORIZON_ATTACHMENT_PEERS = '1';
  process.env.HORIZON_TRUSTED_DEVICES = '1';
  const handler = createMessenger(db, { secure: false, json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  } });
  if (previous === undefined) delete process.env.HORIZON_ARCHIVE_STORE;
  else process.env.HORIZON_ARCHIVE_STORE = previous;
  if (previousPeers === undefined) delete process.env.HORIZON_ATTACHMENT_PEERS;
  else process.env.HORIZON_ATTACHMENT_PEERS = previousPeers;
  if (previousTrusted === undefined) delete process.env.HORIZON_TRUSTED_DEVICES;
  else process.env.HORIZON_TRUSTED_DEVICES = previousTrusted;
  const chunks = [];
  const traffic = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/horizon-chat/api/')) {
      try {
        const asset = resolve(site, decodeURIComponent(url.pathname.slice('/horizon-chat/'.length)) || 'index.html');
        const path = relative(site, asset);
        if (!url.pathname.startsWith('/horizon-chat/') || path.startsWith('..') || isAbsolute(path)) {
          return response.writeHead(404).end();
        }
        const bytes = await readFile(asset);
        response.writeHead(200, { 'Content-Type': contentType[extname(asset)] ?? 'application/octet-stream' }).end(bytes);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    if (url.pathname.endsWith('/document')) {
      response.on('finish', () => chunks.push({ route: request.url, status: response.statusCode }));
    }
    if (url.pathname.endsWith('/document') || url.pathname.includes('/peers/')) {
      let sent = 0;
      const end = response.end;
      response.end = function (data, ...args) {
        sent += typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength || 0;
        return end.call(this, data, ...args);
      };
      response.once('finish', () => traffic.push({ route: url.pathname, status: response.statusCode,
        sent, received: Number(request.headers['content-length']) || 0 }));
    }
    void handler(request, response, url).catch(error => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/horizon-chat/api/`;
  async function post(route, data, cookie) {
    const response = await fetch(base + route, { method: 'POST',
      headers: { 'X-Horizon-Chat': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(data),
    });
    assert.ok(response.ok, await response.clone().text());
    return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const writer = await post('register', { username: 'FixtureWriter', displayName: 'Fixture Writer', tag: 'W111', password: 'horizon-fixture' });
  const reader = await post('register', { username: 'FixtureReader', displayName: 'Fixture Reader', tag: 'R111', password: 'horizon-fixture' });
  const { data: { proxy } } = await post('proxies', {
    name: 'Fixture Character', prefix: 'fc:', suffix: '', group: '', designation: 'F123', description: '',
  }, writer.cookie);
  const { data: { server: world } } = await post('servers', { name: 'Fixture Server' }, writer.cookie);
  const { data: { id: dm } } = await post('conversations', { handle: 'Fixture Reader#R111' }, writer.cookie);
  await post(`conversations/${dm}/messages`, { body: 'Fixture DM ready' }, writer.cookie);
  return { port, proxy: proxy.id, serverId: world.id, dm, chunks, traffic, db, storage, base, writer, reader,
    async seedAttachment() {
      const payload = randomBytes(768 * 1024);
      const metadata = Buffer.from(JSON.stringify({ body: 'Peer fixture attachment' }));
      const reply = await fetch(base + 'conversations/' + dm + '/messages', {
        method: 'POST', headers: { Cookie: writer.cookie, 'X-Horizon-Chat': '1', 'Content-Type': 'application/octet-stream',
          'X-Horizon-Filename': 'peer-fixture.bin', 'X-Horizon-Message-Bytes': String(metadata.length) },
        body: Buffer.concat([metadata, payload]),
      });
      assert.equal(reply.status, 201, await reply.clone().text());
      return { payload, id: db.prepare('SELECT max(id) AS id FROM direct_messages').get().id };
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      db.close();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
