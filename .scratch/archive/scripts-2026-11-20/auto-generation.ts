/// <reference lib="es2022" />
/** Auto-assign 老UI/新UI to every unresolved screen with unanimous structural neighbours. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const truth = JSON.parse(readFileSync('/tmp/truth5.json', 'utf8')) as Array<{ id: string; label: string; major: string; minor: string; generation: string }>;
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
interface F { id: string; nodes: number; depth: number; texts: number; instances: number; icons: number; frames: number; vectors: number; rects: number; groups: number; bools: number }
const feats = new Map<string, F>();
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
const tmap = new Map(truth.map((t) => [t.id, t]));
const labeled = truth.map((t) => ({ t, f: feats.get(t.id) })).filter((x) => x.f) as Array<{ t: { id: string; generation: string }; f: F }>;
const numeric: Array<keyof F> = ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'groups', 'bools'];
const means = numeric.map((k) => labeled.reduce((a, x) => a + Number(x.f[k]), 0) / labeled.length);
const stds = numeric.map((k, i) => Math.sqrt(labeled.reduce((a, x) => a + (Number(x.f[k]) - means[i]) ** 2, 0) / labeled.length) || 1);
const vec = (f: F): number[] => numeric.map((k, i) => (Number(f[k]) - means[i]) / stds[i]);
const pool = labeled.filter((x) => x.t.generation === 'old' || x.t.generation === 'new');
let assignedOld = 0, assignedNew = 0;
const merged = new Map(truth.map((t) => [t.id, t]));
const clusters = (JSON.parse(readFileSync('/tmp/annotated-clusters.json', 'utf8')) as { clusters: Array<{ rows: Array<{ id: string }> }> }).clusters;
for (const c of clusters) {
  const ids = c.rows.map((r) => r.id);
  if (ids.some((id) => tmap.has(id))) continue;
  const gens: string[] = [];
  for (const id of ids) {
    const f = feats.get(id);
    if (!f) { gens.push(''); continue; }
    const scored = pool.map((x) => ({ gen: x.t.generation, d: Math.hypot(...vec(x.f).map((v, i) => v - vec(f)[i])) })).sort((a, b) => a.d - b.d).slice(0, 5);
    if (scored.length < 5 || !scored.every((s) => s.gen === scored[0].gen)) { gens.push(''); continue; }
    gens.push(scored[0].gen);
  }
  if (gens.length === 0 || gens.some((x) => x === '')) continue;
  const gen = gens[0];
  if (!gens.every((x) => x === gen)) continue;
  for (const id of ids) {
    const label = gen === 'old' ? '老UI' : '新UI';
    merged.set(id, { id, label, major: label, minor: '', generation: gen });
    if (gen === 'old') assignedOld += 1; else assignedNew += 1;
  }
}
const all = [...merged.values()];
writeFileSync('/tmp/truth6.json', JSON.stringify(all, null, 2));
console.log('truth=' + all.length + ' auto old=' + assignedOld + ' new=' + assignedNew);
