/// <reference lib="es2022" />
/** Feature separability check for new/old UI generations. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph, archetypeOf } from './core/graph';

const ROOT = resolve(__dirname, '..');
let dbPath = '';
{
  let best = '';
  let bestTime = 0;
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
const pages = db.prepare('SELECT page_id, page_name, page_index FROM pages').all() as Array<{ page_id: string; page_name: string; page_index: number }>;
db.close();
const pageMeta = new Map(pages.map((p) => [p.page_id, p]));

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

interface Feat { id: string; hash: string; name: string; page: string; archetype: string; nodes: number; depth: number; texts: number; instances: number; icons: number; frames: number; vectors: number; rects: number; ellipses: number; groups: number; comps: number; bools: number }
const feats: Feat[] = [];
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  const n = g.nodes.get(id)!;
  let texts = 0, instances = 0, icons = 0, frames = 0, vectors = 0, rects = 0, ellipses = 0, groups = 0, comps = 0, bools = 0, maxDepth = 0;
  for (const sid of sub) {
    const s = g.nodes.get(sid)!;
    const d = g.depthOf(sid);
    if (d > maxDepth) maxDepth = d;
    if (s.type === 'TEXT') texts += 1;
    else if (s.type === 'INSTANCE') instances += 1;
    else if (s.type === 'FRAME') frames += 1;
    else if (s.type === 'VECTOR') vectors += 1;
    else if (s.type === 'RECTANGLE') rects += 1;
    else if (s.type === 'ELLIPSE') ellipses += 1;
    else if (s.type === 'GROUP') groups += 1;
    else if (s.type === 'COMPONENT' || s.type === 'COMPONENT_SET') comps += 1;
    else if (s.type === 'BOOLEAN_OPERATION') bools += 1;
    if (s.is_icon_container === 1) icons += 1;
  }
  feats.push({ id, hash: g.hash.get(id) ?? '', name: n.name, page: pageMeta.get(n.page_id)?.page_name ?? n.page_name, archetype: archetypeOf(g, id), nodes: sub.length, depth: maxDepth, texts, instances, icons, frames, vectors, rects, ellipses, groups, comps, bools });
}
const truth = JSON.parse(readFileSync('/tmp/truth.json', 'utf8')) as Array<{ id: string; label: string; generation: string }>;
const tmap = new Map(truth.map((t) => [t.id, t]));
const labeled = feats.filter((f) => tmap.has(f.id));
const old = labeled.filter((f) => tmap.get(f.id)!.generation === 'old');
const neu = labeled.filter((f) => tmap.get(f.id)!.generation === 'new');
const med = (vals: number[]): number => { const s = [...vals].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
const show = (name: string, arr: Feat[], key: keyof Feat): string => med(arr.map((f) => Number(f[key]))).toString();
console.log('labeled=' + labeled.length + ' old=' + old.length + ' new=' + neu.length);
console.log('');
console.log('feature            old   new');
for (const k of ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'ellipses', 'groups', 'comps', 'bools'] as Array<keyof Feat>) {
  console.log(k.padEnd(18) + String(show('', old, k)).padStart(4) + '  ' + String(show('', neu, k)).padStart(4));
}
console.log('');
console.log('old pages: ' + [...new Set(old.map((f) => f.page))].join(' | '));
console.log('new pages: ' + [...new Set(neu.map((f) => f.page))].join(' | '));

// kNN LOO on generation
const numeric: Array<keyof Feat> = ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'ellipses', 'groups', 'comps', 'bools'];
const means = numeric.map((k) => labeled.reduce((a, f) => a + Number(f[k]), 0) / labeled.length);
const stds = numeric.map((k, i) => Math.sqrt(labeled.reduce((a, f) => a + (Number(f[k]) - means[i]) ** 2, 0) / labeled.length) || 1);
const vec = (f: Feat): number[] => numeric.map((k, i) => (Number(f[k]) - means[i]) / stds[i]);
const gens = labeled.filter((f) => tmap.get(f.id)!.generation === 'old' || tmap.get(f.id)!.generation === 'new');
let ok = 0;
for (const f of gens) {
  const scored = gens.filter((x) => x.id !== f.id).map((x) => ({ x, d: Math.hypot(...vec(x).map((v, i) => v - vec(f)[i])) })).sort((a, b) => a.d - b.d).slice(0, 3);
  const votes = new Map<string, number>();
  for (const s of scored) { const gen = tmap.get(s.x.id)!.generation; votes.set(gen, (votes.get(gen) ?? 0) + 1); }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (best === tmap.get(f.id)!.generation) ok += 1;
}
console.log('');
console.log('generation LOO kNN = ' + ok + '/' + gens.length + ' = ' + Math.round((100 * ok) / Math.max(1, gens.length)) + '%');
