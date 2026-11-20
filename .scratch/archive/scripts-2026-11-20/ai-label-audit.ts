/// <reference lib="es2022" />
/** Audit human labels + build an AI-suggested workbook (conservative exact-name rules). */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = process.argv[2] || '/Users/hyd/Downloads/rea-figma-label-workbook.md';
const AI_FILE = '/Users/hyd/Downloads/rea-figma-label-workbook.ai.md';
const AUDIT_FILE = '/Users/hyd/Downloads/rea-figma-label-audit.md';
const lines = readFileSync(FILE, 'utf8').split('\n');

interface Cluster { page: string; label: string; auto: string; archetype: string; ids: string[]; annotated: string[]; labeled: boolean; deferred: boolean; headerLine: number }
const clusters: Cluster[] = [];
let page = '';
let current: Cluster | null = null;
let deferred = false;
lines.forEach((line, i) => {
  if (line.startsWith('## ')) {
    const t = line.slice(3).trim();
    if (t.startsWith('待下一輪')) { deferred = true; page = t.replace(/^待下一輪 · /, '').replace(/（.*$/, '').trim(); }
    else { deferred = false; page = t.replace(/^\d+\.\s*/, '').trim(); }
    current = null;
    return;
  }
  if (line.startsWith('### 分類')) {
    const m = /^### 分類\s+\d+（(.+?)）\s*·\s*([^·]+)·\s*(.*)$/.exec(line);
    if (!m) return;
    const raw = m[1].trim().replace(/✅/g, '').trim();
    const auto = (m[3].split('·')[0] ?? '').trim().replace(/✅/g, '').trim();
    current = { page, label: raw, auto, archetype: m[2].trim(), ids: [], annotated: [], labeled: !raw.includes('請命名') && raw !== '', deferred, headerLine: i };
    clusters.push(current);
    return;
  }
  if (current) {
    const idm = /^(\d+:\d+)\s*(?:-\s*(.*))?$/.exec(line.trim());
    if (idm) { current.ids.push(idm[1]); if (idm[2]) current.annotated.push(idm[2]); }
  }
});

