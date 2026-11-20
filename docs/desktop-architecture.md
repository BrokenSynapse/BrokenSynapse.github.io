# Horizon desktop architecture

## Repository audit

- The Horizon source is in `site/horizon-chat` and `horizon-chat` in this checkout. The frontend is static HTML, CSS and vanilla JavaScript ES modules, with no framework, frontend build step or independent client router. The shell and browser state drive navigation. Theme assets and feature modules load from the same site. No Horizon service worker or PWA manifest was found in this snapshot.
- `server.mjs` uses Node 24's HTTP server and `node:sqlite`, with WAL enabled. `messenger.mjs` handles the JSON and binary HTTP API. Compose mounts the application read-only, stores `/data/horizon.sqlite` in the `horizon_data` volume, and routes requests through Caddy. The brief identifies Cloudflare Tunnel as the public ingress. Compose does not define the tunnel.
- Passwords use scrypt. Sessions use server-side token hashes and an HttpOnly, SameSite=Strict cookie scoped to `/horizon-chat/`, with Secure enabled in Compose.
- The account owns permissions and character profiles. The active proxy changes the public sender and can select an independent DM endpoint. `proxies.mjs`, `character-variants.mjs`, `direct-inboxes.mjs`, `server-permissions.mjs` and `channel-passwords.mjs` own the corresponding identity and access rules. Keep those rules authoritative for new features.
- Conversation uploads enter the existing message endpoint as binary requests. Message attachments have a 10 MiB limit and are gzip-chunked in SQLite. The document and thumbnail routes reuse conversation authorization, and document delivery supports byte ranges. Client-generated WebP thumbnails can accompany the upload in a bounded header and are stored separately in SQLite.
- Profile and character assets have separate paths, including content-addressed profile blobs and character-variant data. Existing account avatars and banners accept WebP, so archive export must preserve the actual stored format and bytes. Any new PNG import policy should be additive.
- Realtime updates come from same-origin server-sent events. Clients refresh message history over HTTP after events and reconnects. Preserve this flow independently of future WebRTC signaling.

## Bundled desktop client

`site/horizon-chat` is the production frontend output. It contains the HTML, JavaScript modules, CSS, fonts, themes and vendor assets that Caddy serves directly. Tauri embeds that directory as its frontend distribution. The application opens its local origin, with the normal sign-in page and assets available before any network request. Native settings continue to live in the tray.

`platform.js` keeps browser requests on the original same-origin paths. Desktop requests go through Rust on a per-launch loopback port and an unguessable path. The listener checks the loopback Host and the packaged frontend Origin on cross-origin requests. Writes require both the packaged Origin and the existing Horizon CSRF header. Rust proxies GET, HEAD and POST to the fixed Horizon HTTPS API, rejects upstream redirects and keeps session cookies in an in-memory jar. The webview receives neither the Horizon cookie nor a general-purpose HTTP or filesystem capability. A full application exit requires signing in again. Browser deployments keep their current cookie and CSRF behavior.

Horizon sends realtime updates over SSE. The desktop transport streams SSE bodies, preserves reconnect metadata and consumes the backend's ready event through the existing synchronization path. A closed desktop stream can be recreated after an upstream outage. Restrictive content policy and top-level navigation keep remote pages outside the main webview. The desktop client registers no privileged Tauri IPC commands.

The bundled client requires no production CORS, session, DNS, or reverse-proxy change. If deploying the shared frontend updates to the browser, publish `platform.js` with the other modules before publishing the cache-versioned HTML.

## Persistent chat attachment cache

The desktop bridge can cache gzip attachment chunks beneath the operating system's Horizon cache directory. The cache verifies SHA-256, deduplicates identical compressed chunks, evicts least-recently-used content and falls back to the network on corruption. The default content limit is 2 GiB. Set a limit in MiB by writing a number to `cache-limit-mib` in the app configuration directory and restarting. The supported range is 0–8192 MiB, with 0 disabling storage. The tray has a **Clear chat media cache** action.

To enable caching, deploy the updated Horizon backend modules `messenger.mjs` and `message-documents.mjs` together. The desktop bridge sends `X-Horizon-Cache-Tag` on gzip document chunk GETs. Only after the normal conversation and attachment checks does the server send a content validator or a 304. The bridge returns cached bytes only after a matching server response for that request, including after application restart or account change. Deletions and revoked access therefore prevent future cache reads. The previous backend ignores the opt-in header and transfers attachments normally. No database migration is required. Neither server changes nor the browser frontend updates are automatically deployed by building the installer.

The cache contains attachment bytes under the current OS user's cache directory. It does not encrypt files against someone who can read that OS profile. Attachments cannot be read from cache through the app while authorization is unavailable. Thumbnails and profile assets still use their existing delivery paths.

