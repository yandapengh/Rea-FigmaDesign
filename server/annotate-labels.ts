/// <reference lib="es2022" />
/** Parse the annotated AI workbook: confirmations, corrections, per-ID overrides. */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = '/Users/hyd/Downloads/rea-figma-label-workbook.ai.md';
const lines = readFileSync(FILE, 'utf8').split('\n');
interface Row { id: string; note: string }
interface Cluster { page: string; auto: string; archetype: string; ai: string; comments: string[]; rows: Row[]; header: string }
const clusters: Cluster[] = [];
let page = '';
let current: Cluster | null = null;
for (const raw of lines) {
  const line = raw.trim();
  if (raw.startsWith('## ')) {
    const t = raw.slice(3).trim();
    if (t.startsWith('待下一輪')) page = t.replace(/^待下一輪 · /, '').replace(/（.*$/, '').trim();
    else page = t.replace(/^\d+\.\s*/, '').trim();
    current = null;
    continue;
  }
  if (raw.startsWith('### 分類')) {
    const m = /^### 分類\s+\d+（(.+?)）\s*·\s*([^·]+)·\s*(.*)$/.exec(raw);
    if (!m) continue;
    const auto = (m[3].split('·')[0] ?? '').trim().replace(/✅/g, '').replace(/🤖AI/g, '').trim();
    current = { page, auto, archetype: m[2].trim(), ai: '', comments: [], rows: [], header: m[1].trim() };
    clusters.push(current);
    continue;
  }
  if (!current) continue;
  if (line.startsWith('🤖 AI 建議：')) {
    current.ai = line.replace('🤖 AI 建議：', '').replace(/（.*$/, '').trim();
    continue;
  }
  if (line === '' || line === '---' || line.startsWith('## ') || line.startsWith('### ')) continue;
  const idm = /^(\d+:\d+)\s*(?:-\s*(.*))?$/.exec(line);
  if (idm) { current.rows.push({ id: idm[1], note: (idm[2] ?? '').trim() }); continue; }
  if (line.startsWith('確認') || line.includes('不準確') || line.includes('有問題') || line.includes('需要') || line.includes('要') || line.includes('是') || line.includes('屬於') || line.includes('注意')) {
    current.comments.push(line);
  } else {
    current.comments.push(line);
  }
}
const relevant = clusters.filter((c) => c.comments.length > 0 || c.rows.some((r) => r.note));
console.log('clusters with annotations=' + relevant.length);
for (const c of relevant) {
  console.log('');
  console.log('## ' + c.page);
  console.log('   auto=' + c.auto + '  ai=' + (c.ai || '-') + '  arch=' + c.archetype);
  for (const cm of c.comments) console.log('   💬 ' + cm);
  for (const r of c.rows) if (r.note) console.log('   - ' + r.id + ' → ' + r.note);
}
const out = { file: FILE, clusters: clusters.map((c) => ({ page: c.page, auto: c.auto, archetype: c.archetype, ai: c.ai, comments: c.comments, rows: c.rows, header: c.header })) };
writeFileSync('/tmp/annotated-clusters.json', JSON.stringify(out, null, 2));
console.log('');
console.log('parsed -> /tmp/annotated-clusters.json');
