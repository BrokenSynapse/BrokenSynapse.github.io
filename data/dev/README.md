# BrokenSynapse / LMI database reference

Live database is intentionally not committed:
data/brokensynapse.sqlite

The API stores pseudo-sheets in SQLite table `sheets`.
Each sheet has:
- name
- rows_json

Important sheets:
- core: user/account rows.
- desk: per-user desktop app layout.
- dictApps: app registry.
- dictThemes: themes.
- currencySettings: currency config.
- catalog/vehicles/mods: app/module data.

core.shellPrefs is a JSON string. Example:
{"iconSize":72,"gridSnap":true,"hiddenTaskbar":false,"iconPack":"default"}

desk.lay format:
appKey:iconX,iconY,windowX,windowY,windowW,windowH,maximized,minimized

First two numbers are desktop icon coordinates.
Middle x/y/w/h are window placement and size.

Example:
s:0,156,80,70,1120,760,0,0

dictApps fields:
- k: short app key
- id: stable app id
- nm: display name
- path: module path
- ico: fallback glyph icon used when iconPack is none
- w/h: default window size

Do not commit live DB, uploads, or user image assets.
