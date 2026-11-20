import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzip, gunzipSync } from 'node:zlib';

export const fileLimit = 10 * 1024 * 1024;
const chunkSize = 16_384;
const binaryBatch = 16;
const compress = promisify(gzip);

export async function packDocument(file) {
  const chunkBytes = file.mime ? chunkSize * binaryBatch : chunkSize;
  const parts = [];
  for (let offset = 0; offset < file.body.length; offset += chunkBytes) {
    const raw = file.body.subarray(offset, offset + chunkBytes);
    const packed = await compress(raw, { level: 9 });
    parts.push({ offset, content: packed, gzip: 1 });
  }
  return { chunkBytes, parts };
}
const extensions = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', rs: 'rust', cs: 'csharp',
  rb: 'ruby', md: 'markdown', hs: 'haskell', yml: 'yaml', txt: 'plaintext',
};
const preferredExtensions = {
  javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', rust: 'rs',
  csharp: 'cs', ruby: 'rb', markdown: 'md', haskell: 'hs', plaintext: 'txt',
};

export function readFileInfo(request) {
  let name;
  try {
    name = decodeURIComponent(request.headers['x-horizon-filename'] || '');
  } catch {
    return null;
  }
  if (!name || name.length > 150 || /[\/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') return null;
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  const language = extensions[extension] || (/^[a-z0-9-]{1,24}$/.test(extension) ? extension : 'plaintext');
  return { name, language };
}

export function documentInfo(body, language = 'plaintext') {
  return { body: Buffer.from(body, 'utf8'), name: 'message.' + (preferredExtensions[language] || language), language };
}

export function fileType(body, thumbnailHeader, name = '') {
  const head = body.toString('ascii', 0, 12);
  let mime;
  if (body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
  else if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) mime = 'image/jpeg';
  else if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) mime = 'image/gif';
  else if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') mime = 'image/webp';
  else if (head.slice(4, 12) === 'ftypavif' || head.slice(4, 12) === 'ftypavis') mime = 'image/avif';
  const extension = name.split('.').at(-1).toLowerCase();
  if (!mime && head.startsWith('RIFF') && head.slice(8) === 'WAVE') mime = 'audio/wav';
  if (!mime && head.startsWith('fLaC')) mime = 'audio/flac';
  if (!mime && head.startsWith('OggS')) mime = extension === 'ogv' ? 'video/ogg' : 'audio/ogg';
  if (!mime && head.slice(4, 8) === 'ftyp') {
    mime = ['m4a', 'm4b'].includes(extension) ? 'audio/mp4'
      : extension === 'mov' ? 'video/quicktime' : 'video/mp4';
  }
  if (!mime && body.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) && ['webm', 'weba'].includes(extension)) {
    mime = extension === 'weba' ? 'audio/webm' : 'video/webm';
  }
  if (!mime && extension === 'mp3' && (head.startsWith('ID3') || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0))) {
    mime = 'audio/mpeg';
  }
  if (!mime && extension === 'aac' && body[0] === 0xff && (body[1] & 0xf6) === 0xf0) mime = 'audio/aac';
  if (mime) {
    const thumbnail = typeof thumbnailHeader === 'string' && thumbnailHeader.length <= 6500
      ? Buffer.from(thumbnailHeader, 'base64') : null;
    const valid = thumbnail?.length >= 16 && thumbnail.toString('ascii', 0, 4) === 'RIFF' &&
      thumbnail.toString('ascii', 8, 12) === 'WEBP' && thumbnail.readUInt32LE(4) === thumbnail.length - 8;
    return { mime, thumbnail: valid && !mime.startsWith('audio/') ? thumbnail : null };
  }
  if (!body.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(body);
      return {};
    } catch {
      // Non-UTF-8 files are downloadable as bytes.
    }
  }
  return { mime: 'application/octet-stream' };
}

