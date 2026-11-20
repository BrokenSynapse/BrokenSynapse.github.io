import { decodeServerBackground } from './server-background.mjs';
import { createHash } from 'node:crypto';

export const mediaPath = '/horizon-chat/api/profile-media/';

export function createProfileMedia(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_media (
      id TEXT PRIMARY KEY,
      body BLOB NOT NULL,
      mime TEXT NOT NULL DEFAULT 'image/webp'
    )
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('profile_media') WHERE name = 'mime'").get()) {
    db.exec("ALTER TABLE profile_media ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/webp'");
  }
  const save = db.prepare('INSERT OR IGNORE INTO profile_media(id, body, mime) VALUES (?, ?, ?)');
  const load = db.prepare('SELECT body, mime FROM profile_media WHERE id = ?');

  function decode(value) {
    if (value === '') return null;
    const prefix = 'data:image/webp;base64,';
    if (typeof value !== 'string' || value.length > 300_000 || !value.startsWith(prefix)) {
      throw new Error('Choose an avatar or banner under the image size limit.');
    }
    const body = Buffer.from(value.slice(prefix.length), 'base64');
    if (body.length < 16 || body.toString('ascii', 0, 4) !== 'RIFF' ||
        body.toString('ascii', 8, 12) !== 'WEBP' || body.readUInt32LE(4) !== body.length - 8) {
      throw new Error('Choose a valid image.');
    }
    return { body, mime: 'image/webp' };
  }

  return {
    update(data, existing, { serverBackground = false } = {}) {
      const fields = [['avatar', 'avatarUrl'], ['banner', 'bannerUrl']];
      try {
        const changes = fields.map(([key, field]) => ({
          field,
          image: data[key] === undefined ? undefined
            : key === 'banner' && serverBackground ? decodeServerBackground(data[key]) : decode(data[key]),
        }));
        return Object.fromEntries(changes.map(({ field, image }) => {
          if (image === undefined) return [field, existing[field] || ''];
          if (!image) return [field, ''];
          const { body, mime } = image;
          const id = createHash('sha256').update(body).digest('hex');
          save.run(id, body, mime);
          return [field, mediaPath + id];
        }));
      } catch (error) {
        if (error.code) throw error;
        return { error: error.message };
      }
    },
    serve(id, response) {
      if (!/^[a-f0-9]{64}$/.test(id)) return false;
      const image = load.get(id);
      if (!image) return false;
      response.writeHead(200, {
        'Content-Type': image.mime,
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      }).end(image.body);
      return true;
    },
  };
}
