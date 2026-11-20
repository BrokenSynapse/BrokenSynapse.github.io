import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { startFixture } from './horizon-fixture.mjs';
import { createArchive, newRecoveryKey } from '../../site/horizon-chat/recovery-archive.js';

const fixture = await startFixture();
try {
  const key = newRecoveryKey();
  const cookie = fixture.writer.cookie;
  const headers = { Cookie: cookie, 'X-Horizon-Chat': '1' };
  const snapshot = await (await fetch(fixture.base + 'recovery-archive/export', { headers })).json();
  const tagsFor = bytes => [createHash('sha256').update(bytes).digest('hex')];
  const post = async (route, body, binary = false) => {
    const response = await fetch(fixture.base + 'hosted-archives/' + route, {
      method: 'POST', headers: { ...headers, 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ? body : JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Sandbox archive seeding failed: ' + response.status);
    return response.json();
  };
  async function publish(archive, label) {
    const bytes = Buffer.from(await archive.file.arrayBuffer());
    const { id } = await post('begin', { archive: archive.manifest.id, parent: archive.manifest.parent,
      version: 1, size: bytes.length, label, tags: tagsFor(bytes) });
    await post(id + '/block/0', bytes, true);
    await post(id + '/finish', {});
  }
  const full = await createArchive(snapshot, key);
  await publish(full, 'sandbox-full.hca');
  const delta = await createArchive({ ...snapshot, characters: snapshot.characters.map(character => ({
    ...character, name: 'Recovered Sandbox Character', description: 'Restored from the sample incremental.',
  })) }, key, { parent: { manifest: full.manifest, assets: new Map() } });
  await publish(delta, 'sandbox-incremental.hca');
  await writeFile(process.argv[2], JSON.stringify({ port: fixture.port, username: 'FixtureWriter',
    password: 'horizon-fixture', recoveryKey: key }, null, 2) + '\n', { flag: 'wx' });
  setTimeout(() => void fixture.close(), 8 * 60 * 60 * 1000).unref();
} catch (error) {
  await fixture.close();
  throw error;
}
