/// <reference lib="es2022" />
/** Round-4 minimal review queue. */

import { readFileSync, writeFileSync } from 'node:fs';

interface C { page: string; auto: string; archetype: string; rows: Array<{ id: string; note: string }> }
const parsed = JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: C[] };
const truth = JSON.parse(readFileSync('/tmp/truth3.json', 'utf8')) as Array<{ id: string }>;
const ai = JSON.parse(readFileSync('/tmp/ai-v4.json', 'utf8')) as { hits: Array<{ index: number; page: string; auto: string; label: string; source: string; ids: string[] }> };
const truthIds = new Set(truth.map((t) => t.id));
const hitByIndex = new Map(ai.hits.map((h) => [h.index, h]));
const handled = { groups: 0, ids: 0 };
const structure: Array<{ c: C; h: (typeof ai.hits)[number] }> = [];
const open: C[] = [];
let deferred = 0;
parsed.clusters.forEach((c, i) => {
  const ids = c.rows.map((r) => r.id);
  if (ids.some((id) => truthIds.has(id))) { handled.groups += 1; handled.ids += ids.length; return; }
  const hit = hitByIndex.get(i);
  if (hit && (hit.source === 'exact' || hit.source === 'keyword')) { handled.groups += 1; handled.ids += ids.length; return; }
  if (hit && hit.source === 'structure' && hit.label === '通用彈窗') { structure.push({ c, h: hit }); return; }
  const auto = (c.auto ?? '').trim();
  const meaningful = auto.length > 1 && auto.indexOf('無名稱結構群') === -1 && auto !== '---' && auto !== '###';
  if (meaningful && ids.length >= 2) open.push(c);
  else deferred += 1;
});
open.sort((a, b) => b.rows.length - a.rows.length);
const cap = 18;
const shown = open.slice(0, cap);
const out: string[] = [];
out.push('# 排查佇列 · 第四輪');
out.push('');
out.push('- 本輪只需要你看 ' + (structure.length + shown.length) + ' 組');
out.push('- 已自動處理（不再打擾）' + handled.groups + ' 組 / ' + handled.ids + ' 個畫面');
out.push('- 留到下一輪 ' + (deferred + open.length - shown.length) + ' 組');
out.push('');
out.push('## A. 結構推測（僅通用彈窗）');
out.push('');
if (structure.length === 0) out.push('（無）');
structure.forEach((x, i) => {
  out.push('### A' + (i + 1) + '. ' + x.c.page + ' · ' + x.c.auto);
  out.push('');
  out.push('AI：通用彈窗 — 回 OK 或改成你的小類。');
  out.push('');
  for (const id of x.h.ids) out.push(id);
  out.push('');
});
out.push('## B. 有名稱但無法自動分類（' + shown.length + ' 組）');
out.push('');
shown.forEach((c, i) => {
  out.push('### B' + (i + 1) + '. ' + c.page + ' · ' + c.auto);
  out.push('');
  for (const r of c.rows) out.push(r.id);
  out.push('');
});
if (open.length > cap) out.push('（另有 ' + (open.length - cap) + ' 組留到下一輪）');
writeFileSync('/Users/hyd/Downloads/rea-figma-review-round4.md', out.join('\n') + '\n');
console.log('structure=' + structure.length + ' open=' + open.length + ' shown=' + shown.length + ' deferred=' + deferred + ' handled=' + handled.groups + '/' + handled.ids);
