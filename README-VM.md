# BrokenSynapse VM-hosted site

This repo is meant to be pulled onto the Ubuntu VM and run with Docker Compose.

- `site/` is the public website served by Caddy.
- `api/` is the local Node relay that replaces Google Apps Script.
- `data/brokensynapse.sqlite` is the local database that replaces Google Sheets.
- `bipex.html` is preserved as legacy support inside `site/` and was intentionally not rewritten.

## First deploy

```bash
cd ~
mv brokensynapse-server brokensynapse-server-old-$(date +%F-%H%M%S) 2>/dev/null || true
git clone https://github.com/BrokenSynapse/BrokenSynapse.github.io.git brokensynapse-server
cd brokensynapse-server
docker compose up -d --build
docker compose exec api npm run import:sheet
curl http://localhost:8080/api/status
```

Open:

```text
https://brokensynapse.us/lmi/
```

## Update later

```bash
cd ~/brokensynapse-server
git pull
docker compose up -d --build
```

## Emergency dev seed

If the Google Sheet import fails and you just need a login to test the relay:

```bash
cd ~/brokensynapse-server
docker compose exec api npm run seed:dev
```

Then use:

```text
tag: bs
hash: bs
```

## Export local database backup

```bash
cd ~/brokensynapse-server
docker compose exec api npm run export:db
cp data/brokensynapse.sqlite backups/brokensynapse-$(date +%F-%H%M%S).sqlite
```
