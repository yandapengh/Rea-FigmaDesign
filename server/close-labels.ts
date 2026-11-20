/// <reference lib="es2022" />
/** Close the last two groups + one global generation pass for every remaining screen. */

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
const truth = JSON.parse(readFileSync('/tmp/truth7.json', 'utf8')) as Array<{ id: string; label: string; major: string; minor: string; generation: string }>;
const by = new Map(truth.map((t) => [t.id, t]));
const add = (id: string, label: string, major: string, minor: string): void => { by.set(id, { id, label, major, minor, generation: major === '老UI' ? 'old' : major === '新UI' ? 'new' : '' }); };
for (const id of ['11728:843169', '11728:843168']) add(id, '老UI', '老UI', '');
for (const id of ['11676:380445', '9050:175127']) add(id, '卡管理頁', '頁面類', '卡管理頁');

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
interface F { id: string; page: string; nodes: number; depth: number; texts: number; instances: number; icons: number; frames: number; vectors: number; rects: number; groups: number; bools: number }
const feats = new Map<string, F>();
for (const id of roots) {
  const sub = g.subtree(id);
  if (sub.length < 40) continue;
  const n = g.nodes.get(id)!;
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
  feats.set(id, { id, page: n.page_name, nodes: sub.length, depth: maxDepth, texts, instances, icons, frames, vectors, rects, groups, bools });
}
const labeled = [...by.values()].map((t) => ({ t, f: feats.get(t.id) })).filter((x) => x.f) as Array<{ t: { generation: string }; f: F }>;
const numeric: Array<keyof F> = ['nodes', 'depth', 'texts', 'instances', 'icons', 'frames', 'vectors', 'rects', 'groups', 'bools'];
const means = numeric.map((k) => labeled.reduce((a, x) => a + Number(x.f[k]), 0) / labeled.length);
const stds = numeric.map((k, i) => Math.sqrt(labeled.reduce((a, x) => a + (Number(x.f[k]) - means[i]) ** 2, 0) / labeled.length) || 1);
const vec = (f: F): number[] => numeric.map((k, i) => (Number(f[k]) - means[i]) / stds[i]);
const pool = labeled.filter((x) => x.t.generation === 'old' || x.t.generation === 'new');
// page prior from human/AI labels
const pageGen = new Map<string, { old: number; new: number }>();
for (const x of labeled) {
  if (x.t.generation !== 'old' && x.t.generation !== 'new') continue;
  const rec = pageGen.get(x.f.page) ?? { old: 0, new: 0 };
  if (x.t.generation === 'old') rec.old += 1; else rec.new += 1;
  pageGen.set(x.f.page, rec);
}
const prior = (page: string): string => {
  const rec = pageGen.get(page);
  if (!rec) return '';
  const total = rec.old + rec.new;
  if (total < 5) return '';
  if (rec.old / total >= 0.8) return 'old';
  if (rec.new / total >= 0.8) return 'new';
  return '';
};
let autoOld = 0, autoNew = 0;
for (const [id, f] of feats) {
  if (by.has(id)) continue;
  const scored = pool.map((x) => ({ gen: x.t.generation, d: Math.hypot(...vec(x.f).map((v, i) => v - vec(f)[i])) })).sort((a, b) => a.d - b.d).slice(0, 5);
  const oldVotes = scored.filter((s) => s.gen === 'old').length;
  const newVotes = scored.filter((s) => s.gen === 'new').length;
  let gen = '';
  if (oldVotes >= 3) gen = 'old';
  else if (newVotes >= 3) gen = 'new';
  if (!gen) gen = prior(f.page);
  if (!gen) continue;
  const label = gen === 'old' ? '老UI' : '新UI';
  by.set(id, { id, label, major: label, minor: '', generation: gen });
  if (gen === 'old') autoOld += 1; else autoNew += 1;
}
const all = [...by.values()];
writeFileSync('/tmp/truth8.json', JSON.stringify(all, null, 2));
const counts = new Map<string, number>();
for (const r of all) counts.set(r.major, (counts.get(r.major) ?? 0) + 1);
const dialog = new Set(['通用彈窗','下拉抽屜彈窗','OTP彈窗','PIN確認彈窗','指紋確認彈窗','系統FaceID彈窗','系統彈窗','FaceID彈窗','日期選擇器彈窗','上傳avatar彈窗','分帳確認彈窗','修改手機號彈窗','Toast','T&C彈窗','KYC彈窗']);
const out = { version: 2, sample: '2026-11-20-baipai-full', note: 'human labels + rule AI (generation majority + page prior)', counts: Object.fromEntries(counts), screens: all.map((r) => ({ id: r.id, label: r.label, major: r.major, minor: r.minor, generation: r.generation })) };
writeFileSync('labels/screens-v2.json', JSON.stringify(out, null, 2));
console.log('truth=' + all.length + ' auto old=' + autoOld + ' new=' + autoNew + ' majors=' + JSON.stringify(Object.fromEntries(counts)));
