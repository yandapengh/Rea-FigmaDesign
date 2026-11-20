/// <reference lib="es2022" />
/** Generate .scratch/review.html for the newest graph: all unique screens, filters, markdown export. */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph, archetypeOf, headlineOf } from './core/graph';

const ROOT = resolve(__dirname, '..');
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
interface Card { id: string; name: string; page: string; archetype: string; hash: string; nodes: number; headline: string; copies: number }
const cards: Card[] = [];
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  const n = g.nodes.get(id)!;
  const texts: string[] = [];
  for (const sid of sub) { const t = g.nodes.get(sid)?.text_content; if (t) texts.push(t); }
  cards.push({ id, name: n.name, page: pageMeta.get(n.page_id)?.name ?? n.page_name, archetype: archetypeOf(g, id), hash: (g.hash.get(id) ?? '').slice(0, 8), nodes: sub.length, headline: headlineOf(texts), copies: 0 });
}
const fam = new Map<string, number>();
for (const c of cards) fam.set(c.hash, (fam.get(c.hash) ?? 0) + 1);
for (const c of cards) c.copies = fam.get(c.hash) ?? 1;
const seen = new Set<string>();
const unique = cards.filter((c) => { const k = c.hash + '|' + c.headline; if (seen.has(k)) return false; seen.add(k); return true; });

const payload = JSON.stringify({ db: dbPath, screens: roots.length, cards: unique });
const html = [
'<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Rea-FigmaDesign 全量分類排查</title>',
'<style>',
'*{box-sizing:border-box}body{margin:0;background:#0e1117;color:#e6e8ee;font:13px/1.5 -apple-system,"PingFang TC",system-ui,sans-serif}',
'header{position:sticky;top:0;z-index:5;background:#0e1117f2;border-bottom:1px solid #212734;padding:12px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
'h1{font-size:14px;margin:0 8px 0 0}.muted{color:#7d879c;font-size:12px}',
'input,select{background:#121824;border:1px solid #2c3546;color:#e6e8ee;border-radius:7px;padding:6px 9px;font-size:12px}',
'input{width:240px}button{background:#222a38;border:1px solid #2c3546;color:#dfe4f0;padding:6px 11px;border-radius:7px;font-size:12px;cursor:pointer}',
'button.primary{background:#2f6df6;border-color:#2f6df6;color:#fff}',
'table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;color:#7d879c;font-weight:500;padding:7px 10px;border-bottom:1px solid #212734;position:sticky;top:57px;background:#0e1117}',
'td{padding:6px 10px;border-bottom:1px solid #171d27;vertical-align:middle}tr:hover td{background:#121824}',
'.id{font-family:ui-monospace,Menlo,monospace;color:#9fb4ff;cursor:copy;white-space:nowrap}',
'.arch{font-size:11px;padding:1px 7px;border-radius:99px;background:#1b2230;color:#9aa6bd}.arch.overlay{background:#2a1f33;color:#d3a8ff}.arch.overlay-panel{background:#1e2a33;color:#8fd3ff}',
'.copy{color:#aeb8cc;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'</style><body>',
'<header><h1>Rea-FigmaDesign · 全量分類排查</h1><span class="muted" id="stat"></span>',
'<input id="q" placeholder="搜尋畫面／頁面／標題／ID"><select id="arch"><option value="">全部原型</option><option>page</option><option>overlay</option><option>overlay-panel</option></select>',
'<select id="page"><option value="">全部頁面</option></select>',
'<button id="md" class="primary">匯出目前篩選的 Markdown</button><button id="copy">複製目前清單 ID</button></header>',
'<table><thead><tr><th>#</th><th>node_id</th><th>頁面</th><th>畫面／圖層</th><th>原型</th><th>節點</th><th>複本</th><th>標題</th></tr></thead><tbody id="rows"></tbody></table>',
'<script>var DATA=' + payload + ';',
'var rowsEl=document.getElementById("rows"),q=document.getElementById("q"),arch=document.getElementById("arch"),page=document.getElementById("page"),stat=document.getElementById("stat");',
'var pages={};DATA.cards.forEach(function(c){pages[c.page]=1});Object.keys(pages).sort().forEach(function(p){var o=document.createElement("option");o.value=p;o.textContent=p;page.appendChild(o)});',
'function filtered(){var t=q.value.toLowerCase();return DATA.cards.filter(function(c){if(arch.value&&c.archetype!==arch.value)return false;if(page.value&&c.page!==page.value)return false;if(!t)return true;return (c.id+" "+c.page+" "+c.name+" "+(c.headline||"")).toLowerCase().indexOf(t)>=0})}',
'function esc(s){return String(s).replace(/[&<>]/g,function(m){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[m]})}',
'function render(){var list=filtered();stat.textContent="unique "+DATA.cards.length+" / screens "+DATA.screens+" · 目前 "+list.length;var h="";list.forEach(function(c,i){h+="<tr><td>"+(i+1)+"</td><td class=id data-id=\\""+c.id+"\\">"+c.id+"</td><td>"+esc(c.page)+"</td><td>"+esc(c.name)+"</td><td><span class=\\"arch "+c.archetype+"\\">"+c.archetype+"</span></td><td>"+c.nodes+"</td><td>"+c.copies+"</td><td class=copy>"+esc(c.headline||"")+"</td></tr>"});rowsEl.innerHTML=h;bind()}',
'function bind(){document.querySelectorAll(".id").forEach(function(el){el.onclick=function(){navigator.clipboard.writeText(el.getAttribute("data-id"));el.style.color="#6fe0a4";setTimeout(function(){el.style.color="#9fb4ff"},800)}})}',
'function markdown(){var list=filtered(),out=["| # | node_id | 頁面 | 畫面／圖層 | 原型 | 節點 | 標題 | 分類（請填） |","|---|---|---|---|---|---|---|---|"];list.forEach(function(c,i){out.push("| "+(i+1)+" | "+c.id+" | "+c.page.replace(/\\|/g,"/")+" | "+c.name.replace(/\\|/g,"/").slice(0,40)+" | "+c.archetype+" | "+c.nodes+" | "+(c.headline||"").replace(/\\|/g,"/").slice(0,24)+" |  |")});return out.join("\\n")}',
'document.getElementById("md").onclick=function(){var text=markdown();navigator.clipboard.writeText(text);var b=this;b.textContent="已複製 Markdown";setTimeout(function(){b.textContent="匯出目前篩選的 Markdown"},1200)};',
'document.getElementById("copy").onclick=function(){var ids=filtered().map(function(c){return c.id});var b=this;navigator.clipboard.writeText(ids.join("\\n"));b.textContent="已複製 "+ids.length+" 個 ID";setTimeout(function(){b.textContent="複製目前清單 ID"},1200)};',
'q.oninput=render;arch.onchange=render;page.onchange=render;render();',
'</script></body></html>',
].join('\n');
writeFileSync(join(ROOT, '.scratch/review.html'), html);
console.log('review.html written · unique=' + unique.length + ' screens=' + roots.length + ' db=' + dbPath);
