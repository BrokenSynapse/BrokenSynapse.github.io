import { DatabaseSync } from 'node:sqlite';

const username = process.argv[2];
if (!username || !/^[a-z0-9_]{3,24}:[a-z0-9]{4}$/i.test(username) || !process.env.HORIZON_DB) {
  console.error('Usage: node /app/set-platform-owner.mjs <sign-in-username:TAG> (with HORIZON_DB set)');
  process.exit(1);
}

const db = new DatabaseSync(process.env.HORIZON_DB);
db.exec('PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE');
try {
  const target = db.prepare('SELECT id, display_name AS displayName, public_tag AS publicTag FROM accounts WHERE username = ?').get(username);
  if (!target) throw new Error('Account not found.');
  const channel = db.prepare('SELECT 1 FROM broadcast_channel WHERE singleton = 1').get();
  if (!channel) throw new Error('Start Horizon Chat once with the broadcast feature enabled before transferring ownership.');
  const updated = db.prepare('UPDATE platform_owner SET account_id = ? WHERE singleton = 1').run(target.id);
  if (updated.changes !== 1) throw new Error('The platform owner assignment is missing.');
  db.exec('COMMIT');
  console.log('Platform owner is now ' + target.displayName + '#' + target.publicTag + '.');
} catch (error) {
  db.exec('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