const norm = (s: string): string => s.toLowerCase().replace(/[（(].*?[）)]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const labeled = clusters.filter((c) => c.labeled && c.ids.length > 0);
const unlabeled = clusters.filter((c) => !c.labeled && c.ids.length > 0);
const byKey = new Map<string, Cluster[]>();
for (const c of labeled) {
  const key = c.archetype + '|' + norm(c.auto);
  const list = byKey.get(key) ?? [];
  list.push(c);
  byKey.set(key, list);
}

const isContext = (label: string): boolean => /老UI|廢棄/.test(label);
const isMeaningful = (auto: string): boolean => auto.length > 1 && auto.indexOf('無名稱結構群') === -1 && auto !== '---' && auto !== '###';
const conflicts: Array<{ key: string; labels: string[] }> = [];
const rules: Array<{ key: string; label: string; pages: number }> = [];
for (const [key, list] of byKey.entries()) {
  const labels = [...new Set(list.map((c) => c.label))];
  if (labels.length > 1) { conflicts.push({ key, labels }); continue; }
  if (!isMeaningful(list[0].auto)) continue;
  if (isContext(list[0].label)) continue;
  rules.push({ key, label: list[0].label, pages: new Set(list.map((c) => c.page)).size });
}
const ruleMap = new Map(rules.map((r) => [r.key, r]));
const hits: Array<{ cluster: Cluster; rule: { label: string; pages: number } }> = [];
for (const c of unlabeled) {
  const rule = ruleMap.get(c.archetype + '|' + norm(c.auto));
  if (rule) hits.push({ cluster: c, rule });
}

const out: string[] = [];
const hitByLine = new Map(hits.map((h) => [h.cluster.headerLine, h]));
lines.forEach((line, i) => {
  const hit = hitByLine.get(i);
  if (!hit) { out.push(line); return; }
  out.push(line + ' · 🤖AI');
  out.push('🤖 AI 建議：' + hit.rule.label + '（同名畫面已在 ' + hit.rule.pages + ' 個頁面被你標記；請確認或改成你的分類）');
});
const insertAt = out.findIndex((l) => l.startsWith('## 分類進度總表'));
const aiList: string[] = [];
aiList.push('## 🤖 AI 標記清單（' + hits.length + ' 組）');
aiList.push('');
aiList.push('用 🤖AI 搜尋即可跳到原文；每一組都來自你已命名的同名畫面。');
aiList.push('');
aiList.push('| # | 頁面 | 自動分群 | AI 分類 | 畫面數 |');
aiList.push('|---|---|---|---|---|');
hits.forEach((h, i) => aiList.push('| ' + (i + 1) + ' | ' + h.cluster.page.replace(/\|/g, '/') + ' | ' + h.cluster.auto.replace(/\|/g, '/') + ' | ' + h.rule.label + ' | ' + h.cluster.ids.length + ' |'));
aiList.push('');
aiList.push('---');
aiList.push('');
if (insertAt >= 0) out.splice(insertAt, 0, ...aiList);
writeFileSync(AI_FILE, out.join('\n'));

const labelCount = new Map<string, number>();
for (const c of labeled) labelCount.set(c.label, (labelCount.get(c.label) ?? 0) + 1);
const audit: string[] = [];
audit.push('# 標註語意檢查（第一輪）');
audit.push('');
audit.push('- 檢查檔：' + FILE);
audit.push('- 已標註：' + labeled.length + ' / ' + clusters.length + ' 組 · ' + labeled.reduce((a, c) => a + c.ids.length, 0) + ' 個畫面 ID');
audit.push('- AI 可保守推斷：' + hits.length + ' 組（已寫入 rea-figma-label-workbook.ai.md）');
audit.push('');
audit.push('## 一、標籤清單');
audit.push('');
audit.push('| 標籤 | 次數 |');
audit.push('|---|---|');
for (const [k, n] of [...labelCount.entries()].sort((a, b) => b[1] - a[1])) audit.push('| ' + k + ' | ' + n + ' |');
audit.push('');
audit.push('## 二、需要你敲定的語意問題');
audit.push('');
audit.push('### 1. 「通用彈窗」目前是萬用桶（' + labeled.filter((x) => x.label === '通用彈窗').length + ' 組）');
audit.push('');
audit.push('你標成通用彈窗的內容其實包含不同類型：');
audit.push('');
for (const c of labeled.filter((x) => x.label === '通用彈窗')) audit.push('- ' + c.page + ' · ' + c.auto + '（' + c.ids.length + ' 個）');
audit.push('');
audit.push('建議拆成：OTP 驗證彈窗 / 生物辨識彈窗 / 抽屜彈窗 / 錯誤或系統彈窗 / 通用彈窗（其餘）。');
audit.push('若你想維持單一「通用彈窗」也可以，但 AI 往後無法細分，且 OTP 類會和 page 的「OTP驗證」不一致。');
audit.push('');
audit.push('### 2. OTP 同類畫面有三種叫法');
audit.push('');
audit.push('- page 的 OTP驗證');
audit.push('- overlay 的 OTP彈窗');
audit.push('- Cashier Invoke 頁的 otp verification 目前叫「通用彈窗」');
audit.push('');
audit.push('建議統一：page 用「OTP 驗證頁」、彈窗用「OTP 驗證彈窗」；不要讓同類落在通用桶。');
audit.push('');
audit.push('### 3. 老 UI / 廢棄頁面 有 5 種寫法');
audit.push('');
audit.push('廢棄頁面、老UI - 廢棄頁面、老UI、老UI零散頁面、老UI - 輸入手機號頁面，以及一個把說明寫進標籤的長字串。');
audit.push('建議二選一：');
audit.push('- 只保留「廢棄頁面」（所有不再維護的都進去，包含老 UI）');
audit.push('- 或「老UI（仍在使用）」與「廢棄頁面」兩類');
audit.push('');
audit.push('### 4. 其他建議正名');
audit.push('');
audit.push('| 現在 | 建議 |');
audit.push('|---|---|');
audit.push('| Welcome page歡迎頁面 | Welcome 歡迎頁 |');
audit.push('| Toast | Toast 提示 |');
audit.push('| 列表頁（Lucky Draw received page） | 中獎／領取列表頁 |');
audit.push('| 掃碼收款/支付 | 拆成「掃碼收款」「掃碼支付」，或統一「掃碼」 |');
audit.push('| 廢棄頁面,它們是老UI,彈窗類型,建議標記廢棄頁面即可 | 廢棄頁面（把說明移到備註） |');
audit.push('');
audit.push('## 三、從你標記找出的規律（AI 採用）');
audit.push('');
audit.push('| 同名畫面（原型的自動分群） | 你給的分類 | 出現頁數 |');
audit.push('|---|---|---|');
for (const r of rules.sort((a, b) => b.pages - a.pages)) audit.push('| ' + r.key.split('|')[1] + ' | ' + r.label + ' | ' + r.pages + ' |');
audit.push('');
if (conflicts.length > 0) {
  audit.push('## 四、暫不推斷的衝突（同名但被你標成不同類）');
  audit.push('');
  for (const c of conflicts) audit.push('- ' + c.key.split('|')[1] + ' → ' + c.labels.join(' / '));
  audit.push('');
}
audit.push('## 五、下一步');
audit.push('');
audit.push('1. 你回覆上面 1–4 的選擇（或直接改檔案裡的標籤）。');
audit.push('2. 我依最終 taxonomy 重跑 AI 推斷，輸出第二版工作簿。');
audit.push('3. 你只查 🤖AI 的段落，把錯的改成你的分類或 unknown。');
writeFileSync(AUDIT_FILE, audit.join('\n') + '\n');

console.log('labeled=' + labeled.length + ' unlabeled=' + unlabeled.length + ' conflicts=' + conflicts.length + ' rules=' + rules.length);
console.log('AI hits=' + hits.length + ' ids=' + hits.reduce((a, h) => a + h.cluster.ids.length, 0));
console.log('written ' + AI_FILE);
console.log('written ' + AUDIT_FILE);