## Implementation order

1. Bundle the shared production frontend locally, route the existing API through the native transport and preserve the browser deployment.
2. Validate native startup and tray behavior on Windows and Linux, and add native notifications through a narrow, local-only interface.
3. Deploy and measure the authenticated chunk validator and desktop cache before adding peer discovery.
4. Optimize only chat images. Measure AVIF and WebP output against input and test transparency, animation and decode limits across browser and desktop. Keep a single canonical attachment and preserve unsupported originals when the user chooses the compatibility path. Keep account assets out of the chat encoder so the new archive can recover their exact stored bytes.
5. Export a versioned manifest and exact account asset bytes. Benchmark Zstandard, LZMA2 and Brotli on representative data before selecting compression. Verify a bounded streaming container locally and use authenticated client-side encryption with an explicit recovery key. Restore only allowlisted fields through authenticated APIs, with a preview and confirmed conflict handling. Use blob storage and transactional references for incremental backups and garbage collection.
6. Add opt-in WebRTC after the HTTP and archive paths are stable. Use short-lived introductions bound to both peers, the authorized attachment revision and the conversation. Recheck permission before seeding, including password unlock and revocation. Verify chunks against server-authoritative metadata and use bounded discovery with HTTP fallback. Keep TURN off by default. Gate tray seeding on separate opt-in and stop it on explicit quit.
7. Run browser regressions, exercise desktop login and navigation on both platforms, validate corruption and authorization failures, then measure cache hits, transfer volume, archive size, time and peak memory.

## Build and validation

Install [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) and the CLI with `cargo install tauri-cli --version "^2" --locked`. This build was developed with Rust 1.100 and Tauri CLI 2.12.6. Run from `desktop/`.

```sh
cargo tauri dev
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo tauri build -- --locked
```

Windows bundles use NSIS. Linux bundles use Debian and AppImage. Build on the target platform and find bundles under `desktop/src-tauri/target/release/bundle/`. On Windows, run the NSIS setup executable. On Linux, install the Debian package with the distro package manager or make the AppImage executable and launch it. The tray provides Show, close-to-tray, launch at startup and Quit. Both settings default to off on a fresh install. Linux tray availability depends on the desktop environment and its AppIndicator support.

For site regressions, run `node --test horizon-chat/*.test.mjs` from the repository root with Node 24. The HTTP tests bind to localhost and require loopback access.

To smoke-test the NSIS payload without installing it into an existing user profile, extract `horizon-chat-desktop.exe` from the installer with 7-Zip and run `node desktop/tests/windows-package-smoke.mjs <path-to-extracted-exe>` from the repository root. The script uses a fresh WebView2 profile for each launch. It verifies the packaged origin and frontend, first with `--offline` preventing all backend traffic, then against the public Horizon session endpoint.

For desktop acceptance, sign in with an existing test account on Windows and Linux. Exercise character switching, DM inboxes, nested channels, a non-default theme and existing attachments. Enable close-to-tray, close and restore the window, then explicitly quit. Relaunch to verify preference persistence and test startup after signing out and back in to the OS. Use a test account and test conversations for these checks.

## Chat image encoding

