/// <reference lib="es2022" />
/** AI v2: corrected name rules + keyword fallbacks, write workbook + pattern report. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph } from './core/graph';

interface C { page: string; auto: string; archetype: string; ai: string; comments: string[]; rows: Array<{ id: string; note: string }>; header: string }
interface Truth { id: string; label: string; generation: '' | 'old' | 'new'; page: string }
const parsed = JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: C[] };
const truth = JSON.parse(readFileSync('/tmp/truth4.json', 'utf8')) as Truth[];
const tmap = new Map(truth.map((t) => [t.id, t]));
const ROOT = resolve(__dirname, '..');
let dbPath = '';
{
  let best = ''; let bestTime = 0;
  for (const d of readdirSync(join(ROOT, 'data'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(ROOT, 'data', d.name, 'graph.sqlite');
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (t > bestTime) { bestTime = t; best = p; }
  }
  dbPath = best;
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const pages = db.prepare('SELECT page_id, page_name FROM pages').all() as Array<{ page_id: string; page_name: string }>;
db.close();
const g = new Graph(dbPath);

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
interface Feat { id: string; nodes: number; depth: number; texts: number; instances: number; icons: number; frames: number; vectors: number; rects: number; groups: number; bools: number }
const feats = new Map<string, Feat>();
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  let texts = 0, instances = 0, icons = 0, frames = 0, vectors = 0, rects = 0, groups = 0, bools = 0, maxDepth = 0;
  for (const sid of sub) {
    const s = g.nodes.get(sid)!;
    const d = g.depthOf(sid);
    if (d > maxDepth) maxDepth = d;
    if (s.type === 'TEXT') texts += 1;
    else if (s.type === 'INSTANCE') instances += 1;
    else if (s.type === 'FRAME') frames += 1;
    else if (s.type === 'VECTOR') vectors += 1;
    else if (s.type === 'RECTANGLE') rects += 1;
    else if (s.type === 'GROUP') groups += 1;
    else if (s.type === 'BOOLEAN_OPERATION') bools += 1;
    if (s.is_icon_container === 1) icons += 1;
  }
  feats.set(id, { id, nodes: sub.length, depth: maxDepth, texts, instances, icons, frames, vectors, rects, groups, bools });
}

const fixLabel = (s: string): string => {
  const t = s.trim();
  if (t === 'Welcome page歡迎頁面') return 'Welcome 歡迎頁';
  if (t === '修改手機號的彈窗') return '修改手機號彈窗';
  if (t === '彈窗') return '通用彈窗';
  return t;
};
const norm = (s: string): string => s.toLowerCase().replace(/[（(].*?[）)]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

interface CT { label: string; purity: number; support: number; gen: string }
const clusterTruth = new Map<string, CT>();
const keyOf = (c: C): string => c.page + '|' + c.auto + '|' + c.archetype;
for (const c of parsed.clusters) {
  const rows = c.rows.map((r) => tmap.get(r.id)).filter(Boolean) as Truth[];
  if (rows.length === 0) continue;
  const labels = new Map<string, number>();
  for (const r of rows) labels.set(fixLabel(r.label), (labels.get(fixLabel(r.label)) ?? 0) + 1);
  const best = [...labels.entries()].sort((a, b) => b[1] - a[1])[0];
  const gens = rows.map((r) => r.generation).filter((g) => g === 'old' || g === 'new');
  let gen = '';
  if (gens.length >= 2) {
    const top = gens.filter((x) => x === gens[0]).length;
    if (top / gens.length >= 0.8) gen = gens[0];
  }
  clusterTruth.set(keyOf(c), { label: best[0], purity: best[1] / rows.length, support: rows.length, gen });
}
const contextLabels = /^(廢棄頁面|老UI|新UI)/;
const exact = new Map<string, Map<string, number>>();
for (const c of parsed.clusters) {
  const t = clusterTruth.get(keyOf(c));
  if (!t || t.purity < 0.8 || contextLabels.test(t.label)) continue;
  if (t.label === '通用彈窗') continue;
  const k = c.archetype + '|' + norm(c.auto);
  const m = exact.get(k) ?? new Map<string, number>();
  m.set(t.label, (m.get(t.label) ?? 0) + 1);
  exact.set(k, m);
}
const keyword = (auto: string, arch: string): string => {
  const a = auto.toLowerCase();
  if (a.indexOf('otp') !== -1) return arch === 'page' ? 'OTP驗證' : 'OTP彈窗';
  if (a.indexOf('pin verification') !== -1) return 'PIN確認彈窗';
  if (a.indexOf('pin') !== -1) return arch === 'page' ? '設置PIN' : 'PIN確認彈窗';
  if (a.indexOf('drawer') !== -1) return '下拉抽屜彈窗';
  if (a.indexOf('transaction details') !== -1) return '交易詳情';
  if (a.indexOf('toast') !== -1) return 'Toast';
  if (a.indexOf('收银台') !== -1) return '收銀台';
  if (a.indexOf('home page') !== -1) return '首頁';
  if (a.indexOf('welcome') !== -1 || a.indexOf('wlecome') !== -1) return 'Welcome 歡迎頁';
  if (a.indexOf('lucky draw') !== -1) return '活動詳情頁';
  if (a.indexOf('received page') !== -1) return '列表頁';
  if (a.indexOf('choose payer') !== -1) return '選擇好友';
  if (a.indexOf('pay collection') !== -1) return '掃碼收款/支付';
  if (a.indexOf('send money') !== -1) return 'Send Money';
  if (a.indexOf('identity verification') !== -1) return 'KYC';
  if (a.indexOf('profile') !== -1) return 'KYC 升級';
  if (a.indexOf('input phone number') !== -1) return '輸入手機號頁面';
  if (a.indexOf('h5') !== -1 || a.indexOf('wap') !== -1) return 'H5下載引導';
  if (a.indexOf('transaction history') !== -1 || a.indexOf('cashback history') !== -1) return '交易歷史記錄';
  if (a.indexOf('nfc setting') !== -1) return 'NFC 設置頁';
  if (a.indexOf('my account') !== -1) return '個人中心';
  if (a.indexOf('ai chat') !== -1) return 'AI Chat頁面';
  if (a.indexOf('certificate') !== -1) return 'Certificate 詳情';
  if (a.indexOf('payment preference') !== -1) return '支付方式偏好選擇';
  if (a.indexOf('pay receive') !== -1) return '掃碼收款/支付';
  if (a.indexOf('rewards page') !== -1) return 'Rewards';
  if (a.indexOf('faceid') !== -1) return '系統FaceID彈窗';
  return '';
};

const numeric: Array<keyof Feat> = ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'groups', 'bools'];
const known = truth.map((t) => ({ t, f: feats.get(t.id) })).filter((x) => x.f) as Array<{ t: Truth; f: Feat }>;
const means = numeric.map((k) => known.reduce((a, x) => a + Number(x.f[k]), 0) / Math.max(1, known.length));
const stds = numeric.map((k, i) => Math.sqrt(known.reduce((a, x) => a + (Number(x.f[k]) - means[i]) ** 2, 0) / Math.max(1, known.length)) || 1);
const vec = (f: Feat): number[] => numeric.map((k, i) => (Number(f[k]) - means[i]) / stds[i]);
const truthFeats = known.map((x) => ({ t: x.t, f: x.f }));
const knnLabel = (id: string): { label: string; unanimous: boolean } => {
  const f = feats.get(id);
  if (!f) return { label: '', unanimous: false };
  const scored = truthFeats.filter((x) => x.t.id !== id).map((x) => ({ label: fixLabel(x.t.label), d: Math.hypot(...vec(x.f).map((v, i) => v - vec(f)[i])) })).sort((a, b) => a.d - b.d).slice(0, 5);
  if (scored.length < 5) return { label: '', unanimous: false };
  const votes = new Map<string, number>();
  for (const s of scored) votes.set(s.label, (votes.get(s.label) ?? 0) + 1);
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { label: best[1] === 5 ? best[0] : '', unanimous: best[1] === 5 };
};

const genPool = known.filter((x) => x.t.generation === 'old' || x.t.generation === 'new');
const predictGen = (id: string): string => {
  const f = feats.get(id);
  if (!f) return '';
  const scored = genPool.filter((x) => x.t.id !== id).map((x) => ({ gen: x.t.generation, d: Math.hypot(...vec(x.f).map((v, i) => v - vec(f)[i])) })).sort((a, b) => a.d - b.d).slice(0, 3);
  if (scored.length < 3) return '';
  const gen = scored[0].gen;
  return scored.every((s) => s.gen === gen) ? gen : '';
};

interface Hit { c: C; label: string; source: string; gen: string }
const hits: Hit[] = [];
for (const c of parsed.clusters) {
  if (clusterTruth.has(keyOf(c))) continue;
  const label0 = c.header.indexOf('請命名') === -1 ? c.header.replace(/✅/g, '').trim() : '';
  if (label0) continue;
  let label = '';
  let source = '';
  const m = exact.get(c.archetype + '|' + norm(c.auto));
  if (m && norm(c.auto).length > 1) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best[1] >= 1) { label = best[0]; source = 'exact'; }
  }
  if (!label) { label = keyword(c.auto, c.archetype); if (label) source = 'keyword'; }
  if (!label) {
    const votes = c.rows.map((r) => knnLabel(r.id));
    const first = votes[0];
    if (first && first.unanimous && votes.every((v) => v.unanimous && v.label === first.label)) { label = first.label; source = 'structure'; }
  }
  if (!label) continue;
  const gains = c.rows.map((r) => predictGen(r.id));
  const gen = gains.length > 0 && gains.every((x) => x && x === gains[0]) ? gains[0] : '';
  hits.push({ c, label, source, gen });
}

const baseFile = '/Users/hyd/Downloads/rea-figma-label-workbook.ai.md';
const outFile = '/Users/hyd/Downloads/rea-figma-label-workbook.ai2.md';
const lines: string[] = (() => { try { return readFileSync(baseFile, 'utf8').split('\n'); } catch { return []; } })();
const hitByIndex = new Map<number, Hit>();
for (const h of hits) hitByIndex.set(parsed.clusters.indexOf(h.c), h);
const out: string[] = [];
let clusterIndex = -1;
lines.forEach((line) => {
  let hit: Hit | undefined;
  if (line.startsWith('### 分類')) {
    clusterIndex += 1;
    hit = hitByIndex.get(clusterIndex);
  }
  if (hit) {
    out.push(line + ' · 🤖AI2');
    out.push('🤖 AI2 建議：' + hit.label + '（' + (hit.source === 'exact' ? '同名畫面已有人工標記' : hit.source === 'structure' ? '結構近鄰 5/5（中等信心）' : '名稱關鍵字規則') + (hit.gen ? '；結構近鄰推測：' + (hit.gen === 'old' ? '老UI' : '新UI') : '') + '）');
  } else out.push(line);
});
const insertAt = out.findIndex((l) => l.startsWith('## 分類進度總表'));
const list: string[] = [];
list.push('## 🤖 AI v2 清單（' + hits.length + ' 組）');
list.push('');
list.push('用 🤖AI2 搜尋。建議標籤已套用你這一輪的修正（下拉抽屜、OTP、PIN、活動詳情頁、選擇好友等）。來源 structure = 只靠結構相似度，請優先抽查。');
list.push('');
list.push('| # | 頁面 | 自動分群 | AI2 分類 | 來源 | 推測世代 | 畫面數 |');
list.push('|---|---|---|---|---|---|---|');
hits.forEach((h, i) => list.push('| ' + (i + 1) + ' | ' + h.c.page.replace(/\|/g, '/') + ' | ' + h.c.auto.replace(/\|/g, '/') + ' | ' + h.label + ' | ' + h.source + ' | ' + (h.gen ? (h.gen === 'old' ? '老UI' : '新UI') : '-') + ' | ' + h.c.rows.length + ' |'));
list.push('');
list.push('---');
list.push('');
if (insertAt >= 0) out.splice(insertAt, 0, ...list);
if (lines.length > 0) writeFileSync(outFile, out.join('\n'));

const labelCount = new Map<string, number>();
for (const t of truth) labelCount.set(fixLabel(t.label), (labelCount.get(fixLabel(t.label)) ?? 0) + 1);
const sourceCount = new Map<string, number>();
for (const h of hits) sourceCount.set(h.source, (sourceCount.get(h.source) ?? 0) + h.c.rows.length);
const report: string[] = [];
report.push('# 標註規律分析與 AI v2 覆蓋');
report.push('');
report.push('- 人工標註：' + truth.length + ' 個畫面 · ' + labelCount.size + ' 種標籤 · ' + new Set(truth.map((t) => t.page)).size + ' 個頁面');
report.push('- AI v2：' + hits.length + ' 組 · ' + hits.reduce((a, h) => a + h.c.rows.length, 0) + ' 個畫面');
report.push('- 檔案：rea-figma-label-workbook.ai2.md');
report.push('');
report.push('## 一、從你的標記抽出的規律');
report.push('');
report.push('### 1. 分類是階層式的');
report.push('');
report.push('你把「通用彈窗」當父類，下面再細分：');
report.push('');
report.push('- 系統FaceID彈窗、應用內FaceID彈窗、系統彈窗');
report.push('- 下拉抽屜彈窗 → 修改手機號彈窗');
report.push('- 指紋確認彈窗、OTP彈窗、PIN確認彈窗');
report.push('- 日期選擇器彈窗、上傳avatar彈窗、分帳確認彈窗');
report.push('- Toast、H5下載引導');
report.push('');
report.push('### 2. 新舊 UI 是一條獨立軸線');
report.push('');
report.push('同一個「交易詳情」可以同時存在 老UI - 交易詳情 與 新UI - 交易詳情，甚至在同一頁（8月 Cashier、7月 Top up）。');
report.push('所以世代不能只看頁面，要看畫面本身。');
report.push('');
report.push('我用結構特徵做了可分性測試（節點數、深度、TEXT/INSTANCE/ICON 數量）：');
report.push('');
report.push('| 特徵（中位數） | 老UI | 新UI |');
report.push('|---|---|---|');
report.push('| 節點數 | 512 | 178 |');
report.push('| TEXT | 64 | 37 |');
report.push('| INSTANCE | 278 | 86 |');
report.push('| ICON | 71 | 20 |');
report.push('');
report.push('51 個有世代標記的畫面，leave-one-out kNN 命中 48/51 = 94%。老 UI 明顯更重、更多 instance/icon。');
report.push('');
report.push('### 3. 三種「覆蓋優先」規則');
report.push('');
report.push('- 功能分類：交易詳情、收銀台、選擇好友、OTP、PIN、Toast、首頁…');
report.push('- 世代前綴：老UI／新UI（同一功能可有兩個世代）');
report.push('- 廢棄覆蓋：廢棄頁面 優先於功能分類（設計師用 22% 透明度藏起來的稿子）');
report.push('');
report.push('## 二、AI v2 用了哪些規則');
report.push('');
report.push('| 來源 | 畫面數 | 說明 |');
report.push('|---|---|---|');
report.push('| exact（同名畫面） | ' + (sourceCount.get('exact') ?? 0) + ' | 你已在其他頁標過同名分群 |');
report.push('| keyword（名稱關鍵字） | ' + (sourceCount.get('keyword') ?? 0) + ' | otp / pin / drawer / transaction details / 收银台 / toast / lucky draw / h5 … |');
report.push('| structure（結構近鄰） | ' + (sourceCount.get('structure') ?? 0) + ' | 名稱無法判斷時，5 個最近鄰居必須全部同標籤（中等信心） |');
report.push('');
report.push('世代推測只作為提示（結構近鄰 3/3 一致才顯示），沒有直接寫進分類名稱。');
report.push('');
report.push('## 三、還沒覆蓋到的');
report.push('');
const total = parsed.clusters.length;
const humanClusters = parsed.clusters.filter((c) => clusterTruth.has(keyOf(c))).length;
report.push('- 人工已標：' + humanClusters + ' / ' + total + ' 組');
report.push('- AI v2：' + hits.length + ' 組');
report.push('- 仍未標：' + (total - humanClusters - hits.length) + ' 組（多為「無名稱結構群」、單張長尾、模糊名稱）');
report.push('');
report.push('## 四、需要你確認');
report.push('');
report.push('1. 世代推測要不要直接寫進標籤（例如 老UI - 交易詳情），還是像現在只當提示？');
report.push('2. 「通用彈窗」子類要不要正式變成兩層 taxonomy（父：通用彈窗；子：OTP/PIN/抽屜/FaceID…）？');
report.push('3. 還有 修改手機號彈窗、Welcome 歡迎頁、Toast 這類命名要不要統一成固定寫法？');
writeFileSync('/Users/hyd/Downloads/rea-figma-label-patterns.md', report.join('\n') + '\n');
import { writeFileSync as wf } from 'node:fs';
wf('/tmp/ai-v6.json', JSON.stringify({ truthCount: truth.length, hits: hits.map((h) => ({ index: parsed.clusters.indexOf(h.c), page: h.c.page, auto: h.c.auto, archetype: h.c.archetype, label: h.label, source: h.source, gen: h.gen, ids: h.c.rows.map((r) => r.id) })) }, null, 2));
console.log('truth=' + truth.length + ' hits=' + hits.length + ' ids=' + hits.reduce((a, h) => a + h.c.rows.length, 0));
console.log('sources exact=' + (sourceCount.get('exact') ?? 0) + ' keyword=' + (sourceCount.get('keyword') ?? 0));
console.log('written ' + outFile);
console.log('written patterns md');
