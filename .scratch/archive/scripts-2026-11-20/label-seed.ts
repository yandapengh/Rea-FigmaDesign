/// <reference lib="es2022" />
/** Build a stratified seed-labeling set from the newest graph. Writes .scratch/label-seed.{json,md}. */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph, archetypeOf, headlineOf } from './core/graph';

const ROOT = resolve(__dirname, '..');
let dbPath = '';
let count = 60;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--count') count = Number(args[++i]) || count;
  else if (!args[i].startsWith('--')) dbPath = resolve(ROOT, args[i]);
}
if (!dbPath) {
  let best = '';
  let bestTime = 0;
  for (const d of readdirSync(join(ROOT, 'data'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(ROOT, 'data', d.name, 'graph.sqlite');
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (t > bestTime) { bestTime = t; best = p; }
  }
  dbPath = best;
}
const g = new Graph(dbPath);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const pageMeta = new Map<string, { name: string; index: number }>();
for (const row of db.prepare('SELECT page_id, page_name, page_index FROM pages').all() as Array<{ page_id: string; page_name: string; page_index: number }>) pageMeta.set(row.page_id, { name: row.page_name, index: row.page_index });
db.close();

const cand = new Set<string>();
for (const [id, n] of g.nodes) {
  if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
  if (Math.abs((n.bbox_w ?? 0) - 390) > 4 || Math.abs((n.bbox_h ?? 0) - 844) > 6) continue;
  cand.add(id);
}
const roots = [...cand].filter((id) => {
  let p = g.nodes.get(id)?.parent_id ?? null;
  while (p) { if (cand.has(p)) return false; p = g.nodes.get(p)?.parent_id ?? null; }
  return true;
});

interface Card { id: string; name: string; page: string; pageId: string; archetype: string; hash: string; nodes: number; headline: string; copies: number }
const cards: Card[] = [];
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  const n = g.nodes.get(id)!;
  const texts: string[] = [];
  for (const sid of sub) { const t = g.nodes.get(sid)?.text_content; if (t) texts.push(t); }
  cards.push({ id, name: n.name, page: pageMeta.get(n.page_id)?.name ?? n.page_name, pageId: n.page_id, archetype: archetypeOf(g, id), hash: (g.hash.get(id) ?? '').slice(0, 8), nodes: sub.length, headline: headlineOf(texts), copies: 0 });
}
const family = new Map<string, number>();
for (const c of cards) family.set(c.hash, (family.get(c.hash) ?? 0) + 1);
for (const c of cards) c.copies = family.get(c.hash) ?? 1;
const seen = new Set<string>();
const unique = cards.filter((c) => { const k = c.hash + '|' + c.headline; if (seen.has(k)) return false; seen.add(k); return true; });

const pages = [...pageMeta.keys()].filter((p) => unique.some((c) => c.pageId === p)).sort((a, b) => (pageMeta.get(a)!.index - pageMeta.get(b)!.index));
const picked: Card[] = [];
const seenId = new Set<string>();
const take = (c: Card) => { if (!seenId.has(c.id) && picked.length < count) { seenId.add(c.id); picked.push(c); } };
for (const p of pages) {
  const pool = unique.filter((c) => c.pageId === p).sort((a, b) => b.nodes - a.nodes);
  if (pool.length > 0) take(pool[0]);
}
for (const arch of ['overlay', 'overlay-panel']) {
  for (const p of pages) {
    if (picked.length >= count) break;
    const pool = unique.filter((c) => c.pageId === p && c.archetype === arch).sort((a, b) => b.nodes - a.nodes);
    if (pool.length > 0) take(pool[0]);
  }
}
for (const c of unique.sort((a, b) => b.nodes - a.nodes)) { if (picked.length >= count) break; take(c); }

const clean = (s: string, max: number): string => s.replace(/[|\n]/g, '/').slice(0, max);
const md: string[] = [];
md.push('| # | node_id | 頁面 | 畫面／圖層 | 原型 | 節點 | 標題 | 分類（請填） |');
md.push('|---|---|---|---|---|---|---|---|');
picked.forEach((c, i) => md.push('| ' + (i + 1) + ' | ' + c.id + ' | ' + clean(c.page, 60) + ' | ' + clean(c.name, 40) + ' | ' + c.archetype + ' | ' + c.nodes + ' | ' + clean(c.headline, 24) + ' |  |'));
writeFileSync(join(ROOT, '.scratch/label-seed.json'), JSON.stringify({ db: dbPath, screens: roots.length, unique: unique.length, picked }, null, 2));
writeFileSync(join(ROOT, '.scratch/label-seed.md'), md.join('\n') + '\n');
console.log('screens=' + roots.length + '  unique=' + unique.length + '  picked=' + picked.length + '  pages=' + pages.length);
