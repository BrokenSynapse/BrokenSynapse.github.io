import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const random = bytes => randomBytes(bytes).toString('hex');
const leaseDuration = 5 * 60_000;
const pendingDuration = 24 * 60 * 60_000;

export function createTrustedDevices(db, { json, readJson, hostedArchives, verifyPassword,
  enabled = process.env.HORIZON_TRUSTED_DEVICES === '1' && Boolean(process.env.HORIZON_ARCHIVE_STORE) }) {
  if (!enabled) return (_request, response) => json(response, 404, { error: 'Trusted devices are disabled.' });
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_devices (
      id TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES accounts(id),
      label TEXT NOT NULL, public_key TEXT NOT NULL, code_hash TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'revoked')),
      created INTEGER NOT NULL, last_seen INTEGER
    );
    CREATE INDEX IF NOT EXISTS recovery_devices_owner ON recovery_devices(owner);
    CREATE TABLE IF NOT EXISTS recovery_device_replicas (
      device TEXT NOT NULL REFERENCES recovery_devices(id) ON DELETE CASCADE,
      archive TEXT NOT NULL REFERENCES hosted_archives(id) ON DELETE CASCADE,
      verified INTEGER NOT NULL, PRIMARY KEY(device, archive)
    );
  `);
  const lookup = db.prepare('SELECT * FROM recovery_devices WHERE owner=? AND id=?');
  const list = db.prepare(`SELECT d.id,d.label,d.state,d.created,d.last_seen AS lastSeen,
    (SELECT count(*) FROM recovery_device_replicas r WHERE r.device=d.id) AS replicas
    FROM recovery_devices d WHERE owner=? ORDER BY created DESC`);
  const count = db.prepare("SELECT count(*) AS count FROM recovery_devices WHERE owner=? AND state<>'revoked'");
  const isBootstrapped = db.prepare("SELECT 1 FROM recovery_devices WHERE owner=? AND state='approved' LIMIT 1");
  const add = db.prepare("INSERT INTO recovery_devices VALUES(?,?,?,?,?,'pending',?,NULL)");
  const approve = db.prepare("UPDATE recovery_devices SET state='approved',code_hash=NULL WHERE owner=? AND id=? AND state='pending'");
  const markSeen = db.prepare("UPDATE recovery_devices SET last_seen=? WHERE id=?");
  const revoke = db.prepare("UPDATE recovery_devices SET state='revoked',code_hash=NULL WHERE owner=? AND id=? AND state<>'revoked'");
  const purge = db.prepare("DELETE FROM recovery_devices WHERE owner=? AND state='pending' AND created<?");
  const clearReplicas = db.prepare('DELETE FROM recovery_device_replicas WHERE device=?');
  const findArchive = db.prepare('SELECT digest FROM hosted_archives WHERE owner=? AND id=?');
  const addReplica = db.prepare('INSERT OR REPLACE INTO recovery_device_replicas VALUES(?,?,?)');
  const challenges = new Map();
  const leases = new Map();
  const guesses = new Map();

  function validLease(request, owner, session) {
    const raw = request.headers['x-horizon-device'];
    const lease = typeof raw === 'string' && tokenPattern.test(raw) && leases.get(digest(raw));
    if (!lease || lease.owner !== owner || lease.session !== session || lease.expiry <= Date.now() ||
        lookup.get(owner, lease.id)?.state !== 'approved') return null;
    return lease;
  }

  function proof(input, owner, session) {
    if (typeof input?.challenge !== 'string' || !tokenPattern.test(input.challenge) ||
        typeof input?.signature !== 'string' || !/^[a-f0-9]{128}$/.test(input.signature)) return null;
    const value = challenges.get(input.challenge);
    if (!value || value.owner !== owner || value.session !== session || value.expiry <= Date.now()) return null;
    challenges.delete(input.challenge);
    const device = lookup.get(owner, value.id);
    if (!device || device.state === 'revoked') return null;
    try {
      if (!verify('sha256', Buffer.from('Horizon device v1:' + input.challenge),
        { key: createPublicKey({ key: Buffer.from(device.public_key, 'base64'), type: 'spki', format: 'der' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(input.signature, 'hex'))) return null;
      return device;
    } catch { return null; }
  }

  return async function trustedDevices(request, response, route, account, session) {
    const owner = account.id;
    const now = Date.now();
    const error = (status, message) => json(response, status, { error: message });
    purge.run(owner, now - pendingDuration);
    for (const map of [challenges, leases, guesses]) {
      for (const [key, value] of map) if (value.expiry <= now) map.delete(key);
    }
    if (route === '' && request.method === 'GET') {
      return json(response, 200, { devices: list.all(owner), bootstrap: !isBootstrapped.get(owner) });
    }
    if (request.method === 'GET' && (route === '/replica' || /^\/replica\/[a-f0-9-]{36}\/(?:manifest|block\/[0-9]{1,5})$/.test(route))) {
      const device = validLease(request, owner, session);
      if (!device) return error(403, 'An approved device is required.');
      if (route === '/replica') markSeen.run(now, device.id);
      return hostedArchives(request, response, route.slice('/replica'.length), owner);
    }
    if (request.method !== 'POST') return error(404, 'Device route unavailable.');
    const input = await readJson(request, 4096);
    if (!input) return error(400, 'Invalid device request.');
    if (route === '/register') {
      if (typeof input.id !== 'string' || !uuid.test(input.id) || typeof input.label !== 'string' ||
          !input.label.trim() || input.label.length > 64 || /[\x00-\x1f\x7f]/.test(input.label) ||
          typeof input.publicKey !== 'string' || !/^[A-Za-z0-9+/]{120,130}={0,2}$/.test(input.publicKey)) {
        return error(400, 'Enter a valid device name and key.');
      }
      try {
        const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64'), type: 'spki', format: 'der' });
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
      } catch { return error(400, 'The device key is invalid.'); }
      const existing = lookup.get(owner, input.id);
      if (existing) return error(409, 'This device is already registered.');
      if (count.get(owner).count >= 12) return error(429, 'Remove an unused device before adding another.');
      const code = random(5);
      try { add.run(input.id, owner, input.label.trim(), input.publicKey, digest(code), now); }
      catch (failure) {
        if (failure.errcode === 1555) return error(409, 'This device ID is unavailable.');
        throw failure;
      }
      return json(response, 201, { code });
    }
    if (route === '/challenge') {
      if (typeof input.id !== 'string' || !uuid.test(input.id) ||
          !['approved', 'pending'].includes(lookup.get(owner, input.id)?.state)) return error(403, 'Device is unavailable.');
      if (challenges.size >= 512) return error(429, 'Device verification is busy. Try again shortly.');
      const challenge = random(32);
      challenges.set(challenge, { id: input.id, owner, session, expiry: now + 60_000 });
      return json(response, 200, { challenge });
    }
    if (route === '/lease' || route === '/bootstrap') {
      const device = proof(input, owner, session);
      if (!device) return error(403, 'Device proof failed.');
      if (route === '/bootstrap') {
        if (device.state !== 'pending' || isBootstrapped.get(owner)) return error(409, 'Approve this device from an existing trusted device.');
        if (!await verifyPassword(request, account, input.password, session)) return error(403, 'Current password could not be verified.');
        if (isBootstrapped.get(owner) || !approve.run(owner, device.id).changes) return error(409, 'Device approval state changed.');
        return json(response, 200, { approved: true });
      }
      if (device.state !== 'approved') return error(403, 'An approved device is required.');
      if (leases.size >= 512) return error(429, 'Device verification is busy. Try again shortly.');
      for (const [key, entry] of leases) if (entry.id === device.id && entry.session === session) leases.delete(key);
      const lease = random(32);
      const expiry = now + leaseDuration;
      leases.set(digest(lease), { id: device.id, owner, session, expiry });
      markSeen.run(now, device.id);
      return json(response, 200, { lease, expiry });
    }
    const actor = validLease(request, owner, session);
    if (!actor) return error(403, 'An approved device is required.');
    if (route === '/replica/receipt') {
      if (typeof input.id !== 'string' || !uuid.test(input.id) || typeof input.hash !== 'string' ||
          !tokenPattern.test(input.hash) || findArchive.get(owner, input.id)?.digest !== input.hash) {
        return error(404, 'Hosted archive is unavailable.');
      }
      addReplica.run(actor.id, input.id, now);
      return json(response, 200, { recorded: true });
    }
    const target = typeof input.id === 'string' && uuid.test(input.id) && lookup.get(owner, input.id);
    if (!target) return error(404, 'Device is unavailable.');
    if (route === '/approve') {
      if (target.state !== 'pending' || typeof input.code !== 'string' || !/^[a-f0-9]{10}$/i.test(input.code)) return error(400, 'Enter the approval code shown on that device.');
      const history = guesses.get(target.id) ?? { count: 0, expiry: now + 10 * 60_000 };
      if (history.count >= 8) return error(429, 'Too many approval attempts.');
      history.count++;
      guesses.set(target.id, history);
      if (!timingSafeEqual(Buffer.from(target.code_hash, 'hex'), Buffer.from(digest(input.code.toLowerCase()), 'hex'))) return error(403, 'The approval code did not match.');
      approve.run(owner, target.id);
      guesses.delete(target.id);
      return json(response, 200, { approved: true });
    }
    if (route === '/revoke') {
      revoke.run(owner, target.id);
      clearReplicas.run(target.id);
      for (const [key, lease] of leases) if (lease.id === target.id) leases.delete(key);
      return json(response, 200, { revoked: true });
    }
    return error(404, 'Device route unavailable.');
  };
}
