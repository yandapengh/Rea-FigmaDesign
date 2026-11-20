/// <reference lib="es2022" />
/** Apply round-5 answers to truth5. */

import { readFileSync, writeFileSync } from 'node:fs';

interface C { page: string; auto: string; archetype: string; rows: Array<{ id: string; note: string }> }
const parsed = JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: C[] };
const truthOld = JSON.parse(readFileSync('/tmp/truth4.json', 'utf8')) as Array<{ id: string; label: string; major: string; minor: string; generation: string }>;
const ai = JSON.parse(readFileSync('/tmp/ai-v5.json', 'utf8')) as { hits: Array<{ index: number; label: string; source: string }> };
const truthIds = new Set(truthOld.map((t) => t.id));
const hitByIndex = new Map(ai.hits.map((h) => [h.index, h]));
const structure: number[] = [];
const open: number[] = [];
parsed.clusters.forEach((c, i) => {
  const ids = c.rows.map((r) => r.id);
  if (ids.some((id) => truthIds.has(id))) return;
  const hit = hitByIndex.get(i);
  if (hit && (hit.source === 'exact' || hit.source === 'keyword')) return;
  if (hit && hit.source === 'structure' && hit.label === '通用彈窗') { structure.push(i); return; }
  const auto = (c.auto ?? '').trim();
  const meaningful = auto.length > 1 && auto.indexOf('無名稱結構群') === -1 && auto !== '---' && auto !== '###';
  if (meaningful && ids.length >= 2) open.push(i);
});
open.sort((a, b) => parsed.clusters[b].rows.length - parsed.clusters[a].rows.length);
const items = [...structure, ...open.slice(0, 18)];
const answers = ['Event 詳情頁', '老UI', '廢棄頁面', 'KYC彈窗', '廢棄頁面', '廢棄頁面', 'MIXED', '廢棄頁面', '廢棄頁面', '廢棄頁面', '廢棄頁面', 'MIXED', 'MIXED', '註冊頁面', '註冊頁面', 'Voucher 列表', '老UI', '老UI'];
if (answers.length !== items.length) { console.error('mismatch ' + answers.length + ' vs ' + items.length); process.exit(1); }
const overrides: Record<string, string> = {
  '11676:133536': '廢棄頁面', '790:70941': '下拉抽屜彈窗',
  '12540:69087': 'KYC結果頁', '11676:633941': '廢棄頁面',
  '12517:281396': 'KYC彈窗', '12088:427400': '廢棄頁面',
};
const dialog = new Set(['通用彈窗', '下拉抽屜彈窗', 'OTP彈窗', 'PIN確認彈窗', '指紋確認彈窗', '系統FaceID彈窗', '系統彈窗', 'FaceID彈窗', '日期選擇器彈窗', '上傳avatar彈窗', '分帳確認彈窗', '修改手機號彈窗', 'Toast', 'T&C彈窗', 'KYC彈窗']);
const majorOf = (label: string): { major: string; minor: string } => {
  const gm = /^(老UI|新UI|系統UI)\s*-\s*(.+)$/.exec(label);
  if (gm) return { major: gm[1], minor: gm[2].trim() };
  if (label === '老UI' || label === '新UI' || label === '系統UI') return { major: label, minor: '' };
  if (dialog.has(label)) return { major: '彈窗類', minor: label };
  if (label === '廢棄頁面') return { major: '廢棄', minor: '廢棄頁面' };
  return { major: '頁面類', minor: label };
};
const merged = new Map<string, { id: string; label: string; major: string; minor: string; generation: string }>();
for (const p of truthOld) merged.set(p.id, p);
items.forEach((idx, k) => {
  const c = parsed.clusters[idx];
  const ans = answers[k];
  for (const r of c.rows) {
    const label = overrides[r.id] ?? (ans === 'MIXED' ? '' : ans);
    if (!label) continue;
    const mm = majorOf(label);
    const gen = mm.major === '老UI' ? 'old' : mm.major === '新UI' ? 'new' : '';
    merged.set(r.id, { id: r.id, label, major: mm.major, minor: mm.minor, generation: gen });
  }
});
const all = [...merged.values()];
writeFileSync('/tmp/truth5.json', JSON.stringify(all, null, 2));
const majors = new Map<string, number>();
for (const r of all) majors.set(r.major, (majors.get(r.major) ?? 0) + 1);
console.log('items=' + items.length + ' truth=' + all.length + ' majors=' + [...majors.entries()].map(([k, v]) => k + ':' + v).join(' '));
