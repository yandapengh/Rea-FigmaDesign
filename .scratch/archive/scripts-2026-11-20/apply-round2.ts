/// <reference lib="es2022" />
/** Apply round-2 answers (hard-coded from the returned sheet) to truth2. */

import { readFileSync, writeFileSync } from 'node:fs';

interface C { page: string; auto: string; archetype: string; rows: Array<{ id: string; note: string }> }
const parsed = JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: C[] };
const truthOld = JSON.parse(readFileSync('/tmp/truth.json', 'utf8')) as Array<{ id: string; label: string; generation: string }>;
const ai = JSON.parse(readFileSync('/tmp/ai-v2.json', 'utf8')) as { hits: Array<{ index: number; label: string; source: string }> };
const truthIds = new Set(truthOld.map((t) => t.id));
const hitByIndex = new Map(ai.hits.map((h) => [h.index, h]));

// rebuild the same review items as round 2
const structure: number[] = [];
const open: number[] = [];
parsed.clusters.forEach((c, i) => {
  const ids = c.rows.map((r) => r.id);
  if (ids.some((id) => truthIds.has(id))) return;
  const hit = hitByIndex.get(i);
  if (hit && (hit.source === 'exact' || hit.source === 'keyword')) return;
  if (hit && hit.source === 'structure') { structure.push(i); return; }
  const auto = (c.auto ?? '').trim();
  const meaningful = auto.length > 1 && auto.indexOf('無名稱結構群') === -1 && auto !== '---' && auto !== '###';
  if (meaningful && ids.length >= 2) open.push(i);
});
open.sort((a, b) => parsed.clusters[b].rows.length - parsed.clusters[a].rows.length);
const openShown = open.slice(0, 24);
const items = [...structure, ...openShown];

const A = ['通用彈窗', '通用彈窗', '付款輸入頁面', '通用彈窗', '通用彈窗', '通用彈窗', '通用彈窗', '通用彈窗', '掃碼收款/支付', '首頁', '系統UI', 'Certificate 詳情', '收銀台', '設置PIN', '老UI - 通用彈窗', '老UI - 通用彈窗', '老UI - 通用彈窗', 'MIXED', '通用彈窗'];
const B = ['AI Chat頁面', '老UI', 'MIXED', 'MIXED', '老UI', 'AI Chat頁面', '老UI', 'MIXED', '老UI', 'MIXED', '交易歷史記錄', '老UI', '廢棄頁面', '交易結果頁', '老UI', '個人中心', '收銀台', 'MIXED', 'MIXED', 'MIXED', '支付方式偏好選擇', '交易歷史記錄', 'NFC 設置頁', '老UI'];
const answers = [...A, ...B];
if (answers.length !== items.length) {
  console.error('answer count mismatch: answers=' + answers.length + ' items=' + items.length);
  process.exit(1);
}
const overrides: Record<string, string> = {
  '11728:713833': '廢棄頁面', '11728:713837': '廢棄頁面', '11728:713850': '通用彈窗',
  '13112:214791': '消息通知類', '13112:214838': '消息通知類', '13112:214885': '消息通知類', '13112:215608': '消息通知類',
  '11728:735498': '消息通知類', '11728:735508': '消息通知類', '18720:239325': '消息通知類',
  '11679:301920': '老UI - 消息通知類', '11679:302034': '老UI - 消息通知類', '11679:308447': '老UI - 消息通知類',
  '13112:210983': '支付結果頁', '13112:210991': '支付結果頁', '13112:211205': '支付結果頁', '18720:233031': '支付結果頁',
  '13101:112518': 'Tap結果頁', '13101:121470': 'Tap結果頁', '11728:731283': 'Tap結果頁', '11728:731673': 'Tap結果頁', '11728:730362': 'Tap結果頁',
  '13112:211212': '廢棄頁面',
  '15091:199882': 'Tap&Pay 陣地頁', '13532:193008': 'Tap&Pay 陣地頁', '11728:732178': 'Tap&Pay 陣地頁', '13532:194201': 'Tap&Pay 陣地頁', '13101:103986': 'Tap&Pay 陣地頁', '15726:219544': 'Tap&Pay 陣地頁',
  '13101:110358': '廢棄頁面',
  '13101:110431': '廢棄頁面', '11728:727185': 'Tap&Pay 陣地頁', '13101:102304': 'Tap&Pay 陣地頁', '11728:727125': '廢棄頁面', '11728:730307': '廢棄頁面', '11728:726785': '廢棄頁面',
  '11728:713555': '廢棄頁面', '11990:462984': '交易結果頁', '11728:713504': '老UI - 交易結果頁', '11728:713505': '老UI - 交易結果頁', '11728:713503': '老UI - 交易結果頁',
  '11676:380442': '卡管理頁', '11676:380436': '卡管理頁', '11676:380443': '卡管理頁', '11676:380434': '卡管理頁', '11676:380444': '廢棄頁面',
  '11676:148763': '系統短信頁', '11676:148799': '系統短信頁', '11676:148812': '系統短信頁', '11676:148806': '老UI - 消息中心',
};
const dialog = new Set(['通用彈窗', '下拉抽屜彈窗', 'OTP彈窗', 'PIN確認彈窗', '指紋確認彈窗', '系統FaceID彈窗', '系統彈窗', '日期選擇器彈窗', '上傳avatar彈窗', '分帳確認彈窗', '修改手機號彈窗', 'Toast']);
const majorOf = (label: string): { major: string; minor: string } => {
  const gm = /^(老UI|新UI|系統UI)\s*-\s*(.+)$/.exec(label);
  if (gm) return { major: gm[1], minor: gm[2].trim() };
  if (label === '老UI' || label === '新UI' || label === '系統UI') return { major: label, minor: '' };
  if (dialog.has(label)) return { major: '彈窗類', minor: label };
  if (label === '廢棄頁面') return { major: '廢棄', minor: '廢棄頁面' };
  return { major: '頁面類', minor: label };
};
const merged = new Map<string, { id: string; label: string; major: string; minor: string; generation: string }>();
for (const p of truthOld) {
  const mm = majorOf(p.label);
  merged.set(p.id, { id: p.id, label: p.label, major: mm.major, minor: mm.minor, generation: p.generation });
}
items.forEach((idx, k) => {
  const c = parsed.clusters[idx];
  const answer = answers[k];
  for (const r of c.rows) {
    const label = overrides[r.id] ?? (answer === 'MIXED' ? '' : answer);
    if (!label) continue;
    const mm = majorOf(label);
    const gen = mm.major === '老UI' ? 'old' : mm.major === '新UI' ? 'new' : '';
    merged.set(r.id, { id: r.id, label, major: mm.major, minor: mm.minor, generation: gen });
  }
});
const all = [...merged.values()];
writeFileSync('/tmp/truth2.json', JSON.stringify(all, null, 2));
const labels = new Map<string, number>();
const majors = new Map<string, number>();
for (const r of all) { labels.set(r.label, (labels.get(r.label) ?? 0) + 1); majors.set(r.major, (majors.get(r.major) ?? 0) + 1); }
console.log('items=' + items.length + ' truth total=' + all.length + ' labels=' + labels.size);
console.log('majors: ' + [...majors.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join('  '));
console.log('');
for (const [k, v] of [...labels.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(3) + '  ' + k);
