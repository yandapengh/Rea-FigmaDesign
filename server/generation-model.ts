/// <reference lib="es2022" />
/** Generation model: colour fingerprint + structure, trained on human labels only. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
const truth8 = JSON.parse(readFileSync('/tmp/truth8.json', 'utf8')) as Array<{ id: string; label: string; major: string; minor: string; generation: string }>;
const truth5 = JSON.parse(readFileSync('/tmp/truth5.json', 'utf8')) as Array<{ id: string; label: string; major: string; minor: string; generation: string }>;
const tmap = new Map(truth8.map((t) => [t.id, t]));
const human = new Map(truth5.map((t) => [t.id, t]));

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
const rootSet = new Set(roots);
// node -> nearest screen root
const nodeRoot = new Map<string, string>();
for (const root of roots) {
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (nodeRoot.has(id)) continue;
    nodeRoot.set(id, root);
    const kids = g.children.get(id);
    if (kids) for (const k of kids) stack.push(k);
  }
}
const palettes = new Map<string, Map<string, number>>();
const stmt = db.prepare('SELECT id, style_json FROM nodes');
for (const row of stmt.iterate() as Iterable<{ id: string; style_json: string }>) {
  const root = nodeRoot.get(row.id);
  if (!root) continue;
  let st: { fills?: Array<{ hex?: string; opacity?: number }>; strokes?: Array<{ hex?: string }> };
  try { st = JSON.parse(row.style_json) as typeof st; } catch { continue; }
  let pal = palettes.get(root);
  if (!pal) { pal = new Map<string, number>(); palettes.set(root, pal); }
  for (const f of st.fills ?? []) {
    const op = typeof f.opacity === 'number' ? f.opacity : 1;
    if (op < 0.4 || !f.hex) continue;
    const h = f.hex.toUpperCase();
    if (h === '#FFFFFF' || h === '#000000') continue;
    pal.set(h, (pal.get(h) ?? 0) + 1);
  }
  for (const s of st.strokes ?? []) {
    if (!s.hex) continue;
    const h = s.hex.toUpperCase();
    if (h === '#FFFFFF' || h === '#000000') continue;
    pal.set(h, (pal.get(h) ?? 0) + 1);
  }
}
db.close();
const topColors = (id: string, n: number): string[] => {
  const pal = palettes.get(id);
  if (!pal) return [];
  return [...pal.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([h]) => h);
};
const humanGen = [...human.values()].filter((t) => t.generation === 'old' || t.generation === 'new' && rootSet.has(t.id));
const vocabCount = new Map<string, number>();
for (const t of humanGen) for (const c of topColors(t.id, 8)) vocabCount.set(c, (vocabCount.get(c) ?? 0) + 1);
const vocab = [...vocabCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([h]) => h);
const colorVec = (id: string): number[] => {
  const pal = palettes.get(id);
  const v = new Array(vocab.length).fill(0);
  if (!pal) return v;
  let total = 0;
  for (let i = 0; i < vocab.length; i += 1) { const n = pal.get(vocab[i]) ?? 0; v[i] = n; total += n; }
  if (total > 0) for (let i = 0; i < v.length; i += 1) v[i] /= total;
  return v;
};
interface Struct { nodes: number; depth: number; texts: number; instances: number; icons: number; frames: number; vectors: number; rects: number; groups: number; bools: number }
const structs = new Map<string, Struct>();
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
  structs.set(id, { nodes: sub.length, depth: maxDepth, texts, instances, icons, frames, vectors, rects, groups, bools });
}
const sk: Array<keyof Struct> = ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'groups', 'bools'];
const train = humanGen.filter((t) => structs.has(t.id));
const sMeans = sk.map((k) => train.reduce((a, t) => a + Number(structs.get(t.id)![k]), 0) / train.length);
const sStds = sk.map((k, i) => Math.sqrt(train.reduce((a, t) => a + (Number(structs.get(t.id)![k]) - sMeans[i]) ** 2, 0) / train.length) || 1);
const structVec = (id: string): number[] => { const f = structs.get(id)!; return sk.map((k, i) => (Number(f[k]) - sMeans[i]) / sStds[i]); };
const dist = (a: number[], b: number[]): number => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
const classify = (id: string, weight: number): string => {
  if (!structs.has(id)) return '';
  const sv = structVec(id);
  const cv = colorVec(id);
  const scored = train.map((t) => {
    const d = Math.sqrt(dist(sv, structVec(t.id)) ** 2 + weight * dist(cv, colorVec(t.id)) ** 2);
    return { gen: t.generation, d };
  }).sort((a, b) => a.d - b.d).slice(0, 5);
  const votes = new Map<string, number>();
  for (const s of scored) votes.set(s.gen, (votes.get(s.gen) ?? 0) + 1);
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : '';
};
// LOO on human labels for weights
for (const w of [0, 0.5, 1, 2, 3]) {
  let ok = 0;
  for (const t of train) {
    const scored = train.filter((x) => x.id !== t.id).map((x) => {
      const d = Math.sqrt(dist(structVec(t.id), structVec(x.id)) ** 2 + w * dist(colorVec(t.id), colorVec(x.id)) ** 2);
      return { gen: x.generation, d };
    }).sort((a, b) => a.d - b.d).slice(0, 5);
    const votes = new Map<string, number>();
    for (const s of scored) votes.set(s.gen, (votes.get(s.gen) ?? 0) + 1);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best[0] === t.generation) ok += 1;
  }
  console.log('weight=' + w + ' LOO=' + ok + '/' + train.length + ' = ' + Math.round((100 * ok) / train.length) + '%');
}
const W = 2;
let changed = 0;
const changes: string[] = [];
for (const id of roots) {
  const pred = classify(id, W);
  if (!pred) continue;
  const gen = pred;
  const cur = tmap.get(id);
  if (human.has(id)) {
    // never touch human label; only fill empty generation
    if (cur && !cur.generation) { cur.generation = gen; }
    continue;
  }
  if (cur && cur.major === '廢棄') { cur.generation = gen; continue; }
  if (cur && (cur.label === '老UI' || cur.label === '新UI')) {
    if (cur.generation !== gen) { changes.push(id + ' ' + cur.label + ' -> ' + (gen === 'old' ? '老UI' : '新UI')); cur.label = gen === 'old' ? '老UI' : '新UI'; cur.major = cur.label; cur.generation = gen; changed += 1; }
    continue;
  }
  if (!cur) {
    const label = gen === 'old' ? '老UI' : '新UI';
    tmap.set(id, { id, label, major: label, minor: '', generation: gen });
    changes.push(id + ' (new) ' + label);
    changed += 1;
  }
}
const all = [...tmap.values()];
// assert human labels untouched
let humanChanged = 0;
for (const [id, h] of human) { const n = tmap.get(id); if (!n || n.label !== h.label || n.major !== h.major) humanChanged += 1; }
writeFileSync('/tmp/truth9.json', JSON.stringify(all, null, 2));
const counts = new Map<string, number>();
for (const r of all) counts.set(r.major, (counts.get(r.major) ?? 0) + 1);
writeFileSync('labels/screens-v2.json', JSON.stringify({ version: 2, sample: '2026-11-20-baipai-full', note: 'human labels preserved; generation from colour+structure', counts: Object.fromEntries(counts), screens: all.map((r) => ({ id: r.id, label: r.label, major: r.major, minor: r.minor, generation: r.generation })) }, null, 2));
console.log('truth=' + all.length + ' changed=' + changed + ' humanChanged=' + humanChanged);
console.log('majors=' + JSON.stringify(Object.fromEntries(counts)));
console.log('sample changes:'); for (const c of changes.slice(0, 12)) console.log('  ' + c);
