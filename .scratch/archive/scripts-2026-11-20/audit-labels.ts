/// <reference lib="es2022" />
/** Parse the labeled workbook and audit label semantics. */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = process.argv[2] || '/Users/hyd/Downloads/rea-figma-label-workbook.md';
const lines = readFileSync(FILE, 'utf8').split('\n');
interface Entry { page: string; label: string; archetype: string; note: string; ids: string[]; labeled: boolean; deferred: boolean }
const entries: Entry[] = [];
let page = '';
let current: Entry | null = null;
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
    const rawLabel = m[1].trim();
    const labeled = !rawLabel.includes('請命名') && rawLabel !== '';
    current = { page, label: rawLabel.replace(/✅/g, '').trim(), archetype: m[2].trim(), note: m[3].trim(), ids: [], labeled, deferred };
    entries.push(current);
    continue;
  }
  if (current) {
    const t = line.trim();
    const idm = /^(\d+:\d+)\s*(?:-\s*(.*))?$/.exec(t);
    if (idm) { current.ids.push(idm[1]); if (idm[2]) current.note = (current.note ? current.note + ' | ' : '') + idm[2]; }
  }
}
const labeled = entries.filter((e) => e.labeled && e.ids.length > 0);
const unlabeled = entries.filter((e) => !e.labeled && e.ids.length > 0);
const labels = new Map<string, { count: number; pages: Set<string>; arches: Set<string> }>();
for (const e of labeled) {
  const rec = labels.get(e.label) ?? { count: 0, pages: new Set<string>(), arches: new Set<string>() };
  rec.count += 1; rec.pages.add(e.page); rec.arches.add(e.archetype);
  labels.set(e.label, rec);
}
console.log('pages=' + new Set(entries.map((e) => e.page)).size + ' clusters=' + entries.length + ' labeled=' + labeled.length + ' unlabeled=' + unlabeled.length);
console.log('labeled ids=' + labeled.reduce((a, e) => a + e.ids.length, 0));
console.log('');
console.log('--- distinct labels ---');
for (const [k, v] of [...labels.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(v.count.toString().padStart(2) + '  ' + k + '   [' + [...v.arches].join(',') + ']');
}
console.log('');
console.log('--- suspicious text ---');
for (const line of lines) {
  if (/✅/.test(line) && !line.startsWith('###') && !line.startsWith('##')) console.log('  ✅ in body: ' + line.slice(0, 100));
}
const out = { file: FILE, labeled, unlabeled, labels: [...labels.entries()].map(([label, v]) => ({ label, count: v.count, pages: [...v.pages], archetypes: [...v.arches] })) };
writeFileSync('/tmp/workbook-parsed.json', JSON.stringify(out, null, 2));
console.log('');
console.log('parsed -> /tmp/workbook-parsed.json');
