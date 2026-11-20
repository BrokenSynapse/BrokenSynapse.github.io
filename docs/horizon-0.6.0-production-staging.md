# Horizon 0.6.0 production staging and rollback

The staged release exposes trusted-device and hosted archive APIs to the installed Horizon Desktop 0.6.0 client. Staging creates private copies and runs isolated rehearsals. Caddy, Cloudflare Tunnel, the browser frontend, the live container and live mount settings stay in place during this work.

## Verification before rollout approval

1. Identify the running Horizon container, its immutable image, Compose files, mount destinations, and current archive, device, peer and secure-cookie settings. Record the container ID. Copy the exact live application files and Compose settings to a private staging directory outside the live checkout.
2. Verify the six release modules against their SHA-256 manifest and overlay them on a copy of the current code. Keep a separate, hashed baseline for rollback. Keep all account data and archive copies private on the VM.
3. Take an online SQLite backup with SQLite's backup API and run full integrity and foreign-key checks. Verify each indexed encrypted archive and durable partial upload against the stored block hashes. Verify the whole ciphertext hash for complete files. Inventory, copy and hash non-indexed .hca files separately. A missing, changed, or corrupt file blocks rollout approval. If hosting is disabled, check for archive rows before recording the archive backup as empty.
4. Use the live runtime image and a disposable copy of the paired backup in a network-isolated rehearsal. Verify candidate startup and authentication with a synthetic account. Test password bootstrap, approval, challenge replay denial, cross-session lease rejection, verified ciphertext download, revocation, and hosted fallback. Verify row counts and SQLite checks after the additive migration.
5. Open the migrated rehearsal database with the exact prior code and previous feature flags. Verify authentication, row counts, intact ciphertext, SQLite checks, and baseline hashes. Confirm the live container ID and session API again. Request production approval after the VM checks pass.

## After explicit rollout approval

1. Refresh the paired production backup immediately before switching. Pause if there is an unexpected Compose, image, mount, data or backup difference.
2. Prepare a separate Compose override that points the Horizon service's application mount at the verified 0.6.0 directory. Enable HORIZON_TRUSTED_DEVICES and retain the current HORIZON_ARCHIVE_STORE if configured. For first-time hosting, use a directory under the persistent Horizon data mount, such as /data/horizon-archives, after confirming ownership, write access and free space. Preserve the peer and secure-cookie settings.
3. Inspect the effective Compose model before applying the override. Confirm it still uses the established database mount and image. Recreate only Horizon Chat with dependencies excluded and image pulls disabled. Verify the loopback and public session APIs. Use a disposable smoke account before testing a real account in the installed desktop app.

## Rollback

- Disable HORIZON_TRUSTED_DEVICES or reapply the prior Compose files and recreate only Horizon Chat. Verify the baseline code hash and both session APIs. Keep the SQLite tables and encrypted archive blobs. If the baseline lacks hosted routes, downloads resume when a compatible release is restored.
- Code rollback uses the current database and preserves activity created after the switch. Restore the paired SQLite and archive backup only for a confirmed data-recovery incident under separate approval. Stop writes, protect a fresh copy of the affected volumes, and verify both stores together before reopening the service. A pre-switch snapshot cannot contain later writes.
- Keep the staged release, baseline and backup manifests until readiness is reviewed. A backup held on the same VM covers application rollback and remains vulnerable to loss of that VM or disk.
