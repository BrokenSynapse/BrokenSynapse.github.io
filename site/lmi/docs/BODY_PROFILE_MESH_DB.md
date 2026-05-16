# BodyMods.LMX profile mesh database patch

This pass keeps LMI hostable as static GitHub Pages files. The GLB mannequins live under `assets/body/models/`, and the selected mesh/body slider profile is saved through the existing Google Apps Script relay into a `bodyProfiles` sheet.

New relay actions:

- `body.profile.get` — returns the active Profile.LMX body profile for the logged-in `cid`.
- `body.profile.save` — appends a profile revision row to `bodyProfiles`; optionally updates `core.cn`, `core.tag`, and `core.hash` if credentials are supplied.
- `body.profile.meshSet` — lightweight save for base mesh + mesh path + body slider hook.

New/expanded sheets are auto-created by Apps Script:

- `bodyProfiles`: profile ID, display name, employee tag, base mesh ID, mesh path, skin tint, body slider JSON, packed blob.
- `bodyInstalled`: now also stores profileId/baseMesh/meshPath with each installed mod entry.

Deploy notes:

1. Upload the whole folder to GitHub Pages.
2. Import `LMI_Unified_Compressed_Data_Core.xlsx` into Google Sheets if you have not already.
3. Paste the updated `appsScript/Code.gs` into Apps Script.
4. Set `LMI_SPREADSHEET_ID`.
5. Deploy as Web App: execute as you, access anyone with link.
6. Save the Web App URL in LMI Settings / LMI Terminal relay field.

The body viewer imports Three.js/GLTFLoader from unpkg, so the static site itself is still GitHub Pages compatible. If you want zero CDN dependencies later, vendor the Three.js modules locally and change the import URLs.
