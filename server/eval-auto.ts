/// <reference lib="es2022" />
/** Evaluate auto-detection for the two repetitive labels: 廢棄頁面 and 老UI/新UI. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
const truth = JSON.parse(readFileSync('/tmp/truth5.json', 'utf8')) as Array<{ id: string; label: string; major: string; generation: string }>;
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
const labeled = truth.map((t) => ({ t, f: feats.get(t.id) })).filter((x) => x.f) as Array<{ t: { id: string; label: string; major: string; generation: string }; f: F }>;
const numeric: Array<keyof F> = ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'groups', 'bools'];
const means = numeric.map((k) => labeled.reduce((a, x) => a + Number(x.f[k]), 0) / labeled.length);
const stds = numeric.map((k, i) => Math.sqrt(labeled.reduce((a, x) => a + (Number(x.f[k]) - means[i]) ** 2, 0) / labeled.length) || 1);
const vec = (f: F): number[] => numeric.map((k, i) => (Number(f[k]) - means[i]) / stds[i]);
const evalBinary = (name: string, target: (x: { t: { major: string; generation: string; label: string } }) => string): void => {
  const pool = labeled.filter((x) => target(x) !== '');
  let ok = 0, total = 0, okU = 0, totalU = 0;
  for (const x of pool) {
    const scored = pool.filter((y) => y.t.id !== x.t.id).map((y) => ({ y, d: Math.hypot(...vec(y.f).map((v, i) => v - vec(x.f)[i])) })).sort((a, b) => a.d - b.d).slice(0, 5);
    if (scored.length < 5) continue;
    const votes = new Map<string, number>();
    for (const s of scored) votes.set(target(s.y), (votes.get(target(s.y)) ?? 0) + 1);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    total += 1;
    if (best[0] === target(x)) ok += 1;
    if (best[1] === 5) { totalU += 1; if (best[0] === target(x)) okU += 1; }
  }
  console.log(name + ': top1 ' + ok + '/' + total + ' = ' + Math.round((100 * ok) / total) + '%  unanimous ' + okU + '/' + totalU + ' = ' + Math.round((100 * okU) / Math.max(1, totalU)) + '%');
};
evalBinary('廢棄頁面', (x) => (x.t.major === '廢棄' ? 'YES' : 'NO'));
evalBinary('老UI/新UI', (x) => (x.t.generation === 'old' ? 'old' : x.t.generation === 'new' ? 'new' : ''));
