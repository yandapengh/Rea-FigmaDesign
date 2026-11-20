/// <reference lib="es2022" />
/** Parse round-2 review answers into label truth. */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = '/Users/hyd/Downloads/rea-figma-review-round2.md';
const lines = readFileSync(FILE, 'utf8').split('\n');
interface Item { code: string; page: string; auto: string; ai: string; answer: string[]; rows: Array<{ id: string; note: string }> }
const items: Item[] = [];
let cur: Item | null = null;
for (const raw of lines) {
  const line = raw.trim();
  const m = /^### ([AB]\d+)\.\s*(.+?)\s*·\s*(.+)$/.exec(line);
  if (m) { cur = { code: m[1], page: m[2].trim(), auto: m[3].trim(), ai: '', answer: [], rows: [] }; items.push(cur); continue; }
  if (!cur) continue;
  if (line.startsWith('## ')) { cur = null; continue; }
  if (!line || line === '---') continue;
  if (line.startsWith('AI：')) { cur.ai = line.replace('AI：', '').replace(/ —.*$/, '').replace(/（推測.*$/, '').trim(); continue; }
  const idm = /^(\d+:\d+)\s*(?:-\s*(.*))?$/.exec(line);
  if (idm) { cur.rows.push({ id: idm[1], note: (idm[2] ?? '').trim() }); continue; }
  if (!/^\d+:\d+/.test(line)) cur.answer.push(line);
}
const dialog = new Set(['通用彈窗', '下拉抽屜彈窗', 'OTP彈窗', 'PIN確認彈窗', '指紋確認彈窗', '系統FaceID彈窗', '系統彈窗', '日期選擇器彈窗', '上傳avatar彈窗', '分帳確認彈窗', '修改手機號彈窗', 'Toast']);
const normalize = (s: string): string => {
  let t = s.replace(/[\u0060「」『』]/g, '').trim();
  t = t.replace(/^統一(標記|標註)成\s*/, '');
  t = t.replace(/^(應該|就是|是|叫做|屬於|它是|而是)\s*/, '');
  t = t.replace(/[。,.，].*$/, '');
  t = t.replace(/即可.*$/, '').trim();
  if (t === 'AI chat' || t === 'AI Chat' || t === 'AI Chat頁面') return 'AI Chat頁面';
  if (t === '交易歷史記錄' || t === '歷史交易記錄') return '交易歷史記錄';
  if (t === '支付結果頁' || t === '交易結果頁') return '交易結果頁';
  return t;
};
const extractLabel = (text: string): string => {
  const quoted = /[\u0060「『]([^\u0060」』]+)[\u0060」』]/.exec(text);
  if (quoted) return normalize(quoted[1]);
  const patterns = [/(?:統一(?:標記|標註)成|標記為|標註成|叫做|屬於|它是|應該是|是)\s*([^\s,，。;；]+)/, /(?:新類型頁面|新類型)\s*[:：]\s*([^,，。]+)/];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return normalize(m[1]);
  }
  return '';
};
const results: Array<{ id: string; label: string; major: string; minor: string; source: string; note: string }> = [];
const unresolved: string[] = [];
const majorOf = (label: string): { major: string; minor: string } => {
  const gm = /^(老UI|新UI|系統UI)\s*-\s*(.+)$/.exec(label);
  if (gm) return { major: gm[1], minor: gm[2].trim() };
  if (label === '老UI' || label === '新UI' || label === '系統UI') return { major: label, minor: '' };
  if (dialog.has(label)) return { major: '彈窗類', minor: label };
  return { major: '頁面類', minor: label };
};
for (const it of items) {
  const answerText = it.answer.join(' ');
  let clusterLabel = '';
  if (/^OK\b/i.test(answerText)) clusterLabel = it.ai;
  if (!clusterLabel) clusterLabel = extractLabel(answerText);
  if (/老UI/.test(answerText) && /通用彈窗/.test(answerText)) clusterLabel = '老UI - 通用彈窗';
  if (/系統頁面|系統UI/.test(answerText)) clusterLabel = '系統UI';
  if (!clusterLabel && it.rows.every((r) => !r.note)) { unresolved.push(it.code + ' ' + it.page + ' · ' + it.auto + ' | ' + answerText.slice(0, 60)); continue; }
  for (const r of it.rows) {
    const note = r.note.replace(/\s+/g, ' ').trim();
    let label = '';
    if (note) {
      if (/^老UI/.test(note)) label = note;
      else if (note.indexOf('廢棄') !== -1) label = '廢棄頁面';
      else label = extractLabel(note) || normalize(note.split(/[,，。]/)[0]);
    }
    if (!label) label = clusterLabel;
    if (!label) continue;
    const mm = majorOf(label);
    results.push({ id: r.id, label, major: mm.major, minor: mm.minor, source: it.code, note });
  }
}
const byId = new Map<string, (typeof results)[number]>();
for (const r of results) byId.set(r.id, r);
const rows = [...byId.values()];
const prior = JSON.parse(readFileSync('/tmp/truth.json', 'utf8')) as Array<{ id: string; label: string; generation: string }>;
const merged = new Map<string, { id: string; label: string; major: string; minor: string; generation: string }>();
for (const p of prior) {
  const mm = majorOf(p.label);
  merged.set(p.id, { id: p.id, label: p.label, major: mm.major, minor: mm.minor, generation: p.generation });
}
for (const r of rows) {
  const gm = /^(老UI|新UI)/.exec(r.major);
  merged.set(r.id, { id: r.id, label: r.label, major: r.major, minor: r.minor, generation: gm ? (gm[1] === '老UI' ? 'old' : 'new') : '' });
}
writeFileSync('/tmp/round2-answers.json', JSON.stringify({ results: rows, unresolved }, null, 2));
writeFileSync('/tmp/truth2.json', JSON.stringify([...merged.values()], null, 2));
console.log('items=' + items.length + ' new labels=' + rows.length + ' unresolved=' + unresolved.length + ' total truth=' + merged.size);
for (const u of unresolved) console.log('UNRESOLVED ' + u);
const majors = new Map<string, number>();
for (const r of merged.values()) majors.set(r.major, (majors.get(r.major) ?? 0) + 1);
console.log('majors: ' + [...majors.entries()].map(([k, v]) => k + '=' + v).join(' '));
