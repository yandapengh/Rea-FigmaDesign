/// <reference lib="es2022" />
/** Stage 4 Tier 2 baseline with streaming style features. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { Graph, headlineOf, jaccard } from './core/graph';

const ROOT = resolve(__dirname, '..');
const max = process.argv.indexOf('--max') !== -1 ? Number(process.argv[process.argv.indexOf('--max') + 1]) : 0;
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
const labelFile = JSON.parse(readFileSync(join(ROOT, 'labels/screens-v2.json'), 'utf8')) as { screens: Array<{ id: string; label: string; major: string; minor: string; generation: string }> };
const labels = labelFile.screens.filter((r) => g.nodes.has(r.id));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const pageOf = new Map<string, string>();
for (let i = 0; i < labels.length; i += 500) {
  const part = labels.slice(i, i + 500).map((r) => r.id);
  const rows = db.prepare('SELECT id, page_name FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string; page_name: string }>;
  for (const r of rows) pageOf.set(r.id, r.page_name);
}

interface Sample { id: string; hash: string; page: string; label: string; major: string; minor: string; gen: string; nodes: number }
const samples: Sample[] = [];
const seen = new Map<string, Sample>();
let conflicts = 0;
for (const r of labels) {
  const n = g.nodes.get(r.id)!;
  if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
  if (Math.abs((n.bbox_w ?? 0) - 390) > 4 || Math.abs((n.bbox_h ?? 0) - 844) > 6) continue;
  const sub = g.subtree(r.id);
  if (sub.length < 40) continue;
  const texts: string[] = [];
  for (const sid of sub) { const t = g.nodes.get(sid)?.text_content; if (t) texts.push(t); }
  const hash = g.hash.get(r.id) ?? '';
  const key = hash + '|' + headlineOf(texts);
  const prev = seen.get(key);
  if (prev) { if (prev.label !== r.label) conflicts += 1; continue; }
  const s: Sample = { id: r.id, hash, page: (pageOf.get(r.id) ?? '').trim(), label: r.label, major: r.major, minor: r.minor, gen: r.generation, nodes: sub.length };
  seen.set(key, s);
  samples.push(s);
}
const pool = max > 0 ? samples.slice(0, max) : samples;
console.log('labels=' + labels.length + ' unique=' + samples.length + ' used=' + pool.length + ' conflicts=' + conflicts);
const sampleOf = new Map<string, string>();
for (const s of pool) for (const sid of g.subtree(s.id)) if (!sampleOf.has(sid)) sampleOf.set(sid, s.id);

interface F { fonts: Map<string, number>; palette: Map<string, number>; radii: Map<string, number>; tokens: number; nodes: number }
const feats = new Map<string, F>();
for (const s of pool) feats.set(s.id, { fonts: new Map(), palette: new Map(), radii: new Map(), tokens: 0, nodes: s.nodes });
const stmt = db.prepare('SELECT id, style_json, text_style_json, bound_variables_json FROM nodes');
let scanned = 0;
for (const row of stmt.iterate() as Iterable<{ id: string; style_json: string; text_style_json: string | null; bound_variables_json: string }>) {
  const sid = sampleOf.get(row.id);
  if (!sid) continue;
  const f = feats.get(sid)!;
  try {
    const st = JSON.parse(row.style_json) as { fills?: Array<{ hex?: string }>; strokes?: Array<{ hex?: string }>; cornerRadius?: unknown };
    for (const p of st.fills ?? []) if (p.hex) f.palette.set(p.hex.toUpperCase(), (f.palette.get(p.hex.toUpperCase()) ?? 0) + 1);
    for (const p of st.strokes ?? []) if (p.hex) f.palette.set(p.hex.toUpperCase(), (f.palette.get(p.hex.toUpperCase()) ?? 0) + 1);
    if (typeof st.cornerRadius === 'number') f.radii.set(String(st.cornerRadius), (f.radii.get(String(st.cornerRadius)) ?? 0) + 1);
  } catch { /* ignore */ }
  if (row.text_style_json) {
    try {
      const ts = JSON.parse(row.text_style_json) as { fontFamily?: string };
      if (ts.fontFamily) { const fam = ts.fontFamily.split(' ')[0]; f.fonts.set(fam, (f.fonts.get(fam) ?? 0) + 1); }
    } catch { /* ignore */ }
  }
  if (row.bound_variables_json && row.bound_variables_json !== '{}') {
    try { const b = JSON.parse(row.bound_variables_json) as Record<string, unknown>; f.tokens += Object.keys(b).length; } catch { /* ignore */ }
  }
  scanned += 1;
  if (scanned % 100000 === 0) console.log('rows ' + scanned);
}
console.log('style rows for samples=' + scanned);
db.close();

