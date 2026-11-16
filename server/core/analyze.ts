/// <reference lib="es2022" />
/**
 * Composite queries shared by every adapter (CLI now, MCP next).
 *
 * Pure by contract: no process.exit, no CLI formatting, no writes.
 */

import {
  Graph,
  profileOf,
  slotsOf,
  typeHist,
  cosine,
  jaccard,
  topEntries,
  archetypeOf,
  headlineOf,
  isChrome,
} from './graph';
import { groupStats, classifyWith, decideLabel, deriveFamilyAxes, type LabelFile, type LabelEntry } from './semantics';

export interface SheetCard {
  id: string;
  name: string;
  page: string;
  pageId: string;
  type: string;
  archetype: string;
  bbox: { x: number; y: number; w: number; h: number };
  structure: {
    hash: string;
    nodes: number;
    depth: number;
    familyMembers: number;
    familyAxes: number;
    types: Record<string, number>;
  };
  style: {
    paletteSize: number;
    paletteTop: Array<[string, number]>;
    radiiTop: Array<[number, number]>;
    fontsTop: Array<[string, number]>;
    effects: Array<[string, number]>;
    spacingTop: Array<[number, number]>;
    tokens: number;
    tokenRatio: number;
    tokenLibraries: number;
  };
  copy: { textNodes: number; headline: string; sample: string[] };
  variants: { axis: string | null; siblings: number; differs: string[]; familySize: number };
  labels: { generation: string };
  limits: string[];
}

const LIMITS = [
  'visual hierarchy',
  'iconography style',
  'composition balance',
  'illustration style',
  'optical spacing',
  'perceived novelty',
];

export function buildSheetCard(
  g: Graph,
  dbPath: string,
  id: string,
  opts: { labels?: LabelEntry[]; floor?: number } = {},
): SheetCard {
  const node = g.nodes.get(id);
  if (!node) throw new Error('node not found: ' + id);
  const sub = g.subtree(id);
  const p = profileOf(g, dbPath, sub);
  const s = slotsOf(g, id);
  const hash = g.hash.get(id)!;
  const family = g.topLevelMembers(hash).filter((m) => g.subtree(m).length >= 120);
  let axis: string | null = null;
  let siblings = 0;
  let differs: string[] = [];
  let axes = 0;
  if (family.length >= 2) {
    const fam = deriveFamilyAxes(g, family, false);
    axes = fam.axes.length;
    const hit = fam.axes.filter((a) => a.members.indexOf(id) !== -1)[0];
    if (hit) {
      axis = hit.key;
      siblings = hit.members.length;
      differs = hit.samples;
    }
  }
  let generation = 'unlabelled';
  if (opts.labels && opts.labels.length > 0) {
    const groups = groupStats(g, dbPath, opts.labels);
    const res = classifyWith(g, dbPath, id, groups);
    generation = decideLabel(res, opts.floor ?? 0.55).verdict;
  }
  return {
    id,
    name: node.name,
    page: node.page_name,
    pageId: node.page_id,
    type: node.type,
    archetype: archetypeOf(g, id),
    bbox: {
      x: Math.round(node.bbox_x ?? 0),
      y: Math.round(node.bbox_y ?? 0),
      w: Math.round(node.bbox_w ?? 0),
      h: Math.round(node.bbox_h ?? 0),
    },
    structure: {
      hash: hash.slice(0, 12),
      nodes: sub.length,
      depth: g.depthOf(id),
      familyMembers: family.length,
      familyAxes: axes,
      types: Object.fromEntries(p.types),
    },
    style: {
      paletteSize: p.palette.size,
      paletteTop: topEntries(p.palette, 8),
      radiiTop: topEntries(p.radii, 5),
      fontsTop: topEntries(p.fonts, 5),
      effects: topEntries(p.effects, 5),
      spacingTop: topEntries(p.spacing, 5),
      tokens: p.tokens,
      tokenRatio: Number((p.nodes > 0 ? p.tokens / p.nodes : 0).toFixed(4)),
      tokenLibraries: p.tokenLibraries,
    },
    copy: {
      textNodes: s.texts.length,
      headline: headlineOf(s.texts),
      sample: s.texts.filter((t) => !isChrome(t)).slice(0, 6),
    },
    variants: { axis, siblings, differs, familySize: family.length },
    labels: { generation },
    limits: LIMITS,
  };
}

export interface DiffResult {
  a: { id: string; name: string; nodes: number };
  b: { id: string; name: string; nodes: number };
  structure: { isomorphic: boolean; typeCosine: number; depthA: number; depthB: number };
  copy: { jaccard: number; onlyA: number; onlyB: number };
  icons: { jaccard: number; shared: number; countA: number; countB: number };
  palette: { jaccard: number; countA: number; countB: number; onlyA: Array<[string, number]> };
  radii: { jaccard: number };
  fonts: { jaccard: number };
  effects: { a: Array<[string, number]>; b: Array<[string, number]> };
  tokens: { a: number; aNodes: number; b: number; bNodes: number };
}

