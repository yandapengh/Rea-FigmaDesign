/// <reference lib="es2022" />
/** Category report: list all categories, or report one category by Figma page with node IDs. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');

const ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
const listMode = args.indexOf('--list') !== -1;
const jsonMode = args.indexOf('--json') !== -1;
const category = args.find((a) => !a.startsWith('--')) ?? '';
if (!listMode && !category) {
  console.error('usage: tsx server/category-report.ts <分類>  |  --list [--json]');
  process.exit(1);
}
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
const labels = (JSON.parse(readFileSync(join(ROOT, 'labels/screens-v2.json'), 'utf8')) as {
  screens: Array<{ id: string; label: string; major: string; minor: string }>;
}).screens;
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const page = new Map<string, string>();
const loadPages = (ids: string[]): void => {
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.prepare('SELECT id, page_name FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string; page_name: string }>;
    for (const r of rows) page.set(r.id, (r.page_name ?? '').trim());
  }
};

if (listMode) {
  loadPages(labels.map((r) => r.id));
  const majors = new Map<string, { count: number; minors: Map<string, { count: number; pages: Set<string> }> }>();
  for (const r of labels) {
    const rec = majors.get(r.major) ?? { count: 0, minors: new Map() };
    rec.count += 1;
    const minor = r.minor || '(只到大類)';
    const sub = rec.minors.get(minor) ?? { count: 0, pages: new Set<string>() };
    sub.count += 1;
    const pg = page.get(r.id);
    if (pg) sub.pages.add(pg);
    rec.minors.set(minor, sub);
    majors.set(r.major, rec);
  }
  const ordered = [...majors.entries()].sort((a, b) => b[1].count - a[1].count);
  if (jsonMode) {
    const data = ordered.map(([major, rec]) => ({
      major,
      count: rec.count,
      minors: [...rec.minors.entries()].sort((a, b) => b[1].count - a[1].count).map(([minor, sub]) => ({ minor, count: sub.count, pages: sub.pages.size })),
    }));
    console.log(JSON.stringify({ db: dbPath, total: labels.length, majors: data }, null, 2));
  } else {
    console.log('# 分類清單（labels/screens-v2.json）');
    console.log('');
    console.log('- 畫面總數：' + labels.length);
    console.log('- 大類：' + ordered.length);
    console.log('');
    console.log('| 大類 | 畫面數 | 小類數 |');
    console.log('|---|---:|---:|');
    for (const [major, rec] of ordered) console.log('| ' + major + ' | ' + rec.count + ' | ' + rec.minors.size + ' |');
    for (const [major, rec] of ordered) {
      console.log('');
      console.log('## ' + major + '（' + rec.count + '）');
      console.log('');
      console.log('| 小類 | 畫面數 | 頁面數 |');
      console.log('|---|---:|---:|');
      for (const [minor, sub] of [...rec.minors.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log('| ' + minor + ' | ' + sub.count + ' | ' + sub.pages.size + ' |');
      }
    }
  }
  db.close();
  process.exit(0);
}

const wanted = labels.filter((r) => r.label === category || r.minor === category);
if (wanted.length === 0) { db.close(); console.error('no screens for category: ' + category); process.exit(1); }
loadPages(wanted.map((r) => r.id));
db.close();
const groups = new Map<string, string[]>();
for (const r of wanted) {
  const pg = page.get(r.id) ?? '(未知頁面)';
  const list = groups.get(pg) ?? [];
  list.push(r.id);
  groups.set(pg, list);
}
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
if (jsonMode) {
  console.log(JSON.stringify({ category, total: wanted.length, pages: sorted.map(([pg, ids]) => ({ page: pg, count: ids.length, ids })) }, null, 2));
  process.exit(0);
}
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
