# LMI-R Migration

This branch starts a side-by-side rewrite of the LMI stack. The production `/lmi` app and the existing Node `/api` service remain in place.

## What Was Added

- `site/lmi-r/`: a Vite + TypeScript frontend shell for the new LMI-R desktop.
- `site/lmi-r/src/runtime/`: typed placeholders for boot/runtime, API client, auth, state, windows, module registry, and themes.
- `api-rust/`: a Rust API service using axum, tokio, and sqlx.
- `api-rust/migrations/0001_compact_object_schema.sql`: the first compact SQLite object schema.
- Caddy route `/api-r/*` proxying to the Rust service.
- Docker Compose service `api-rust` running separately from the existing Node API.
- Binary LMI Bus packet transport using MessagePack (`application/x-msgpack`) for runtime data and persisted state/event blobs.

## What Still Uses The Old System

- `/lmi` is still the current static HTML/JavaScript app.
- `/api/*` is still served by the Node/Express API under `api/`.
- Existing SQLite sheet-style data remains in `data/brokensynapse.sqlite`.
- BIPEX is untouched.

## Running The Frontend

From `site/lmi-r`:

```bash
npm install
npm run dev
npm run build
```

The Vite dev server proxies `/api-r` to `http://localhost:3100`. In Docker/Caddy, `/lmi-r` is served from `site/lmi-r` and `/api-r` is proxied to the Rust container.

## Running The Rust API

From `api-rust`:

```bash
cargo build
LMI_R_BIND=0.0.0.0:3100 LMI_R_DB=../data/lmi-r.sqlite cargo run
```

Startup opens or creates `data/lmi-r.sqlite`, enables SQLite WAL-oriented pragmas through sqlx connect options, and applies embedded migrations automatically.

Available endpoints:

- `GET /api-r/status`
- `POST /api-r/packet`
- `POST /api-r/packet/batch`
- `GET /api-r/debug/schema`
- `GET /api-r/debug/entities`

## How `/lmi-r` Differs From `/lmi`

`/lmi-r` is now a terminal-first shell, not a port of all existing modules. It has a module registry with placeholder entries for `Settings.LMX`, `Sift.LMX`, `Fleetline.LMX`, and `DataForge.LMX`. It displays Rust backend status from `/api-r/status` to prove the vertical slice is wired.

The terminal starts with:

```text
LMI Ver. 19.2.1.1.2212
© Leviathan Exports Company.
```

The banner is normal terminal output and can be removed with `clear`.

Unauthenticated users now land on the LMI-R Access Portal. The first successful login checks the legacy LMI `core` sheet in `brokensynapse.sqlite` and imports only login credentials plus the minimum identity/admin metadata needed to create a personal terminal home. Non-admin users are clamped to `/lmi-r/os/users/[username]`; admin-tagged accounts start at `/lmi-r/os`.

The terminal emulates a small fish-like session: command history is kept only in browser memory, ArrowUp/ArrowDown recall commands, Tab completes from the LMI command table, and entered commands get basic syntax coloring for command groups, subcommands, flags, paths, and app/package names.

`/lmi` continues to be the production app and should be migrated module by module only after compatibility contracts are clear.

## LMI Bus

LMI-R modules communicate through `ModuleContext`, backed by the frontend `LmiBus`. Modules should not call `fetch()` for normal app data, import the bus directly, or use per-module bridge scripts. The initial bus supports packets, local/session state, persisted state through `/api-r/packet`, pub/sub events, module requests, app actions, and debug inspection.

Current terminal proof points:

- `save <text>` writes and reloads `settings.demo.message` through `ctx.setState(..., { persist: true })`.
- `asset demo` makes `Sift.LMX` publish `asset:selected`.
- `Fleetline.LMX` receives `asset:selected` without importing Sift.
- `bus` makes `DataForge.LMX` request a bus debug snapshot through `ctx.callAction('debug.bus')`.
- `de list` and `de install <id>` reserve a path for future standalone desktop environments while keeping the terminal as the base interface.

Command group labels:

- `lx`: package/profile binding manager
- `lmx`: app/module launcher
- `shell`: DE/shell manager
- `sys`: runtime/system manager
- `svc`: services
- `perm`: permissions
- `Lfetch`: identity/neofetch

The Rust backend remains generic: it accepts binary packets, logs packets to `event_log`, and persists compact state in `entity` plus `entity_state`.

## Compact Database Direction

The new schema uses integer IDs and compact dictionaries instead of repeating strings in every row. Entity state payloads are stored as BLOBs with a codec marker. LMI-R runtime packets, persisted state, and event log payloads now use MessagePack BLOBs; JSON is only kept for the legacy account import/login doorway and development status/debug views.

Early LMI-R test builds briefly wrote JSON state/auth/event payloads. Rust now runs a one-time startup migration for entity/event blobs marked with the old JSON codec, and the auth/state readers also have a defensive read-and-rewrite fallback. After that rewrite, LMI-R runtime storage is MessagePack.

Core tables:

- `dict`
- `entity`
- `entity_state`
- `entity_prop`
- `blob_asset`
- `edge`
- `event_log`

## Next Migration Steps

1. Add seed/import tooling that maps selected old sheet rows into `entity` plus `entity_state`.
2. Define stable TypeScript DTOs for the first native module.
3. Add authenticated write paths to the Rust API.
4. Move one low-risk module into `/lmi-r` as a native TypeScript implementation.
5. Add compatibility launchers for old modules only when needed, keeping them visually marked as legacy.
6. Add optional CBOR or custom packed structs after the MessagePack packet shape settles.