export function diffScreens(g: Graph, dbPath: string, a: string, b: string): DiffResult {
  for (const id of [a, b]) if (!g.nodes.has(id)) throw new Error('node not found: ' + id);
  const sa = g.subtree(a);
  const sb = g.subtree(b);
  const pa = profileOf(g, dbPath, sa);
  const pb = profileOf(g, dbPath, sb);
  const saSlots = slotsOf(g, a);
  const sbSlots = slotsOf(g, b);
  const textA = new Set(saSlots.texts);
  const textB = new Set(sbSlots.texts);
  const iconA = new Set(saSlots.icons);
  const iconB = new Set(sbSlots.icons);
  const palA = new Set(pa.palette.keys());
  const palB = new Set(pb.palette.keys());
  const onlyA: Array<[string, number]> = [];
  for (const c of palA) if (!palB.has(c)) onlyA.push([c, pa.palette.get(c) ?? 1]);
  return {
    a: { id: a, name: g.nodes.get(a)!.name, nodes: sa.length },
    b: { id: b, name: g.nodes.get(b)!.name, nodes: sb.length },
    structure: {
      isomorphic: g.hash.get(a) === g.hash.get(b),
      typeCosine: Number(cosine(typeHist(g, sa), typeHist(g, sb)).toFixed(4)),
      depthA: g.depthOf(a),
      depthB: g.depthOf(b),
    },
    copy: {
      jaccard: Number(jaccard(textA, textB).toFixed(4)),
      onlyA: textA.size,
      onlyB: textB.size,
    },
    icons: {
      jaccard: Number(jaccard(iconA, iconB).toFixed(4)),
      shared: [...iconA].filter((x) => iconB.has(x)).length,
      countA: iconA.size,
      countB: iconB.size,
    },
    palette: {
      jaccard: Number(jaccard(palA, palB).toFixed(4)),
      countA: palA.size,
      countB: palB.size,
      onlyA: onlyA.slice(0, 6),
    },
    radii: { jaccard: Number(jaccard(new Set([...pa.radii.keys()].map(String)), new Set([...pb.radii.keys()].map(String))).toFixed(4)) },
    fonts: { jaccard: Number(jaccard(new Set(pa.fonts.keys()), new Set(pb.fonts.keys())).toFixed(4)) },
    effects: { a: topEntries(pa.effects, 5), b: topEntries(pb.effects, 5) },
    tokens: { a: pa.tokens, aNodes: pa.nodes, b: pb.tokens, bNodes: pb.nodes },
  };
}

export interface FindRow {
  id: string;
  name: string;
  page: string;
  nodes: number;
  struct: number;
  style: number;
}

export interface FindResult {
  like: string;
  name: string;
  candidates: number;
  exact: FindRow[];
  near: FindRow[];
  styleOnly: FindRow[];
  unranked: number;
}

export function findSimilar(g: Graph, dbPath: string, like: string, top: number): FindResult {
  if (!g.nodes.has(like)) throw new Error('node not found: ' + like);
  const base = g.nodes.get(like)!;
  const baseHash = g.hash.get(like)!;
  const baseIds = g.subtree(like);
  const baseHist = typeHist(g, baseIds);
  const baseProfile = profileOf(g, dbPath, baseIds);
  const basePal = new Set(baseProfile.palette.keys());
  const baseFonts = new Set(baseProfile.fonts.keys());
  const baseRadii = new Set([...baseProfile.radii.keys()].map(String));
  const rows: FindRow[] = [];
  const exact: FindRow[] = [];
  for (const [id, n] of g.nodes) {
    if (id === like) continue;
    if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
    if (Math.abs((n.bbox_w ?? 0) - (base.bbox_w ?? 0)) > 2) continue;
    if (Math.abs((n.bbox_h ?? 0) - (base.bbox_h ?? 0)) > 2) continue;
    const ids = g.subtree(id);
    if (ids.length < 20) continue;
    const prof = profileOf(g, dbPath, ids);
    const struct = cosine(baseHist, typeHist(g, ids));
    const pal = jaccard(basePal, new Set(prof.palette.keys()));
    const fonts = jaccard(baseFonts, new Set(prof.fonts.keys()));
    const radii = jaccard(baseRadii, new Set([...prof.radii.keys()].map(String)));
    const style = 0.5 * pal + 0.3 * fonts + 0.2 * radii;
    const row: FindRow = { id, name: n.name, page: n.page_name, nodes: ids.length, struct: Number(struct.toFixed(4)), style: Number(style.toFixed(4)) };
    if (g.hash.get(id) === baseHash) exact.push(row);
    else rows.push(row);
  }
  const near = rows.filter((r) => r.struct >= 0.9).sort((a, b) => b.struct - a.struct);
  const styleOnly = rows.filter((r) => r.struct < 0.9 && r.style >= 0.45).sort((a, b) => b.style - a.style);
  const unranked = rows.length - near.length - styleOnly.length;
  return {
    like,
    name: base.name,
    candidates: rows.length + exact.length,
    exact: exact.sort((a, b) => b.nodes - a.nodes).slice(0, top),
    near: near.slice(0, top),
    styleOnly: styleOnly.slice(0, top),
    unranked,
  };
}
