export function createServerLayouts(db) {
  db.exec('CREATE TABLE IF NOT EXISTS server_rail_layout (account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, layout TEXT NOT NULL)');
  const read = db.prepare('SELECT layout FROM server_rail_layout WHERE account_id = ?');
  const write = db.prepare('INSERT INTO server_rail_layout VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET layout = excluded.layout');
  const membership = db.prepare('SELECT server_id AS id FROM chat_server_members WHERE account_id = ?');
  return {
    get(account) {
      return JSON.parse(read.get(account)?.layout || '[]');
    },
    save(account, input) {
      if (!Array.isArray(input) || input.length > 250) return { status: 400, error: 'Invalid server arrangement.' };
      const available = new Set(membership.all(account).map(row => row.id));
      const used = new Set();
      const folders = new Set();
      function server(id) {
        if (!Number.isSafeInteger(id) || !available.has(id) || used.has(id)) throw new Error('Refresh your server list before saving this arrangement.');
        used.add(id);
        return id;
      }
      try {
        const layout = input.map(entry => {
          if (!entry || typeof entry !== 'object') throw new Error('Invalid server arrangement.');
          if (entry.serverId !== undefined) return { serverId: server(entry.serverId) };
          if (typeof entry.folderId !== 'string' || !/^[a-zA-Z0-9-]{1,60}$/.test(entry.folderId) ||
              folders.has(entry.folderId) || typeof entry.name !== 'string' || !entry.name.trim() ||
              entry.name.length > 60 || !Array.isArray(entry.servers) || !entry.servers.length || entry.servers.length > 250) {
            throw new Error('Enter a folder name and valid server list.');
          }
          folders.add(entry.folderId);
          const image = entry.image || '';
          if (typeof image !== 'string' || image.length > 300000 ||
              (image && !/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(image))) throw new Error('Choose a smaller folder image.');
          return { folderId: entry.folderId, name: entry.name.trim(), image, open: Boolean(entry.open), servers: entry.servers.map(server) };
        });
        for (const id of available) if (!used.has(id)) layout.push({ serverId: id });
        const encoded = JSON.stringify(layout);
        if (encoded.length > 2_000_000) return { status: 400, error: 'Reduce the size of your folder images.' };
        write.run(account, encoded);
        return { layout };
      } catch (error) {
        return { status: 400, error: error.message };
      }
    },
  };
}
