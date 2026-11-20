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
BrokenSynapse/BrokenSynapse.github.io. For version 0.6.1, use:

- Release tag `horizon-v0.6.1`
- Uploaded asset `Horizon-Chat-0.6.1-Windows-x64-Setup.exe`

The Windows client checks on launch and every six hours while open. It ignores
drafts, prereleases, releases without the matching uploaded installer, and
versions at or below the installed version. The title-bar button opens the
matching GitHub release in the default browser so the user can review and run
setup. The title-bar Chrome is bundled through the native window initializer.
