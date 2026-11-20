/// <reference lib="es2022" />
/** Export a copy-friendly labeling workbook (one section per Figma page, ID-only clusters). */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph, archetypeOf, headlineOf } from './core/graph';

const ROOT = resolve(__dirname, '..');
const OUT = '/Users/hyd/Downloads/rea-figma-label-workbook.md';
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
const meta = db.prepare('SELECT file_name FROM file_meta LIMIT 1').get() as { file_name: string } | undefined;
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

const GENERIC = /^(frame|content|dialog[ -]?page|component|instance|unnamed|---+|\d+)$/;
const normName = (s: string): string => {
  let t = s.toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, ' ')
    .replace(/(\/|-|_)(new|old|v\d+|copy|final)\b/g, ' ')
    .replace(/\b\d{3,}\b/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (GENERIC.test(t) || /^frame\b/.test(t)) return '';
  return t;
};

interface Screen { id: string; name: string; pageId: string; page: string; archetype: string; hash: string; nodes: number; headline: string; cluster: string }
const screens: Screen[] = [];
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  const n = g.nodes.get(id)!;
  const texts: string[] = [];
  for (const sid of sub) { const t = g.nodes.get(sid)?.text_content; if (t) texts.push(t); }
  const norm = normName(n.name);
  const hash = (g.hash.get(id) ?? '').slice(0, 8);
  screens.push({ id, name: n.name, pageId: n.page_id, page: pageMeta.get(n.page_id)?.page_name ?? n.page_name, archetype: archetypeOf(g, id), hash, nodes: sub.length, headline: headlineOf(texts), cluster: norm === '' ? 'G:' + hash : 'N:' + norm });
}
// unique screens: one representative per (hash + headline)
const seen = new Set<string>();
const unique = screens.filter((s) => { const k = s.hash + '|' + s.headline; if (seen.has(k)) return false; seen.add(k); return true; });
// copies per hash (for the header count)
const fam = new Map<string, number>();
for (const s of screens) fam.set(s.hash, (fam.get(s.hash) ?? 0) + 1);

const byPage = new Map<string, Screen[]>();
for (const s of unique) {
  const list = byPage.get(s.pageId) ?? [];
  list.push(s);
  byPage.set(s.pageId, list);
}
const ordered = pages.filter((p) => byPage.has(p.page_id));

const lines: string[] = [];
lines.push('# Rea-FigmaDesign 標註工作表');
lines.push('');
lines.push('- 檔案：' + (meta ? meta.file_name : '?') + '');
lines.push('- ' + pages.length + ' 頁（' + ordered.length + ' 頁有畫面）· ' + screens.length + ' screens · ' + unique.length + ' unique');
lines.push('- 用法：每個「分類 N（請命名）」下面就是同一類的畫面 ID；直接複製 ID 到 Figma 定位。');
lines.push('- 命名：把「請命名」改成你的分類名稱（例如 OTP 驗證彈窗）；不確定就寫 unknown 或留空。');
lines.push('- 一個分類就是一種畫面；同結構複本只列一個代表，標題上的「共 N 個」是全部數量。');
lines.push('');
lines.push('## 分類進度總表');
lines.push('');
lines.push('| # | Figma 頁面 | 畫面數 | 主要分類 | 待下一輪 | 已命名 |');
lines.push('|---|---|---|---|---|---|');
const pageClusters = new Map<string, Map<string, Screen[]>>();
for (const p of ordered) {
  const list = byPage.get(p.page_id)!;
  const groups = new Map<string, Screen[]>();
  for (const s of list) {
    const key = s.archetype + '|' + s.cluster;
    const bucket = groups.get(key) ?? [];
    bucket.push(s);
    groups.set(key, bucket);
  }
  pageClusters.set(p.page_id, groups);
  const primaryCount = [...groups.entries()].filter(([, rows]) => rows.length >= 2 || rows.reduce((acc, r) => acc + (fam.get(r.hash) ?? 1), 0) >= 8).length;
  const deferredCount = list.length - [...groups.entries()].filter(([, rows]) => rows.length >= 2 || rows.reduce((acc, r) => acc + (fam.get(r.hash) ?? 1), 0) >= 8).reduce((acc, [, rows]) => acc + rows.length, 0);
  lines.push('| ' + (ordered.indexOf(p) + 1) + ' | ' + p.page_name.replace(/\|/g, '/') + ' | ' + list.length + ' | ' + primaryCount + ' | ' + deferredCount + ' |  |');
}
lines.push('');

ordered.forEach((p, idx) => {
  const list = byPage.get(p.page_id)!;
  const allGroups = [...pageClusters.get(p.page_id)!.entries()].sort((a, b) => b[1].length - a[1].length);
  const groups = allGroups.filter(([, rows]) => rows.length >= 2 || rows.reduce((acc, r) => acc + (fam.get(r.hash) ?? 1), 0) >= 8);
  const deferred = allGroups.filter(([key]) => !groups.some(([k2]) => k2 === key));
  lines.push('## ' + (idx + 1) + '. ' + p.page_name.replace(/\|/g, '/'));
  lines.push('');
  lines.push(list.length + ' 個畫面 · ' + groups.length + ' 種主要分類（請命名）' + (deferred.length ? ' · ' + deferred.reduce((acc, [, rows]) => acc + rows.length, 0) + ' 個畫面留待下一輪' : ''));
  lines.push('');
  groups.forEach(([key, rows], gi) => {
    const arch = key.split('|')[0];
    const rawCluster = key.slice(key.indexOf('|') + 1);
    const clusterLabel = rawCluster.startsWith('G:') ? '（無名稱結構群）' : rawCluster.slice(2);
    const total = rows.reduce((acc, r) => acc + (fam.get(r.hash) ?? 1), 0);
    lines.push('### 分類 ' + (gi + 1) + '（請命名） · ' + arch + ' · ' + clusterLabel + ' · ' + rows.length + ' 個 unique · 共 ' + total + ' 個');
    lines.push('');
    for (const r of rows.sort((a, b) => b.nodes - a.nodes)) lines.push(r.id);
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  if (deferred.length > 0) {
    lines.push('## 待下一輪 · ' + p.page_name.replace(/\|/g, '/') + '（' + deferred.reduce((acc, [, rows]) => acc + rows.length, 0) + ' 個畫面）');
    lines.push('');
    lines.push('先不要花時間；等主要分類標完再處理。');
    lines.push('');
    for (const [, rows] of deferred) for (const r of rows.sort((a, b) => b.nodes - a.nodes)) lines.push(r.id);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
});
writeFileSync(OUT, lines.join('\n') + '\n');
console.log('written ' + OUT);
console.log('pages=' + ordered.length + ' screens=' + screens.length + ' unique=' + unique.length);
