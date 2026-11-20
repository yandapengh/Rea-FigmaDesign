/// <reference lib="es2022" />
/** Fast colour-system separability test on a stratified sample. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph } from './core/graph';

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
const g = new Graph(dbPath);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const truth = JSON.parse(readFileSync('/tmp/truth5.json', 'utf8')) as Array<{ id: string; generation: string }>;
const tmap = new Map(truth.map((t) => [t.id, t]));
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
const old = roots.filter((id) => tmap.get(id)?.generation === 'old');
const neu = roots.filter((id) => tmap.get(id)?.generation === 'new');
const pick = (arr: string[], n: number): string[] => (arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));
const sample = [...pick(old, old.length), ...pick(neu, neu.length)];
console.log('sample=' + sample.length + ' (old=' + old.length + ', new=' + neu.length + ')');
const subIds = new Map<string, string[]>();
const allIds: string[] = [];
for (const id of sample) { const sub = g.subtree(id); subIds.set(id, sub); allIds.push(...sub); }
const uniqueIds = [...new Set(allIds)];
const styles = new Map<string, string>();
const chunk = 500;
for (let i = 0; i < uniqueIds.length; i += chunk) {
  const part = uniqueIds.slice(i, i + chunk);
  const rows = db.prepare('SELECT id, style_json FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string; style_json: string }>;
  for (const r of rows) styles.set(r.id, r.style_json);
}
const colorSets = new Map<string, string[]>();
for (const id of sample) {
  const counts = new Map<string, number>();
  for (const sid of subIds.get(id)!) {
    const raw = styles.get(sid);
    if (!raw) continue;
    let st: { fills?: Array<{ hex?: string; opacity?: number }>; strokes?: Array<{ hex?: string }> };
    try { st = JSON.parse(raw) as typeof st; } catch { continue; }
    for (const f of st.fills ?? []) {
      const op = typeof f.opacity === 'number' ? f.opacity : 1;
      if (op < 0.4 || !f.hex) continue;
      const h = f.hex.toUpperCase();
      if (h === '#FFFFFF' || h === '#000000') continue;
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    for (const s of st.strokes ?? []) {
      if (!s.hex) continue;
      const h = s.hex.toUpperCase();
      if (h === '#FFFFFF' || h === '#000000') continue;
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  colorSets.set(id, [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h]) => h));
}
const jac = (a: string[], b: string[]): number => {
  const A = new Set(a); const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.max(1, A.size + B.size - inter);
};
let ok = 0, total = 0;
for (const id of sample) {
  const want = tmap.get(id)!.generation;
  const scored = sample.filter((x) => x !== id).map((x) => ({ x, s: jac(colorSets.get(id)!, colorSets.get(x)!) })).sort((a, b) => b.s - a.s).slice(0, 5);
  const votes = new Map<string, number>();
  for (const s of scored) { const gen = tmap.get(s.x)!.generation; votes.set(gen, (votes.get(gen) ?? 0) + 1); }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  total += 1;
  if (best[0] === want) ok += 1;
}
console.log('colour-only kNN = ' + ok + '/' + total + ' = ' + Math.round((100 * ok) / total) + '%');
const oldC = new Map<string, number>(), newC = new Map<string, number>();
for (const id of sample) for (const c of colorSets.get(id)!) { const m = tmap.get(id)!.generation === 'old' ? oldC : newC; m.set(c, (m.get(c) ?? 0) + 1); }
const top = (m: Map<string, number>): string => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => h + '(' + n + ')').join(' ');
console.log('old: ' + top(oldC));
console.log('new: ' + top(newC));