const styleScore = (f: F, dom: string, tokenRatio: number, palette: Set<string>, radii: Set<string>): number => {
  let fontTotal = 0;
  for (const v of f.fonts.values()) fontTotal += v;
  const font = fontTotal > 0 ? (f.fonts.get(dom) ?? 0) / fontTotal : 0;
  const ratio = f.tokens / Math.max(1, f.nodes);
  const logDist = Math.abs(Math.log10(ratio + 0.001) - Math.log10(tokenRatio + 0.001)) / 1.5;
  const token = Math.max(0, 1 - logDist);
  return 0.4 * font + 0.35 * token + 0.1 * jaccard(new Set(f.palette.keys()), palette) + 0.15 * jaccard(new Set(f.radii.keys()), radii);
};
const runTask = (task: 'category' | 'generation'): void => {
  const rows = task === 'category' ? pool.filter((s) => s.minor !== '') : pool.filter((s) => s.gen === 'old' || s.gen === 'new');
  const labelOf = (s: Sample): string => (task === 'category' ? s.minor : s.gen === 'old' ? 'old' : 'new');
  const agg = new Map<string, { fonts: Map<string, number>; palette: Map<string, number>; radii: Map<string, number>; tokens: number; nodes: number }>();
  for (const s of rows) {
    const f = feats.get(s.id)!;
    const a = agg.get(labelOf(s)) ?? { fonts: new Map(), palette: new Map(), radii: new Map(), tokens: 0, nodes: 0 };
    for (const [k, v] of f.fonts) a.fonts.set(k, (a.fonts.get(k) ?? 0) + v);
    for (const [c, n] of f.palette) a.palette.set(c, (a.palette.get(c) ?? 0) + n);
    for (const [r, n] of f.radii) a.radii.set(r, (a.radii.get(r) ?? 0) + n);
    a.tokens += f.tokens; a.nodes += s.nodes;
    agg.set(labelOf(s), a);
  }
  const groupsFor = (exclude?: Sample): Array<{ label: string; dom: string; ratio: number; palette: Set<string>; radii: Set<string> }> => {
    const out = [];
    for (const [label, a] of agg) {
      const fonts = new Map(a.fonts); const palette = new Map(a.palette); const radii = new Map(a.radii);
      let tokens = a.tokens, nodes = a.nodes;
      if (exclude && labelOf(exclude) === label) {
        const f = feats.get(exclude.id)!;
        for (const [k, v] of f.fonts) fonts.set(k, (fonts.get(k) ?? 0) - v);
        for (const [c, n] of f.palette) palette.set(c, (palette.get(c) ?? 0) - n);
        for (const [r, n] of f.radii) radii.set(r, (radii.get(r) ?? 0) - n);
        tokens -= f.tokens; nodes -= exclude.nodes;
      }
      const domEntry = [...fonts.entries()].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])[0];
      out.push({ label, dom: domEntry ? domEntry[0] : '', ratio: nodes > 0 ? tokens / nodes : 0, palette: new Set([...palette.entries()].filter(([, v]) => v > 0).map(([k]) => k)), radii: new Set([...radii.entries()].filter(([, v]) => v > 0).map(([k]) => k)) });
    }
    return out;
  };
  let strict = 0, forced = 0, abstain = 0, top3 = 0;
  const perMajor = new Map<string, [number, number]>();
  const conf = new Map<string, number>();
  const errors: Array<{ id: string; page: string; truth: string; pred: string; abstained: boolean; margin: number; major: string }> = [];
  for (const s of rows) {
    const f = feats.get(s.id)!;
    const votes = groupsFor(s).map((gp) => ({ label: gp.label, total: styleScore(f, gp.dom, gp.ratio, gp.palette, gp.radii) })).sort((a, b) => b.total - a.total);
    const margin = votes[0].total - (votes[1] ? votes[1].total : 0);
    const strictPred = margin < 0.1 ? 'unknown' : votes[0].label;
    const forcedPred = votes[0].label;
    const truth = labelOf(s);
    if (strictPred === truth) strict += 1;
    if (forcedPred === truth) forced += 1;
    if (strictPred === 'unknown') abstain += 1;
    if (votes.slice(0, 3).some((v) => v.label === truth)) top3 += 1;
    const m = perMajor.get(s.major) ?? [0, 0]; m[1] += 1; if (strictPred === truth) m[0] += 1; perMajor.set(s.major, m);
    if (strictPred !== truth) {
      const k = truth + ' -> ' + strictPred; conf.set(k, (conf.get(k) ?? 0) + 1);
      errors.push({ id: s.id, page: s.page, truth, pred: strictPred, abstained: strictPred === 'unknown', margin, major: s.major });
    }
  }
  errors.sort((a, b) => (a.abstained === b.abstained ? b.margin - a.margin : a.abstained ? 1 : -1));
  const pct = (n: number): number => Math.round((100 * n) / Math.max(1, rows.length));
  console.log('');
  console.log('=== ' + task + ' ===');
  console.log('samples=' + rows.length + ' classes=' + agg.size);
  console.log('strict=' + strict + '/' + rows.length + ' = ' + pct(strict) + '%  forced=' + forced + '/' + rows.length + ' = ' + pct(forced) + '%  abstain=' + pct(abstain) + '%  top3=' + pct(top3) + '%');
  for (const [k, [ok, n]] of [...perMajor.entries()].sort()) console.log('  ' + k + ' ' + ok + '/' + n + ' = ' + Math.round((100 * ok) / n) + '%');
  console.log('top confusions:');
  for (const [k, n] of [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log('  ' + k + ' x' + n);
  console.log('sample errors:');
  for (const e of errors.slice(0, 8)) console.log('  ' + e.id + ' | ' + e.page + ' | ' + e.truth + ' -> ' + e.pred + (e.abstained ? ' (abstain)' : '') + ' | margin=' + e.margin.toFixed(3));
  writeFileSync(join(ROOT, '.scratch/baseline-' + task + '.json'), JSON.stringify({ rows: rows.length, strict, forced, abstain, top3, perMajor: Object.fromEntries(perMajor), confusions: Object.fromEntries(conf), errors: errors.slice(0, 40) }, null, 2));
};
runTask('category');
runTask('generation');
