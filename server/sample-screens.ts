/// <reference lib="es2022" />
/** Pick <=N screens spread across pages for a human Figma spot-check. */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database = require('better-sqlite3');
import { AstGraphDB } from './db';
import { Graph, archetypeOf, findScreenRoots } from './core/graph';

const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
let dbPath = '';
let json = false;
const wanted = 10;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--json') json = true;
  else if (argv[i] === '--db') dbPath = resolve(ROOT, argv[++i] ?? '');
  else if (!argv[i].startsWith('--')) dbPath = resolve(ROOT, argv[i]);
}
if (!dbPath) dbPath = AstGraphDB.resolveLatestGraphDb(ROOT) ?? '';
if (!dbPath || !existsSync(dbPath)) { console.error('no database'); process.exit(1); }

const g = new Graph(dbPath);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const pageIndex = new Map<string, { index: number; name: string }>();
for (const row of db.prepare('SELECT page_id, page_name, page_index FROM pages').all() as Array<{ page_id: string; page_name: string; page_index: number }>) {
  pageIndex.set(row.page_id, { index: row.page_index, name: row.page_name });
}
db.close();

const roots = findScreenRoots(g, 40);
const byPage = new Map<string, Array<{ id: string; nodes: number }>>();
for (const id of roots) {
  const n = g.nodes.get(id)!;
  const sub = g.subtree(id);
  const bucket = byPage.get(n.page_id);
  const row = { id, nodes: sub.length };
  if (bucket) bucket.push(row); else byPage.set(n.page_id, [row]);
}
const pages = [...byPage.keys()].filter((p) => p).sort((a, b) => (pageIndex.get(a)?.index ?? 0) - (pageIndex.get(b)?.index ?? 0));
const picks: Array<{ page: string; name: string; id: string; archetype: string; hash: string; nodes: number }> = [];
const perPage = Math.max(1, Math.ceil(wanted / Math.max(1, pages.length)));
const step = Math.max(1, Math.floor(pages.length / wanted));
for (let i = 0; i < pages.length && picks.length < wanted; i += step) {
  const page = pages[i];
  const rows = byPage.get(page)!.sort((a, b) => b.nodes - a.nodes);
  for (const row of rows.slice(0, perPage)) {
    const n = g.nodes.get(row.id)!;
    picks.push({ page: pageIndex.get(page)?.name ?? n.page_name, name: n.name, id: row.id, archetype: archetypeOf(g, row.id), hash: g.hash.get(row.id) ?? '', nodes: row.nodes });
    if (picks.length >= wanted) break;
  }
}
if (json) {
  console.log(JSON.stringify({ db: dbPath, screens: roots.length, picks }, null, 2));
} else {
  console.log('sample  db=' + dbPath);
  console.log('screens=' + roots.length + '  picked=' + picks.length);
  console.log('');
  console.log(' #  page                                           frame                                 node id        archetype     hash      nodes');
  picks.forEach((p, i) => {
    console.log(String(i + 1).padStart(2) + '  ' + p.page.slice(0, 44).padEnd(46) + p.name.slice(0, 34).padEnd(38) + p.id.padEnd(15) + p.archetype.padEnd(14) + p.hash.slice(0, 8) + '  ' + p.nodes);
  });
}