export async function compressStoredDocuments(db) {
  const next = db.prepare(`
    SELECT message_id AS id, offset, content FROM message_document_chunks
    WHERE gzip = 0 AND (message_id, offset) > (?, ?)
    ORDER BY message_id, offset LIMIT 8
  `);
  const update = db.prepare(`
    UPDATE message_document_chunks SET content = ?, gzip = 1
    WHERE message_id = ? AND offset = ? AND gzip = 0
  `);
  let id = 0;
  let offset = -1;
  for (;;) {
    const rows = next.all(id, offset);
    if (!rows.length) return;
    const blobs = await Promise.all(rows.map(row => compress(row.content, { level: 9 })));
    db.exec('BEGIN IMMEDIATE');
    try {
      rows.forEach((row, index) => update.run(blobs[index], row.id, row.offset));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    ({ id, offset } = rows.at(-1));
  }
}

export function createDocuments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_document_chunks (
      message_id INTEGER NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
      offset INTEGER NOT NULL,
      content BLOB NOT NULL,
      PRIMARY KEY (message_id, offset)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_document_thumbnails (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      content BLOB NOT NULL
    )
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('message_document_chunks') WHERE name = 'gzip'").get()) {
    db.exec('ALTER TABLE message_document_chunks ADD COLUMN gzip INTEGER NOT NULL DEFAULT 0');
  }
  const save = db.prepare('INSERT INTO message_document_chunks(message_id, offset, content, gzip) VALUES (?, ?, ?, ?)');
  const saveThumbnail = db.prepare('INSERT INTO message_document_thumbnails VALUES (?, ?)');
  const metadata = db.prepare(`
    SELECT json_extract(format, '$.bytes') AS total, json_extract(format, '$.mime') AS mime,
           json_extract(format, '$.chunkBytes') AS chunkBytes
    FROM direct_messages WHERE conversation_id = ? AND id = ? AND json_extract(format, '$.kind') = 'document'
  `);
  const chunks = db.prepare(`
    SELECT content, gzip FROM message_document_chunks WHERE message_id = ? AND offset >= ? ORDER BY offset LIMIT ?
  `);
  const thumbnail = db.prepare(`
    SELECT t.content FROM message_document_thumbnails t JOIN direct_messages m ON m.id = t.message_id
    WHERE m.conversation_id = ? AND t.message_id = ?
  `);
  const deleteChunks = db.prepare('DELETE FROM message_document_chunks WHERE message_id = ?');
  const deleteThumbnail = db.prepare('DELETE FROM message_document_thumbnails WHERE message_id = ?');
  const allChunks = db.prepare('SELECT content, gzip FROM message_document_chunks WHERE message_id = ? ORDER BY offset');
  return {
    remove(messageId) {
      deleteChunks.run(messageId);
      deleteThumbnail.run(messageId);
    },
    readText(messageId) {
      return Buffer.concat(allChunks.all(messageId).map(part =>
        part.gzip ? gunzipSync(part.content) : part.content)).toString('utf8');
    },
    save(messageId, parts, preview) {
      for (const part of parts) save.run(messageId, part.offset, part.content, part.gzip);
      if (preview) saveThumbnail.run(messageId, preview);
    },
    thumbnail(conversationId, id, response) {
      const row = thumbnail.get(conversationId, id);
      if (!row) return false;
      response.writeHead(200, {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      }).end(row.content);
      return true;
    },
    peerChunk(conversation, message, offset) {
      const row = metadata.get(conversation, message);
      if (!row || row.total < 512 * 1024 || offset >= row.total || offset % (row.chunkBytes || chunkSize)) return null;
      const data = chunks.all(message, offset, !row.chunkBytes && row.mime ? binaryBatch : 1);
      if (!data.length || data.some(part => !part.gzip)) return null;
      const bytes = Buffer.concat(data.map(part => part.content));
      if (bytes.length < 64 * 1024 || bytes.length > 320 * 1024) return null;
      return { hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    serve(conversationId, id, offset, acceptsGzip, response, clientDecodes = false, cacheTag, cacheOnly = false) {
      const row = metadata.get(conversationId, id);
      if (!row) return false;
      const valid = offset < row.total && offset % (row.chunkBytes || chunkSize) === 0;
      const data = valid ? chunks.all(id, offset, !row.chunkBytes && row.mime ? binaryBatch : 1) : [];
      const storedGzip = data.length > 0 && data.every(part => part.gzip);
      if (clientDecodes && data.length && !storedGzip) {
        response.writeHead(503, { 'Cache-Control': 'no-store' }).end();
        return true;
      }
      const encoded = storedGzip && (acceptsGzip || clientDecodes);
      const content = encoded ? Buffer.concat(data.map(part => part.content))
        : Buffer.concat(data.map(part => part.gzip ? gunzipSync(part.content) : part.content));
      // The caller has already authorized the current account and conversation.
      const tag = clientDecodes && data.length && typeof cacheTag === 'string'
        ? '"hc-' + createHash('sha256').update(content).digest('hex') + '"' : null;
      if (tag && cacheTag === tag) {
        response.writeHead(304, {
          'Cache-Control': 'private, no-store', ETag: tag, 'X-Document-Size': String(row.total),
        }).end();
        return true;
      }
      if (cacheOnly) {
        response.writeHead(412, { 'Cache-Control': 'no-store' }).end();
        return true;
      }
      response.writeHead(data.length ? 200 : 416, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Document-Size': String(row.total),
        Vary: 'Accept-Encoding',
        ...(tag ? { ETag: tag } : {}),
        ...(encoded && !clientDecodes ? { 'Content-Encoding': 'gzip' } : {}),
      }).end(content);
      return true;
    },
  };
}
