/// <reference lib="es2022" />
/** Detach similarity utilities (stage 6, promoted with lab caveats). */
import { Graph } from './graph';

export interface DetachFeature {
  id: string;
  name: string;
  nodes: number;
  depth: number;
  types: Map<string, number>;
  w: number;
  h: number;
  hash: string;
}

export function detachFeature(g: Graph, id: string): DetachFeature {
  const n = g.nodes.get(id)!;
  const sub = g.subtree(id);
  const types = new Map<string, number>();
  let depth = 0;
  for (const sid of sub) {
    const s = g.nodes.get(sid)!;
    types.set(s.type, (types.get(s.type) ?? 0) + 1);
    const d = g.depthOf(sid);
    if (d > depth) depth = d;
  }
  return { id, name: n.name, nodes: sub.length, depth, types, w: n.bbox_w ?? 0, h: n.bbox_h ?? 0, hash: g.hash.get(id) ?? '' };
}

const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const x = b.get(k); if (x) dot += v * x; }
  for (const v of b.values()) nb += v * v;
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
};
const ratio = (a: number, b: number): number => (a <= 0 || b <= 0 ? 0 : Math.min(a, b) / Math.max(a, b));

/** Structural similarity; callers can add token/shape evidence. */
export function detachScore(q: DetachFeature, c: DetachFeature): { score: number; hash: number; type: number; shape: number } {
  const hash = q.hash === c.hash ? 1 : 0;
  const type = cosine(q.types, c.types);
  const shape = 0.6 * ratio(q.nodes, c.nodes) + 0.2 * ratio(q.w, c.w) + 0.2 * ratio(q.h, c.h);
  return { score: 0.45 * hash + 0.35 * type + 0.2 * shape, hash, type, shape };
}

/** LOO-style synthetic recall over instances whose main component is local. */
export function syntheticDetachRecall(g: Graph, limit = 300): { sample: number; top1: number; top3: number; top5: number } {
  const library = new Map<string, DetachFeature>();
  for (const [id, n] of g.nodes) if (n.type === 'COMPONENT') library.set(id, detachFeature(g, id));
  const pool: Array<{ id: string; main: string }> = [];
  for (const [id, n] of g.nodes) {
    if (!n.main_component_id || !library.has(n.main_component_id)) continue;
    const size = g.subtree(id).length;
    if (size < 10 || size > 2000) continue;
    pool.push({ id, main: n.main_component_id });
  }
  const sample = pool.length > limit ? Array.from({ length: limit }, (_, i) => pool[Math.floor((i * pool.length) / limit)]) : pool;
  let top1 = 0, top3 = 0, top5 = 0;
  for (const item of sample) {
    const q = detachFeature(g, item.id);
    const ranked = [...library.values()].map((c) => ({ c, s: detachScore(q, c).score })).sort((a, b) => b.s - a.s);
    const idx = ranked.findIndex((x) => x.c.id === item.main);
    if (idx === 0) top1 += 1;
    if (idx >= 0 && idx < 3) top3 += 1;
    if (idx >= 0 && idx < 5) top5 += 1;
  }
  return { sample: sample.length, top1, top3, top5 };
}
