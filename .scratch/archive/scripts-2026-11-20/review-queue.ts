/// <reference lib="es2022" />
/** Minimal review queue: only items that need a human this round. */

import { readFileSync, writeFileSync } from 'node:fs';

interface C { page: string; auto: string; archetype: string; comments: string[]; rows: Array<{ id: string; note: string }>; header: string }
const parsed = JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: C[] };
const truth = JSON.parse(readFileSync('/tmp/truth.json', 'utf8')) as Array<{ id: string }>;
const ai = JSON.parse(readFileSync('/tmp/ai-v2.json', 'utf8')) as { hits: Array<{ index: number; page: string; auto: string; archetype: string; label: string; source: string; gen: string; ids: string[] }> };
const truthIds = new Set(truth.map((t) => t.id));
const hitByIndex = new Map(ai.hits.map((h) => [h.index, h]));
const clusters = parsed.clusters;

const handled = { groups: 0, ids: 0 };
const structure: Array<{ c: C; h: (typeof ai.hits)[number] }> = [];
const open: C[] = [];
const deferred = { groups: 0, ids: 0 };
clusters.forEach((c, i) => {
  const ids = c.rows.map((r) => r.id);
  if (ids.some((id) => truthIds.has(id))) { handled.groups += 1; handled.ids += ids.length; return; }
  const hit = hitByIndex.get(i);
  if (hit && (hit.source === 'exact' || hit.source === 'keyword')) { handled.groups += 1; handled.ids += ids.length; return; }
  if (hit && hit.source === 'structure') { structure.push({ c, h: hit }); return; }
  const auto = (c.auto ?? '').trim();
  const meaningful = auto.length > 1 && auto.indexOf('無名稱結構群') === -1 && auto !== '---' && auto !== '###';
  if (meaningful && ids.length >= 2) open.push(c);
  else { deferred.groups += 1; deferred.ids += ids.length; }
});
open.sort((a, b) => b.rows.length - a.rows.length);
const cap = 24;
const openShown = open.slice(0, cap);
const out: string[] = [];
out.push('# 排查佇列 · 第二輪');
out.push('');
out.push('- 本輪只需要你看 ' + (structure.length + openShown.length) + ' 組');
out.push('- 已自動處理（不再打擾）' + handled.groups + ' 組 / ' + handled.ids + ' 個畫面');
out.push('- 留到下一輪 ' + (deferred.groups + Math.max(0, open.length - cap)) + ' 組（無名稱、單張長尾）');
out.push('');
out.push('## 大類與小類（先確認這個結構）');
out.push('');
out.push('| 大類 | 小類 |');
out.push('|---|---|');
out.push('| 老UI / 新UI | 交易詳情、選擇好友、彈窗、廢棄頁面、其他頁面 |');
out.push('| 彈窗類 | 通用彈窗、下拉抽屜彈窗、OTP彈窗、PIN確認彈窗、指紋確認彈窗、系統FaceID彈窗、Toast |');
out.push('| 頁面類 | 首頁、收銀台、交易詳情、付款輸入、活動詳情、列表、KYC、Welcome、二維碼、設置PIN、掃碼、Send Money、選擇好友 |');
out.push('');
out.push('規則：有老/新 UI 標記時，大類用 老UI／新UI；否則用 彈窗類／頁面類。小類只留一層。');
out.push('');
out.push('## A. 結構推測，請你確認（' + structure.length + ' 組）');
out.push('');
if (structure.length === 0) out.push('（無）');
structure.forEach((x, i) => {
  out.push('### A' + (i + 1) + '. ' + x.c.page + ' · ' + x.c.auto);
  out.push('');
  out.push('AI：' + x.h.label + (x.h.gen ? '（推測 ' + (x.h.gen === 'old' ? '老UI' : '新UI') + '）' : '') + ' — 回 OK 或改成你的小類。');
  out.push('');
  for (const id of x.h.ids) out.push(id);
  out.push('');
});
out.push('## B. 有名稱但無法自動分類（' + openShown.length + ' 組）');
out.push('');
if (openShown.length === 0) out.push('（無）');
openShown.forEach((c, i) => {
  out.push('### B' + (i + 1) + '. ' + c.page + ' · ' + c.auto);
  out.push('');
  for (const r of c.rows) out.push(r.id);
  out.push('');
});
if (open.length > cap) out.push('（另有 ' + (open.length - cap) + ' 組同類，留到下一輪）');
out.push('## C. 一句話回答');
out.push('');
out.push('1. 上面的「大類／小類」結構可以嗎？（可／改成…）');
out.push('2. 老UI／新UI 要不要直接寫進大類（例如 老UI · 交易詳情），還是只當標記？');
writeFileSync('/Users/hyd/Downloads/rea-figma-review-round2.md', out.join('\n') + '\n');
console.log('structure=' + structure.length + ' open=' + open.length + ' shown=' + openShown.length + ' deferred=' + (deferred.groups + open.length - openShown.length));
console.log('handled groups=' + handled.groups + ' ids=' + handled.ids);
