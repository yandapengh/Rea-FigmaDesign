/// <reference lib="es2022" />
/** Merge human annotations into a ground-truth label set. */

import { readFileSync, writeFileSync } from 'node:fs';

interface C { page: string; auto: string; archetype: string; ai: string; comments: string[]; rows: Array<{ id: string; note: string }>; header: string }
const parsed = JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: C[] };
const clusters: C[] = parsed.clusters;

const normGen = (s: string): string => s.replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
const cleanAi = (s: string): string => s.replace(/（[^）]*）/g, '').trim();
interface Truth { id: string; label: string; generation: 'old' | 'new' | ''; page: string; source: string; note: string }
const truth: Truth[] = [];
const push = (id: string, label: string, generation: 'old' | 'new' | '', page: string, source: string, note: string): void => {
  if (!id || !label) return;
  truth.push({ id, label, generation, page, source, note });
};
const splitGen = (label: string): { base: string; gen: 'old' | 'new' | '' } => {
  const m = /^(老UI|新UI)\s*-\s*(.+)$/.exec(label);
  if (!m) return { base: label.trim(), gen: '' };
  return { base: m[2].trim(), gen: m[1] === '老UI' ? 'old' : 'new' };
};
const normalizeIdNote = (note: string): { label: string; note: string } => {
  const n = note.trim();
  if (!n) return { label: '', note: '' };
  if (n.indexOf('老UI零散頁面') !== -1) return { label: '老UI - 老UI零散頁面', note: n };
  if (n.indexOf('老UI') === 0) return { label: normGen(n.split('(')[0].trim()), note: n };
  if (n.indexOf('下拉抽屜彈窗') !== -1 && n.indexOf('修改手機號') !== -1) return { label: '修改手機號彈窗', note: n };
  if (n.indexOf('下拉抽屜彈窗') !== -1) return { label: '下拉抽屜彈窗', note: n };
  if (n.indexOf('FaceID') !== -1) return { label: '系統FaceID彈窗', note: n };
  if (n === '系統彈窗') return { label: '系統彈窗', note: '' };
  if (n.indexOf('廢棄頁面') !== -1) return { label: '廢棄頁面', note: n };
  if (n.indexOf('空頁面') !== -1) return { label: '空頁面', note: n };
  if (n.indexOf('活動詳情頁') !== -1) return { label: '活動詳情頁', note: n };
  if (n.indexOf('首頁') !== -1) return { label: '首頁', note: n };
  if (n.indexOf('Toast') !== -1) return { label: 'Toast', note: n };
  if (n.indexOf('選擇好友') !== -1) return { label: '選擇好友', note: n };
  if (n.indexOf('掃碼收款') !== -1) return { label: '掃碼收款/支付', note: n };
  if (n.indexOf('設置PIN') !== -1) return { label: '設置PIN', note: n };
  if (n.indexOf('老UI') !== -1) return { label: normGen(n), note: n };
  return { label: n.split(',')[0].trim(), note: n };
};

for (const c of clusters) {
  const baseRaw = c.header.indexOf('請命名') === -1 ? c.header.replace(/✅/g, '').trim() : cleanAi(c.ai);
  const base = splitGen(baseRaw);
  const joined = c.comments.join(' ');
  const skip = joined.indexOf('下一輪') !== -1 && c.rows.every((r) => !r.note);
  if (skip) continue;

  let clusterLabel = base.base;
  let clusterGen: 'old' | 'new' | '' = base.gen;
  if (!clusterLabel) {
    // per-ID only clusters (human wrote labels on each line)
  } else if (joined.indexOf('下拉抽屜彈窗') !== -1) {
    clusterLabel = '下拉抽屜彈窗';
    clusterGen = '';
  } else if (joined.indexOf('老UI') !== -1 && joined.indexOf('交易詳情') !== -1) {
    clusterLabel = '交易詳情';
    clusterGen = 'old';
  } else if (joined.indexOf('選擇好友') !== -1 && joined.indexOf('都是') !== -1) {
    clusterLabel = '選擇好友';
    clusterGen = '';
  } else if (joined.indexOf('都是廢棄頁面') !== -1) {
    clusterLabel = '廢棄頁面';
    clusterGen = '';
  }

  for (const r of c.rows) {
    if (r.note) {
      const nn = normalizeIdNote(r.note);
      if (nn.label) {
        const sg = splitGen(nn.label);
        push(r.id, sg.base, sg.gen, c.page, 'per-id', nn.note);
      }
      continue;
    }
    if (clusterLabel) push(r.id, clusterLabel, clusterGen, c.page, 'cluster', '');
  }
}
// dedupe by id, later annotation wins
const byId = new Map<string, Truth>();
for (const t of truth) byId.set(t.id, t);
const rows = [...byId.values()];
writeFileSync('/tmp/truth.json', JSON.stringify(rows, null, 2));

const labels = new Map<string, number>();
for (const r of rows) labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
const gens = { old: 0, new: 0, '': 0 } as Record<string, number>;
for (const r of rows) gens[r.generation] += 1;
const pages = new Set(rows.map((r) => r.page));
console.log('truth ids=' + rows.length + '  labels=' + labels.size + '  pages=' + pages.size);
console.log('generation old=' + gens.old + ' new=' + gens.new + ' none=' + gens['']);
console.log('');
for (const [k, n] of [...labels.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(3) + '  ' + k);
