# Client-assisted account storage

## Trusted replicas in 0.6

Approved Windows desktop profiles can explicitly synchronize the owner's hosted encrypted .hca files. Synchronization uses the existing hosted service as the ciphertext source. It does not publish archive bytes to other users or add a peer-to-peer archive transfer path. Regular account-authenticated hosted recovery remains available if every approved device is offline.

The desktop profile generates a non-exportable Web Crypto P-256 signing key. First-device approval requires the current account password and proof of key possession. Later approvals require an approved device and the ten-character code displayed on the pending device. Signed one-time challenges issue five-minute leases bound to the authenticated session and approved device. Revocation invalidates active leases and future replica access. Encrypted files already saved on a revoked device can remain available to its local OS user with the archive recovery key. The key for decrypting a recovery archive is separate from the device key and is never uploaded.

Encrypted blocks are kept in the packaged app's local WebView profile, verified against hosted SHA-256 hashes, and marked complete only after every block passes. Interrupted copies can reuse checked blocks. The local profile has a 2 GiB replica budget. The recovery selector tries local copies first and downloads any missing or damaged member from the account's hosted library. The sign-in screen also offers offline verification and export of a complete local chain. Account changes still require the existing authenticated restore flow and its preview.

Horizon remains authoritative for authentication, account and character IDs, ownership, membership, permissions, sync revisions, and live references. Existing character descriptions and images remain on the server. Creating a backup leaves the live source of account data in place.

| Data | Authority today | Proposed distribution |
|---|---|---|
| Authentication, stable IDs, ownership, permissions | Horizon database | Server only |
| Current character descriptions and PNG images | Horizon database and profile media URLs | Keep recoverable server copies through any separately approved migration |
| Recovery manifests and hashes | Encrypted manifest inside .hca and hosted metadata in SQLite | Server keeps only the archive ID, parent, version, ciphertext hashes and blob location |
| Account backups | Owner's local files and optional hosted ciphertext | Owner-approved devices can replicate encrypted .hca files in a future release |

Register devices under the authenticated owner's account. Use per-device keys protected by the operating system and require explicit approval from an existing trusted device. Bind transfer grants to the owner, source and target devices, exact archive ID, SHA-256 ciphertext digest, operation and expiry. Archive recovery keys stay separate from the device and storage services. Never replicate private archives to unrelated Horizon accounts.

Maintain a server inventory of device approvals, parent dependencies, verified replica counts, and last successful integrity checks. Require independently verified replicas on at least two approved devices, plus an owner-controlled or hosted copy of every required ancestor. Recovery tries the owner's complete local chain, approved devices, and then the hosted copy. Mark offline and missing replicas in the UI. Keep authenticated account export and the existing server media available when devices are offline.

Revoking a device prevents future grants. It cannot guarantee deletion of ciphertext the device already downloaded. Rotate keys for future backups if a device is compromised. Preserve existing backups until explicitly migrated and independently verified.

Before any future reduction of server assets, verify the loss of all devices, corrupt/missing replicas, revocation during transfer, and fully offline restore. Start with shadow reads and verify URLs, permissions, account and character IDs, and character switching while server data remains authoritative. Require a durable fallback, verified server restoration, a reversible reference switch, and explicit approval before deleting any live data. 0.6 makes no such migration.
