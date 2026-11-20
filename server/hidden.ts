/// <reference lib="es2022" />
/** List screens hidden via opacity (designer's 22% convention) once opacity is exported. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');

const ROOT = resolve(__dirname, '..');
let dbPath = '';
{
  let best = ''; let bestTime = 0;
  for (const d of readdirSync(join(ROOT, 'data'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(ROOT, 'data', d.name, 'graph.sqlite');
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (t > bestTime) { bestTime = t; best = p; }
  }
  dbPath = best;
}
if (!dbPath) { console.error('no database'); process.exit(1); }
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare(
  "SELECT id, name, page_name, ROUND(json_extract(style_json, '$.opacity'), 3) AS opacity FROM nodes " +
  "WHERE json_extract(style_json, '$.opacity') IS NOT NULL AND json_extract(style_json, '$.opacity') <= 0.35 " +
  "AND type IN ('FRAME','COMPONENT','INSTANCE') ORDER BY opacity",
).all() as Array<{ id: string; name: string; page_name: string; opacity: number }>;
db.close();
console.log('hidden candidates=' + rows.length);
for (const r of rows.slice(0, 200)) console.log(r.id + '  opacity=' + r.opacity + '  ' + r.page_name + ' · ' + r.name);
