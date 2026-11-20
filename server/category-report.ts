/// <reference lib="es2022" />
/** Category report: which Figma pages contain a category, with copyable node IDs. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');

const ROOT = resolve(__dirname, '..');
const category = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
if (!category) { console.error('usage: tsx server/category-report.ts <分類>'); process.exit(1); }
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
const labels = (JSON.parse(readFileSync(join(ROOT, 'labels/screens-v2.json'), 'utf8')) as { screens: Array<{ id: string; label: string; major: string; minor: string }> }).screens;
const wanted = labels.filter((r) => r.label === category || r.minor === category);
if (wanted.length === 0) { console.error('no screens for category: ' + category); process.exit(1); }
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const page = new Map<string, string>();
const ids = wanted.map((r) => r.id);
for (let i = 0; i < ids.length; i += 500) {
  const part = ids.slice(i, i + 500);
  const rows = db.prepare('SELECT id, page_name FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string; page_name: string }>;
  for (const r of rows) page.set(r.id, r.page_name);
}
db.close();
const groups = new Map<string, string[]>();
for (const r of wanted) {
  const pg = (page.get(r.id) ?? '(未知頁面)').trim();
  const list = groups.get(pg) ?? [];
  list.push(r.id);
  groups.set(pg, list);
}
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
const lines: string[] = [];
lines.push('# ' + category + ' · 基準統計');
lines.push('');
lines.push('- 畫面 ID 總數：' + wanted.length);
lines.push('- 出現頁面：' + sorted.length);
lines.push('');
for (const [pg, list] of sorted) {
  lines.push('## ' + pg + '（' + list.length + '）');
  lines.push('');
  for (const id of list) lines.push(id);
  lines.push('');
}
const text = lines.join('\n') + '\n';
const out = join('/Users/hyd/Downloads', 'rea-figma-category-' + category + '.md');
writeFileSync(out, text);
console.log(text);
console.log('written ' + out);
