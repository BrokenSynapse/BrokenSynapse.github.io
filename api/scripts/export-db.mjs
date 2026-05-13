import fs from 'fs';
import { exportAll } from '../lib/store.js';
const file = process.argv[2] || `/data/export-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
fs.writeFileSync(file, JSON.stringify(exportAll(), null, 2));
console.log(file);
