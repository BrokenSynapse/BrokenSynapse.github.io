# Horizon Desktop for Windows

The x64 package uses Tauri 2 and NSIS. The Horizon setup pages live in
`desktop/src-tauri/installer/HorizonPages.nsh`. The surrounding template is based on the
Tauri CLI 2.12.6 template, with its registry, shortcuts, process checks, WebView2
setup and uninstaller retained. Review the upstream template when upgrading Tauri.

## Build

Install the Windows Rust MSVC toolchain, Visual Studio C++ build tools, and Tauri
CLI 2.12.6. From `desktop/src-tauri` run:

```powershell
cargo tauri build --bundles nsis -- --locked
```

The first build downloads the Microsoft x64 WebView2 offline installer. The
resulting setup executable includes the runtime and can be used without a
network connection. Tauri's usual signing configuration continues to apply.

The interactive installer defaults to the current user. Installation options show
the location, desktop shortcut choice, and launch preference. An existing
installation is updated in place. To preserve the existing entry in Windows and
avoid leaving a second install behind, the folder is locked on upgrades. The
Start menu shortcut is registered in both modes. The setup launcher shows Uninstall when an existing install has a registered
uninstaller. This opens the normal uninstall confirmation, which retains the separate opt-in choice for removing application data.

Installation uses the NSIS progress control, with labels logged at extraction,
configuration or update, and success. Progress reflects NSIS instruction
progress. It does not estimate time spent inside a separate WebView2 installer.

## Announce a desktop update

Set the same new three-part release version in Cargo.toml and tauri.conf.json,
build the installer, and publish a stable public GitHub release in
BrokenSynapse/BrokenSynapse.github.io. For example, for version 0.6.3 use:

- Release tag `horizon-v0.6.3`
- Windows setup `Horizon-Chat-0.6.3-Windows-x64-Setup.exe`
- In-app update asset `Horizon-Chat-0.6.3-Windows-x64-Update.exe.gz`

The Windows client checks on launch and every six hours while open. It ignores
drafts, prereleases, releases without the matching uploaded installer, and
versions at or below the installed version. From 0.6.2, clicking Update downloads
and checks the expected size and SHA-256 from the official GitHub release. The
in-app progress panel shows downloading and unpacking. A background Horizon
process replaces the installed executable and restarts it without opening Setup.

Generate the update asset by gzip-compressing the single Windows executable
extracted from the release installer, with the exact versioned name above.
Keep the full Setup asset for first-time installs and older desktop versions.

The existing 0.6.0 and 0.6.1 builds need one standard install to pick up this
updater. It checks for later releases that include the update asset.

For a local update rehearsal, build with `cargo tauri build --no-bundle
--features qa-fixture -- --locked` and run
`node desktop/tests/windows-in-app-update.mjs PATH_TO_QA_EXE` from the repository
root. The test uses an isolated installation and WebView profile.
