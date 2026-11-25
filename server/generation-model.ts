/// <reference lib="es2022" />
/** Generation model: colour fingerprint + structure, trained on human labels only. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { AstGraphDB } from './db';
import { Graph, findScreenRootCandidates } from './core/graph';
import { recomputeV2Counts, type ScreenLabelV2 } from './core/semantics';

const ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
let basePath = '';
let humanPath = '';
let outPath = join(ROOT, '.scratch/screens-v2.generated.json');
let dbFlag = '';

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--base') basePath = args[++i] ?? '';
  else if (a === '--human') humanPath = args[++i] ?? '';
  else if (a === '--out') outPath = resolve(ROOT, args[++i] ?? '');
  else if (a === '--db') dbFlag = args[++i] ?? '';
}

if (!basePath || !humanPath) {
  console.error('usage: tsx server/generation-model.ts --base <truth.json> --human <human.json> [--out .scratch/screens-v2.generated.json] [--db path]');
  process.exit(1);
}

const dbPath = dbFlag ? resolve(ROOT, dbFlag) : (AstGraphDB.resolveLatestGraphDb(ROOT) ?? '');
if (!dbPath || !existsSync(dbPath)) {
  console.error('no database found');
  process.exit(1);
}

const g = new Graph(dbPath);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const truthBase = JSON.parse(readFileSync(resolve(ROOT, basePath), 'utf8')) as ScreenLabelV2[];
const truthHuman = JSON.parse(readFileSync(resolve(ROOT, humanPath), 'utf8')) as ScreenLabelV2[];
const tmap = new Map(truthBase.map((t) => [t.id, { ...t }]));
const human = new Map(truthHuman.map((t) => [t.id, t]));

const roots = findScreenRootCandidates(g);
const rootSet = new Set(roots);
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
const humanGen = [...human.values()].filter((t) => (t.generation === 'old' || t.generation === 'new') && rootSet.has(t.id));
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
let humanChanged = 0;
for (const [id, h] of human) { const n = tmap.get(id); if (!n || n.label !== h.label || n.major !== h.major) humanChanged += 1; }
const counts = recomputeV2Counts(all);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ version: 2, sample: '2026-11-20-baipai-full', note: 'human labels preserved; generation from colour+structure', counts, screens: all.map((r) => ({ id: r.id, label: r.label, major: r.major, minor: r.minor, generation: r.generation })) }, null, 2));
console.log('truth=' + all.length + ' changed=' + changed + ' humanChanged=' + humanChanged);
console.log('majors=' + JSON.stringify(counts));
console.log('written ' + outPath);
console.log('sample changes:'); for (const c of changes.slice(0, 12)) console.log('  ' + c);
