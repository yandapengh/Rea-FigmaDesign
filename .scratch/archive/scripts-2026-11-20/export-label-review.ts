/// <reference lib="es2022" />
/** Export a per-page labeling companion markdown to ~/Downloads. */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph, archetypeOf, headlineOf } from './core/graph';

const ROOT = resolve(__dirname, '..');
const OUT = '/Users/hyd/Downloads/rea-figma-label-review.md';
let dbPath = '';
for (const a of process.argv.slice(2)) if (!a.startsWith('--')) dbPath = resolve(ROOT, a);
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
const pages = db.prepare('SELECT page_id, page_name, page_index FROM pages ORDER BY page_index').all() as Array<{ page_id: string; page_name: string; page_index: number }>;
const meta = db.prepare('SELECT file_name, file_key FROM file_meta LIMIT 1').get() as { file_name: string; file_key: string } | undefined;
db.close();
const pageMeta = new Map(pages.map((p) => [p.page_id, p]));

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

interface Card { id: string; name: string; page: string; pageId: string; archetype: string; hash: string; nodes: number; headline: string; copies: number; cluster: string }
const norm = (s: string): string => {
  let t = s.toLowerCase().replace(/[（(【\[].*?[）)】\]]/g, ' ').replace(/\s+/g, ' ');
  t = t.replace(/(\/|-|_)(new|old|v\d+|copy|final)\b/g, ' ').replace(/\b\d{3,}\b/g, '#').replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
  if (/^frame\b/.test(t)) return 'frame';
  if (!t || t === '#') return '(unnamed)';
  return t;
};

const cards: Card[] = [];
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  const n = g.nodes.get(id)!;
  const texts: string[] = [];
  for (const sid of sub) { const t = g.nodes.get(sid)?.text_content; if (t) texts.push(t); }
  cards.push({ id, name: n.name, page: pageMeta.get(n.page_id)?.page_name ?? n.page_name, pageId: n.page_id, archetype: archetypeOf(g, id), hash: (g.hash.get(id) ?? '').slice(0, 8), nodes: sub.length, headline: headlineOf(texts), copies: 0, cluster: norm(n.name) });
}
const fam = new Map<string, number>();
for (const c of cards) fam.set(c.hash, (fam.get(c.hash) ?? 0) + 1);
for (const c of cards) c.copies = fam.get(c.hash) ?? 1;
const seen = new Set<string>();
const unique = cards.filter((c) => { const k = c.hash + '|' + c.headline; if (seen.has(k)) return false; seen.add(k); return true; });

const clean = (s: string): string => s.replace(/\|/g, '/').replace(/\n/g, ' ').trim();
const byPage = new Map<string, Card[]>();
for (const c of unique) {
  const list = byPage.get(c.pageId) ?? [];
  list.push(c);
  byPage.set(c.pageId, list);
}
const lines: string[] = [];
lines.push('# Rea-FigmaDesign 全量標註對照');
lines.push('');
lines.push('- 檔案：' + (meta ? meta.file_name : '?') + '（' + (meta ? meta.file_key : '?') + '）');
lines.push('- 產生：' + new Date().toISOString());
lines.push('- 資料：' + pages.length + ' 頁 · ' + cards.length + ' screens · ' + unique.length + ' unique（hash + 標題去重）');
lines.push('- 用法：先看「快速分類表」替每一頁填一個分類，再往下看逐頁 ID 陣列核對。');
lines.push('- ×N 代表同結構同標題的複本數；同一頁若有多個分類，可在下面註記。');
lines.push('');
lines.push('## 快速分類表');
lines.push('');
lines.push('| # | Figma 頁面 | unique 畫面 | 全部畫面 | 分類（請填） | 備註 |');
lines.push('|---|---|---|---|---|---|');
const orderedPages = pages.filter((p) => byPage.has(p.page_id));
orderedPages.forEach((p, i) => {
  const list = byPage.get(p.page_id)!;
  const total = list.reduce((acc, c) => acc + c.copies, 0);
  lines.push('| ' + (i + 1) + ' | ' + clean(p.page_name) + ' | ' + list.length + ' | ' + total + ' |  |  |');
});
lines.push('');
lines.push('## 逐頁明細');
lines.push('');
orderedPages.forEach((p, idx) => {
  const list = byPage.get(p.page_id)!.sort((a, b) => a.archetype.localeCompare(b.archetype) || b.nodes - a.nodes);
  lines.push('### ' + (idx + 1) + '. ' + clean(p.page_name));
  const count = { page: 0, overlay: 0, 'overlay-panel': 0 } as Record<string, number>;
  for (const c of list) count[c.archetype] = (count[c.archetype] ?? 0) + 1;
  lines.push('');
  lines.push('unique ' + list.length + ' · page ' + (count.page ?? 0) + ' · overlay ' + (count.overlay ?? 0) + ' · overlay-panel ' + (count['overlay-panel'] ?? 0));
  lines.push('');
  for (const arch of ['page', 'overlay', 'overlay-panel']) {
    const rows = list.filter((c) => c.archetype === arch);
    if (rows.length === 0) continue;
    lines.push('**' + arch + '（' + rows.length + '）**');
    lines.push('');
    for (const c of rows) {
      lines.push('- ' + c.id + ' · ' + clean(c.name).slice(0, 60) + ' · ' + c.nodes + ' nodes' + (c.copies > 1 ? ' · ×' + c.copies : '') + (c.headline ? ' · "' + clean(c.headline).slice(0, 40) + '"' : ''));
    }
    lines.push('');
  }
});
lines.push('## 同名畫面跨頁對照');
lines.push('');
lines.push('同一個畫面名稱出現在哪些頁面，方便判斷是否同一類。');
lines.push('');
const clusters = new Map<string, Card[]>();
for (const c of unique) {
  const list = clusters.get(c.cluster) ?? [];
  list.push(c);
  clusters.set(c.cluster, list);
}
const topClusters = [...clusters.entries()].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 120);
for (const [key, list] of topClusters) {
  lines.push('### ' + key + '（' + list.length + ' unique / ' + list.reduce((s, c) => s + c.copies, 0) + ' screens）');
  lines.push('');
  for (const c of list.sort((a, b) => a.page.localeCompare(b.page))) lines.push('- ' + c.id + ' · ' + clean(c.page) + ' · ' + clean(c.name).slice(0, 48) + ' · ' + c.archetype);
  lines.push('');
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log('written ' + OUT);
console.log('pages=' + orderedPages.length + ' screens=' + cards.length + ' unique=' + unique.length + ' clusters=' + topClusters.length);
