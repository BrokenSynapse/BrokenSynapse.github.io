import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createMessenger } from './messenger.mjs';
import { compressStoredDocuments } from './message-documents.mjs';

const database = new DatabaseSync(process.env.HORIZON_DB || new URL('../data/horizon.sqlite', import.meta.url));
database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
const secure = process.env.HORIZON_SECURE_COOKIE === '1';
const messenger = createMessenger(database, { secure, json });
void compressStoredDocuments(database).catch(error => console.error('Could not compress legacy attachments:', error));
const preview = process.env.HORIZON_PREVIEW === '1';
const previewFiles = new Map([
  ...['chat-images.js', 'chat-image-worker.js', 'vendor/avif/avif_enc.js', 'vendor/avif/meta.js', 'recovery-archive.js', 'recovery-settings.js', 'attachment-peers.js', 'hosted-archives.js', 'trusted-devices.js', 'device-replica-store.js']
    .map(file => ['/horizon-chat/' + file, ['horizon-chat/' + file, 'text/javascript']]),
  ['/horizon-chat/vendor/avif/avif_enc.wasm', ['horizon-chat/vendor/avif/avif_enc.wasm', 'application/wasm']],
  ['/horizon-chat/platform.js', ['horizon-chat/platform.js', 'text/javascript']],
  ['/', ['index.html', 'text/html']],
  ['/bipex.html', ['bipex.html', 'text/html']],
  ['/aac.html', ['aac.html', 'text/html']],
  ['/horizon-chat/', ['horizon-chat/index.html', 'text/html']],
  ['/horizon-chat/messenger.js', ['horizon-chat/messenger.js', 'text/javascript']],
  ['/horizon-chat/messenger.css', ['horizon-chat/messenger.css', 'text/css']],
  ...['YO Tools', 'YO Chars', 'YO Settings', 'YO Default', 'YO DM', 'YO Ping'].map(name => {
    const file = 'horizon-chat/themes/Ye Olde/' + name + '.png';
    return [encodeURI('/' + file), [file.replaceAll(' ', '%20'), 'image/png']];
  }),
  ...['CM Tools', 'CM Chars', 'CM Settings', 'CM Default', 'CM DM', 'CM Ping'].map(name => {
    const file = 'horizon-chat/themes/Comic/' + name + '.webp';
    return [encodeURI('/' + file), [encodeURI(file), 'image/webp']];
  }),
  ...['NN Tools', 'NN Chars', 'NN Settings', 'NN Default', 'NN DM', 'NN Ping'].map(name => {
    const file = encodeURI('horizon-chat/themes/Neo-Noir/' + name + '.webp');
    return ['/' + file, [file, 'image/webp']];
  }),
  ...['tools', 'characters', 'settings', 'dm', 'ping', 'avatar', 'background'].map(name => {
    const file = 'horizon-chat/themes/Horizon/' + name + '.png';
    return ['/' + file, [file, 'image/png']];
  }),
  ...['Comic', 'Ye Olde', 'Neo-Noir'].map(theme => {
    const file = encodeURI('horizon-chat/themes/' + theme + '/Horizon ' + theme + ' Wallpaper.webp');
    return ['/' + file, [file, 'image/webp']];
  }),
  ['/horizon-chat/singularity-logo.png', ['horizon-chat/singularity-logo.png', 'image/png']],
  ...['400-latin.woff2','400-latin-ext.woff2','700-latin.woff2','700-latin-ext.woff2','OFL.txt'].map(file => ['/horizon-chat/fonts/noto-sans/' + file, ['horizon-chat/fonts/noto-sans/' + file, file.endsWith('.woff2') ? 'font/woff2' : 'text/plain']]),
  ...['400-latin.woff2','400-latin-ext.woff2','700-latin.woff2','700-latin-ext.woff2','OFL.txt'].map(file => ['/horizon-chat/fonts/shippori-mincho-b1/' + file, ['horizon-chat/fonts/shippori-mincho-b1/' + file, file.endsWith('.woff2') ? 'font/woff2' : 'text/plain']]),
  ['/horizon-chat/fonts/milonga/Milonga-Regular.ttf', ['horizon-chat/fonts/milonga/Milonga-Regular.ttf', 'font/ttf']],
  ['/horizon-chat/fonts/milonga/OFL.txt', ['horizon-chat/fonts/milonga/OFL.txt', 'text/plain']],
  ...['Play-Regular.ttf', 'Play-Bold.ttf', 'OFL.txt'].map(file => ['/horizon-chat/fonts/play/' + file, ['horizon-chat/fonts/play/' + file, file.endsWith('.ttf') ? 'font/ttf' : 'text/plain']]),
  ...['horizon','basic-light','basic-mid','basic-dark','vanilla','sage','cinnamon','lavender','nutmeg','clove','d2-steel','burnt-titanium'].map(name => ['/horizon-chat/theme-icons/' + name + '.svg', ['horizon-chat/theme-icons/' + name + '.svg', 'image/svg+xml']]),
  ['/horizon-chat/vendor/lucide/createElement.mjs', ['horizon-chat/vendor/lucide/createElement.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/createElement.mjs.map', ['horizon-chat/vendor/lucide/createElement.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/defaultAttributes.mjs', ['horizon-chat/vendor/lucide/defaultAttributes.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/defaultAttributes.mjs.map', ['horizon-chat/vendor/lucide/defaultAttributes.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/index.mjs', ['horizon-chat/vendor/lucide/index.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/LICENSE', ['horizon-chat/vendor/lucide/LICENSE', 'text/plain']],
  ['/horizon-chat/vendor/lucide/package-source.json', ['horizon-chat/vendor/lucide/package-source.json', 'application/json']],
  ['/horizon-chat/vendor/lucide/icons/anvil.mjs', ['horizon-chat/vendor/lucide/icons/anvil.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/icons/anvil.mjs.map', ['horizon-chat/vendor/lucide/icons/anvil.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/icons/flower-2.mjs', ['horizon-chat/vendor/lucide/icons/flower-2.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/icons/flower-2.mjs.map', ['horizon-chat/vendor/lucide/icons/flower-2.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/icons/leaf.mjs', ['horizon-chat/vendor/lucide/icons/leaf.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/icons/leaf.mjs.map', ['horizon-chat/vendor/lucide/icons/leaf.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/icons/moon.mjs', ['horizon-chat/vendor/lucide/icons/moon.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/icons/moon.mjs.map', ['horizon-chat/vendor/lucide/icons/moon.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/icons/sprout.mjs', ['horizon-chat/vendor/lucide/icons/sprout.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/icons/sprout.mjs.map', ['horizon-chat/vendor/lucide/icons/sprout.mjs.map', 'application/json']],
  ['/horizon-chat/vendor/lucide/icons/sun.mjs', ['horizon-chat/vendor/lucide/icons/sun.mjs', 'text/javascript']],
  ['/horizon-chat/vendor/lucide/icons/sun.mjs.map', ['horizon-chat/vendor/lucide/icons/sun.mjs.map', 'application/json']],
  ['/horizon-chat/logo.png', ['horizon-chat/logo.png', 'image/png']],
  ['/horizon-chat/wordmark.png', ['horizon-chat/wordmark.png', 'image/png']],
  ...['character-binder.css', 'palette-themes.css', 'forum.js', 'server-rail.js', 'composer.js', 'channel-map.js', 'timeline.js', 'emojis.js', 'twemoji/catalog.js', 'documents.js', 'typing.js', 'restart-notice.js', 'language-catalog.js', 'highlight.min.js', 'highlight-lua.min.js', 'composer.css', 'highlight.css']
    .map(file => ['/horizon-chat/' + file, ['horizon-chat/' + file, file.endsWith('.js') ? 'text/javascript' : 'text/css']]),
]);

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/horizon-chat/api/messages') {
    return json(response, 404, { error: 'Page not found.' });
  }
  const grammar = /^\/horizon-chat\/syntax\/[a-z0-9-]+\.min\.js$/.test(url.pathname);
  const diceArt = /^\/horizon-chat\/dice\/(?:d(?:2|4|6|8|10|12|20)|themes\/(?:Horizon|Comic_Book|Neo_Noir|Ye_Olde)\/D(?:2|4|6|8|10|12|20|100))\.png$/.test(url.pathname);
  const emojiArt = /^\/horizon-chat\/twemoji\/svg\/[a-f0-9-]+\.svg$/.test(url.pathname);
  const file = preview && ['GET', 'HEAD'].includes(request.method) &&
    (previewFiles.get(url.pathname) || (grammar && [url.pathname.slice(1), 'text/javascript']) ||
      (emojiArt && [url.pathname.slice(1), 'image/svg+xml']) || (diceArt && [url.pathname.slice(1), 'image/png']));
  if (file) {
    const [name, type] = file;
    const data = await readFile(new URL('../site/' + name, import.meta.url)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!data) return json(response, 404, { error: 'File not found.' });
    response.writeHead(200, { 'Content-Type': type.startsWith('text/') ? type + '; charset=utf-8' : type }).end(data);
    return;
  }
  return messenger(request, response, url);
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: 'Horizon Chat is temporarily unavailable.' });
    else response.destroy();
  });
});
server.listen(Number(process.env.HORIZON_PORT || 8091), process.env.HORIZON_BIND || '127.0.0.1');
