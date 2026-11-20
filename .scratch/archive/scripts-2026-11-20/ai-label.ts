/// <reference lib="es2022" />
/** Learn label rules from the human-labeled workbook and preview AI coverage. */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = process.argv[2] || '/Users/hyd/Downloads/rea-figma-label-workbook.md';
const lines = readFileSync(FILE, 'utf8').split('\n');
interface Cluster { page: string; label: string; auto: string; archetype: string; ids: string[]; labeled: boolean; deferred: boolean; line: number }
const clusters: Cluster[] = [];
let page = '';
let current: Cluster | null = null;
let deferred = false;
for (const line of lines) {
  if (line.startsWith('## ')) {
    const t = line.slice(3).trim();
    if (t.startsWith('待下一輪')) { deferred = true; page = t.replace(/^待下一輪 · /, '').replace(/（.*$/, '').trim(); }
    else { deferred = false; page = t.replace(/^\d+\.\s*/, '').trim(); }
    current = null;
    continue;
  }
  if (line.startsWith('### 分類')) {
    const m = /^### 分類\s+\d+（(.+?)）\s*·\s*([^·]+)·\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[1].trim().replace(/✅/g, '').trim();
    const parts = m[3].split('·');
    const auto = (parts[0] ?? '').trim();
    current = { page, label: raw, auto, archetype: m[2].trim(), ids: [], labeled: !raw.includes('請命名') && raw !== '', deferred, line: -1 };
    clusters.push(current);
    continue;
  }
  if (current) {
    const idm = /^(\d+:\d+)\s*(?:-\s*(.*))?$/.exec(line.trim());
    if (idm) current.ids.push(idm[1]);
  }
}
const norm = (s: string): string => s.toLowerCase().replace(/[（(].*?[）)]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const labeled = clusters.filter((c) => c.labeled && c.ids.length > 0);
const unlabeled = clusters.filter((c) => !c.labeled && c.ids.length > 0);
const exact = new Map<string, Map<string, number>>();
for (const c of labeled) {
  const key = c.archetype + '|' + norm(c.auto);
  const m = exact.get(key) ?? new Map<string, number>();
  m.set(c.label, (m.get(c.label) ?? 0) + 1);
  exact.set(key, m);
}
const pick = (key: string): { label: string; confidence: number } | null => {
  const m = exact.get(key);
  if (!m) return null;
  const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  return { label: entries[0][0], confidence: Math.round((entries[0][1] / total) * 100) / 100 };
};
interface Hit { page: string; auto: string; archetype: string; label: string; confidence: number; ids: string[] }
const hits: Hit[] = [];
const missed: Cluster[] = [];
for (const c of unlabeled) {
  if (!c.auto || c.auto.indexOf('無名稱結構群') !== -1) { missed.push(c); continue; }
  const hit = pick(c.archetype + '|' + norm(c.auto));
  if (hit) hits.push({ page: c.page, auto: c.auto, archetype: c.archetype, label: hit.label, confidence: hit.confidence, ids: c.ids });
  else missed.push(c);
}
console.log('clusters=' + clusters.length + ' labeled=' + labeled.length + ' unlabeled=' + unlabeled.length);
console.log('exact-name rules=' + exact.size);
console.log('AI hits=' + hits.length + '  ids=' + hits.reduce((a, h) => a + h.ids.length, 0) + '  missed=' + missed.length);
console.log('');
console.log('--- rules learned (auto name + archetype -> label) ---');
for (const [k, m] of [...exact.entries()].sort()) console.log('  ' + k + '  ->  ' + [...m.entries()].map(([l, n]) => l + '×' + n).join(', '));
console.log('');
console.log('--- AI hits ---');
for (const h of hits) console.log('  ' + h.page + ' | ' + h.auto + ' | ' + h.archetype + ' -> ' + h.label + ' (' + h.ids.length + ')');
writeFileSync('/tmp/ai-preview.json', JSON.stringify({ clusters, labeled, unlabeled, hits, missed }, null, 2));
console.log('');
console.log('preview -> /tmp/ai-preview.json');
