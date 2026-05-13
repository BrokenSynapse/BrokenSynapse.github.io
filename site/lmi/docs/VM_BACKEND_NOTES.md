# LMI VM Backend Notes

This build defaults LMI to the local same-origin relay at `/api/relay`.

BIPEX was intentionally left untouched as legacy support.

The old Google Apps Script contract is mirrored by the Node relay in `../api/server.js`.
The old Google Sheets workbook is imported into the local SQLite database with:

```bash
docker compose exec api npm run import:sheet
```

The relay still accepts Google Apps Script URLs for emergency legacy testing, but the default path is local.
