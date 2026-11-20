import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createHostedArchives } from './hosted-archives.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const block = 1024 * 1024;

test('hosted ciphertext is resumable, owner-scoped and protects incremental parents', async () => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'horizon-hosted-test-'));
  assert.equal(dirname(directory), parent);
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE accounts(id INTEGER PRIMARY KEY); INSERT INTO accounts VALUES(1),(2)');
  try {
    const host = createHostedArchives(db, {
      directory,
      readJson: async request => request.body,
      readBody: async request => request.body,
      json(response, status, data) { response.status = status; response.data = data; },
    });
    async function call(route, body, owner = 1) {
      const response = {
        writeHead(status) { this.status = status; return this; },
        end(data) { this.data = data; },
      };
      await host({ method: body === undefined ? 'GET' : 'POST', body }, response, route, owner);
      return response;
    }
    function archive(size, previous = null) {
      const id = randomBytes(16);
      const bytes = randomBytes(size);
      Buffer.from('HORIZHCA').copy(bytes);
      bytes[8] = 1;
      id.copy(bytes, 9);
      return { bytes, manifest: { archive: id.toString('hex'), parent: previous, version: 1, size,
        label: 'fixture.hca', tags: [sha(bytes.subarray(0, block)), ...(size > block ? [sha(bytes.subarray(block))] : [])] } };
    }
    const full = archive(block + 199);
    const start = await call('/begin', full.manifest);
    assert.equal(start.status, 201);
    const id = '/' + start.data.id;
    assert.equal((await call(id + '/block/1', full.bytes.subarray(block))).status, 409);
    assert.equal((await call(id + '/block/0', Buffer.alloc(block))).status, 400);
    assert.equal((await call(id + '/block/0', full.bytes.subarray(0, block))).status, 200);
    assert.equal((await call('/begin', full.manifest)).data.uploaded, block);
    assert.equal((await call(id + '/finish', {})).status, 409);
    assert.equal((await call(id + '/block/1', full.bytes.subarray(block))).status, 200);
    const complete = await call(id + '/finish', {});
    assert.equal(complete.data.hash, sha(full.bytes));
    assert.equal((await call(id + '/manifest', undefined, 2)).status, 404);
    assert.deepEqual((await call(id + '/block/1')).data, full.bytes.subarray(block));
    const delta = archive(128, full.manifest.archive);
    const child = await call('/begin', delta.manifest);
    assert.equal(child.status, 201);
    assert.equal((await call(id + '/delete', {})).status, 409);
    assert.equal((await call('/settings', { limitMiB: 0, days: 1 })).status, 200);
    assert.equal((await call('/begin', archive(128).manifest)).status, 413);
    await writeFile(join(directory, start.data.id + '.hca'), Buffer.alloc(full.bytes.length));
    assert.equal((await call(id + '/block/0')).status, 409);
    assert.equal((await call('/' + child.data.id + '/delete', {})).status, 200);
    assert.equal((await call(id + '/delete', {})).status, 200);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