Desktop and browser both run the same client-side image worker. It uses the vendored single-threaded jSquash/libavif WebAssembly encoder for AVIF and the browser canvas encoder for WebP. Desktop uses the same worker in WebView2 so cancellation terminates the codec and the two clients share format checks and resizing behavior without granting native filesystem access. The AVIF encoder comes from [jSquash](https://github.com/jamsinclair/jSquash) package `@jsquash/avif@2.1.1`; the source paths and checksum are recorded in its vendor directory.

The default is AVIF quality 72 with a 2560-pixel maximum edge. Format, quality and resize settings are stored locally under Appearance. The worker limits input dimensions, checks for APNG and animated WebP, and rejects GIF and unsupported formats. It generates a small WebP thumbnail from the same resized pixels when possible. There is one full-size representation. The original stays in the local draft and the encoder never uploads it. Source metadata is omitted when pixels are encoded. Character and account media use their existing separate paths.

The optimized upload carries a format marker checked against the attachment bytes and filename. Existing clients can still send attachments under the original API contract. Current clients check the server's format capability before sending optimized images, so an older backend will not misclassify AVIF as MP4.

## 0.3.0 deployment

1. Stage `horizon-chat/messenger.mjs` and `horizon-chat/message-documents.mjs` together on a disposable database or staging clone. These enable cache revalidation and canonical AVIF/WebP uploads. No SQLite migration is required.
2. Back up the live database with SQLite's backup API and retain the prior modules and static assets. After deployment approval, publish the two modules and restart the Horizon service. Verify the session endpoint, authenticated format capability, legacy attachments and optimized image uploads on test accounts.
3. To update the browser client, publish `chat-images.js`, `chat-image-worker.js`, `vendor/avif/` and `messenger.js` before publishing `index.html`. If the site has not received the 0.2.0 shared frontend changes, also publish `platform.js`, `documents.js`, `emojis.js`, `typing.js`, and `messenger.css`. The production server must serve the codec as `application/wasm`. If serving Node's optional static preview, also publish the updated `server.mjs`.
4. Roll back by restoring the prior frontend and backend files. After users have uploaded AVIF images, keep the AVIF-compatible backend if practical. Old message format records and attachment bytes are unchanged by this deployment.

To test a packaged authenticated session without a production account, build a separate installer with `cargo tauri build --features qa-fixture`, extract its executable, and pass `--fixture` to `desktop/tests/windows-package-smoke.mjs`. The feature only accepts a localhost port and must be disabled in the distributed build. The test creates its own in-memory database.

The same test supports `--browser-fixture` with an Edge executable and serves the shared production assets over HTTP. A Windows WebView2 fixture run on the synthetic transparent 960 × 720 PNG measured 775,908 source bytes, 17,025 AVIF bytes and 14,500 WebP bytes at quality 72. Two runs measured 1.85–2.87 seconds for AVIF and 81–98 milliseconds for WebP, including worker initialization and thumbnail generation. This sample is not representative of every image.

## Encrypted account recovery in 0.4.0

Open **Settings → Account → Account recovery archives**. Generate an archive key and store it separately from the backup files. Export a full `.hca` first. For an incremental, select the full archive and all incrementals through the desired parent, then export using the same key. Select that complete chain when restoring. A fresh full export consolidates the current account data and can be retained independently. If the key or a predecessor is lost, a dependent backup cannot be restored.

The format uses a versioned binary header and an encrypted manifest. Each record uses AES-256-GCM with a random nonce and authenticates its archive ID and position. Web Crypto provides the encryption and SHA-256 checks in the packaged client and browser. The recovery key is a randomly generated 256-bit value, stays outside the archive and is never sent to Horizon. Each record uses lossless gzip only when it saves space. Images are content-addressed and deduplicated. Incrementals store the latest full metadata snapshot and only image bytes missing from their parent snapshot. Files are processed one record at a time. Exports stream to a writable file where the browser supports it, with a Blob download fallback.

The archive covers active characters, base and variant profile fields, selected variants, creation dates, theme preference, and original Horizon-hosted or supported embedded image bytes. Tupperbox URLs are kept as references. Third-party image bytes, historical character appearances tied to messages, archived characters, credentials, account identifiers, permissions, memberships, and chat history are outside this format. Restoring the theme is opt-in. Existing characters with the same name and triggers are skipped, and restored characters receive new IDs on the signed-in account.

Restore verifies the full chain and every recorded image before the preview. Confirmation stages the selected snapshot's verified images over the authenticated API. The server independently checks SHA-256, image type and declared size, then commits the character graph and needed image bytes in one SQLite transaction. The API scopes tickets to the account and active session and caps concurrency. Staging uses a private directory under `HORIZON_RECOVERY_STAGING` or the system temp directory. A set may contain up to 500 characters, 4,096 images, 4 MiB per image and 1.5 GiB of original image bytes, with at most 32 archives per chain and 2 GiB of reserved staging per process. Tickets expire after one hour. After an unexpected server process exit, operators can remove stale `horizon-restore-*` directories under the configured staging root while the service is stopped.

For deployment, stage `horizon-chat/recovery-archives.mjs` alongside `messenger.mjs`. If deploying on a backend that still predates 0.3.0, also stage `message-documents.mjs` from this release. No SQLite schema migration is needed. Provision the staging directory with sufficient space and write access for Horizon. Verify the workflow using disposable accounts before rolling out. For the browser client, publish `recovery-archive.js`, `recovery-settings.js` and the updated `messenger.js` before `index.html`. Publish `server.mjs` as well if using the optional Node static preview. Restore the prior modules and HTML together on rollback. Restored profiles use the existing tables and media URLs.

Run the authenticated packaged recovery check with the fixture installer and `node desktop/tests/windows-package-smoke.mjs <extracted-exe> --recovery-fixture`. The fixture intercepts the save destination, exercises the Account settings controls, deletes the seeded test blobs before restoring and compares the newly restored PNGs with the original bytes.

## Peer attachments and hosted recovery in 0.5.0

Peer sharing defaults to disabled. Desktop Appearance settings support visible-window sharing or sharing while Horizon stays running in the tray, an upload rate, a local cache limit, and metered-network pause. Windows checks its connection cost through WinRT, with WebView data-saving as an additional hint. Exiting the app ends the WebRTC connections. Direct connections can expose IP addresses. The client uses [Cloudflare public STUN](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/) without configuring TURN.

The server issues short-lived grants for exact compressed attachment chunks. A grant is bound to both authenticated sessions, the conversation, message, offset, size, and SHA-256. Discovery, seeding and acceptance check current permissions, including channel unlocks and announcement visibility. Seeds serve verified bytes from the existing Rust disk cache. The recipient verifies the bytes and the current grant before acceptance. Existing browser clients and any failed peer request use the normal HTTP path.

Hosted storage is separately opt-in on the server. The client uploads already encrypted .hca archives in one MiB blocks. Retry with the same file to resume from the recorded offset. Finalization verifies each stored block and records the entire ciphertext SHA-256. Downloads verify each block before saving. SQLite stores ownership, version, parent dependencies and hashes. The configurable volume stores ciphertext files. Default quota is 2 GiB per account, configurable up to 8 GiB, with a 64 GiB total reservation cap. Retention defaults to manual removal. Optional expiry runs when the hosted API is used, and incomplete uploads expire after 48 hours of inactivity. A parent stays protected while a dependent incremental exists.

### Staging, migration, and rollback

1. Back up SQLite and verify restore on a staging clone. Deploy messenger.mjs, message-documents.mjs, attachment-peers.mjs, hosted-archives.mjs, and recovery-archives.mjs together. Publish the browser's attachment-peers.js, hosted-archives.js, recovery-archive.js, documents.js, messenger.js, and index.html with HTML last.
2. Enable signaling with HORIZON_ATTACHMENT_PEERS=1. Enable hosted storage with HORIZON_ARCHIVE_STORE set to a private, persistent, writable volume. Hosted storage adds SQLite tables. Back up the blob directory and SQLite metadata together and run hosted storage with one writer process.
3. Validate upload resume, quota, retention, unauthorized access, offline peers, HTTP fallback and a chain restore from downloaded files before approving production rollout. Removing HORIZON_ATTACHMENT_PEERS restores HTTP-only delivery. Removing HORIZON_ARCHIVE_STORE disables hosted access. Keep the blob volume and its database rows during rollback. Restore the earlier matching frontend and backend modules if needed.

The [client-assisted storage proposal](client-assisted-storage.md) covers trusted-device replication and migration gates. Trusted-device replication, live account storage offload, scheduled backups, Linux end-to-end validation, native notifications, and larger production benchmarks remain open.

### Fixture measurements

Use the extracted Windows fixture executable with the smoke runner's --peer-fixture and --hosted-fixture options. The peer test starts two isolated WebView profiles and uses the packaged tray-state signals; it also terminates an advertised seed to test HTTP fallback. Real Windows tray gestures, physical metered-network changes, and WAN behavior across different NATs still need field testing.

Two packaged Windows fixture clients transferred one 256 KiB attachment chunk over WebRTC. The equivalent HTTP response carried 262,244 attachment bytes. The peer run carried zero attachment bytes from the Horizon server and 2,110 bytes of signaling response bodies, an observed reduction of 260,134 outbound response-body bytes. Signaling request and response bodies totaled 4,191 bytes. These counts exclude headers, SSE framing, and STUN traffic; they are not WAN or production estimates.

Authoritative server data was retained, so server storage savings were zero. The encrypted hosted fixture added a 1,200,302-byte ciphertext file plus database metadata. Its resumed upload, final database digest, disk bytes and downloaded bytes agreed. Hosted storage and attachment-cache disk use should be monitored independently of bandwidth savings.

## 0.6 staging and rollback

Stage trusted-devices.mjs with the matching messenger.mjs and the existing recovery, attachment, and hosted modules. Keep HORIZON_ARCHIVE_STORE pointed at the existing private volume and enable HORIZON_TRUSTED_DEVICES=1 in staging. The service adds two SQLite tables for device states and verified-copy receipts. Browser assets can be staged with trusted-devices.js and device-replica-store.js published before messenger.js and index.html. Device controls remain desktop-only.

Keep the archive volume and the SQLite backup paired. Removing HORIZON_TRUSTED_DEVICES disables approval and automatic replica access. Existing hosted downloads, encrypted local copies, account records, and media stay in place. A binary rollback can use the earlier matching site/backend assets while keeping the added tables. Do not remove device rows or the blob volume as a rollback step.

Use the extracted Windows fixture installer with the smoke runner's --device-fixture option. The test uses separate WebView profiles, approves a second device, verifies that revocation denies its existing lease, stops both registered devices, and restores an archive chain through hosted fallback. It also restarts the second profile with the backend disabled and verifies its retained local ciphertext chain.
