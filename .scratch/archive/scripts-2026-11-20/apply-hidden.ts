/// <reference lib="es2022" />
/** Merge hidden-screen scan results into the label truth as 廢棄頁面. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
let hidden: Array<{ id: string; opacity: number }> = [];
if (dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    hidden = db.prepare('SELECT id, opacity FROM hidden_screens').all() as Array<{ id: string; opacity: number }>;
  } catch {
    hidden = [];
  }
  db.close();
}
const truth = JSON.parse(readFileSync('/tmp/truth6.json', 'utf8')) as Array<{ id: string; label: string; major: string; minor: string; generation: string }>;
const byId = new Map(truth.map((t) => [t.id, t]));
for (const h of hidden) byId.set(h.id, { id: h.id, label: '廢棄頁面', major: '廢棄', minor: '廢棄頁面', generation: '' });
writeFileSync('/tmp/truth7.json', JSON.stringify([...byId.values()], null, 2));
console.log('hidden rows=' + hidden.length + '  truth=' + byId.size);
if (hidden.length > 0) console.log('sample: ' + hidden.slice(0, 5).map((h) => h.id + '@' + h.opacity).join(' '));
