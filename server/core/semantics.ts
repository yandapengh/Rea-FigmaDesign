/// <reference lib="es2022" />
/**
 * Core semantics: labels, generation votes, variant axes, dialog markers.
 *
 * Pure by contract: no process.exit, no CLI formatting, no writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Graph, profileOf, jaccard, normalizeText, isChrome } from './graph';

export interface ScreenLabel { id: string; category: string; kind: string; note?: string }
export interface MarkerFile { sample?: string; markers: Array<{ id: string; dialogs: number; pages: number }> }

let MARKER_CACHE: Set<string> | null = null;

export function loadMarkers(path: string): Set<string> {
  if (MARKER_CACHE) return MARKER_CACHE;
  MARKER_CACHE = new Set<string>();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as MarkerFile;
    for (const m of parsed.markers ?? []) MARKER_CACHE.add(m.id);
  } catch {
    // no marker file yet — geometry only
  }
  return MARKER_CACHE;
}

export function componentsOf(g: Graph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const n = g.nodes.get(cur)!;
    if (n.type === 'INSTANCE' && n.main_component_id) out.add(n.main_component_id);
    const kids = g.children.get(cur);
    if (kids) for (const k of kids) stack.push(k);
  }
  return out;
}

export function hasDialogMarker(g: Graph, id: string, markers: Set<string>): boolean {
  if (markers.size === 0) return false;
  for (const c of componentsOf(g, id)) if (markers.has(c)) return true;
  return false;
}


export interface LabelEntry {
  id: string;
  label: string;
  sample?: string;
  note?: string;
}

export interface LabelFile {
  version?: number;
  labels: LabelEntry[];
}

export interface GroupStats {
  label: string;
  count: number;
  fontCounts: Map<string, number>;
  dominantFamily: string;
  families: Set<string>;
  palette: Set<string>;
  radii: Set<string>;
  tokenRatio: number;
  ids: string[];
}

export function loadLabels(path: string): LabelFile {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error('labels file not found: ' + path);
  }
  const parsed = JSON.parse(raw) as LabelFile;
  if (!parsed || !Array.isArray(parsed.labels) || parsed.labels.length === 0) {
    throw new Error('labels file has no labels: ' + path);
  }
  return parsed;
}

export function fontFamilyOf(key: string): string {
  return key.split(' ')[0];
}

export function groupStats(g: Graph, dbPath: string, labels: LabelEntry[]): GroupStats[] {
  const byLabel = new Map<string, LabelEntry[]>();
  for (const l of labels) {
    const bucket = byLabel.get(l.label);
    if (bucket) bucket.push(l);
    else byLabel.set(l.label, [l]);
  }
  const out: GroupStats[] = [];
  for (const [label, entries] of byLabel) {
    const fontCounts = new Map<string, number>();
    const families = new Set<string>();
    const palette = new Set<string>();
    const radii = new Set<string>();
    let tokens = 0;
    let nodes = 0;
    const ids: string[] = [];
    for (const e of entries) {
      if (!g.nodes.has(e.id)) continue;
      ids.push(e.id);
      const sub = g.subtree(e.id);
      const p = profileOf(g, dbPath, sub);
      for (const [k, n] of p.fonts) {
        const fam = fontFamilyOf(k);
        families.add(fam);
        fontCounts.set(fam, (fontCounts.get(fam) ?? 0) + n);
      }
      for (const c of p.palette.keys()) palette.add(c);
      for (const r of p.radii.keys()) radii.add(String(r));
      tokens += p.tokens;
      nodes += p.nodes;
    }
    const domEntry = [...fontCounts.entries()].sort((x, y) => y[1] - x[1])[0];
    out.push({ label, count: ids.length, fontCounts, dominantFamily: domEntry ? domEntry[0] : '', families, palette, radii, tokenRatio: nodes > 0 ? tokens / nodes : 0, ids });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : 1));
}

export function decideLabel(res: { label: string; margin: number; votes: Vote[] }, floor: number): { verdict: string; best: number; ambiguous: boolean } {
  const best = res.votes[0] ? res.votes[0].total : 0;
  // Abstain when the two generations are indistinguishable (small margin), or when the node
  // fits neither group well AND there is no clear winner. A low absolute score alone is not
  // disqualifying: atypical screens still often have an unambiguous winner.
  const ambiguous = res.margin < 0.1 || (best < floor && res.margin < 0.25);
  return { verdict: ambiguous ? 'unknown' : res.label, best, ambiguous };
}

export interface Vote {
  label: string;
  total: number;
  font: number;
  token: number;
  palette: number;
  radius: number;
}

export function classifyWith(g: Graph, dbPath: string, id: string, groups: GroupStats[]): { label: string; margin: number; votes: Vote[] } {
  const sub = g.subtree(id);
  const p = profileOf(g, dbPath, sub);
  const famCounts = new Map<string, number>();
  let famTotal = 0;
  for (const [k, n] of p.fonts) {
    const f = fontFamilyOf(k);
    famCounts.set(f, (famCounts.get(f) ?? 0) + n);
    famTotal += n;
  }
  const fonts = new Set<string>(famCounts.keys());
  const pal = new Set(p.palette.keys());
  const rad = new Set([...p.radii.keys()].map(String));
  const ratio = p.nodes > 0 ? p.tokens / p.nodes : 0;
  const votes: Vote[] = groups.map((gp) => {
    const font = famTotal > 0 ? (famCounts.get(gp.dominantFamily) ?? 0) / famTotal : 0;
    const logDist = Math.abs(Math.log10((ratio + 0.001) / (gp.tokenRatio + 0.001))) / 1.5;
    const token = Math.max(0, 1 - logDist);
    const palette = jaccard(pal, gp.palette);
    const radius = jaccard(rad, gp.radii);
    const total = 0.4 * font + 0.35 * token + 0.1 * palette + 0.15 * radius;
    return { label: gp.label, total, font, token, palette, radius };
  });
  votes.sort((a, b) => b.total - a.total);
  const margin = votes[0].total - (votes[1] ? votes[1].total : 0);
  const label = margin < 0.1 ? 'unknown' : votes[0].label;
  return { label, margin, votes };
}


export interface DerivedAxis {
  key: string;
  members: string[];
  samples: string[];
  size: string;
  depth: number;
  hint?: string;
}

export interface DerivedFamily {
  family: string;
  nameHint: string;
  members: number;
  axes: DerivedAxis[];
  unresolved: string[];
}

// Display-only keyword hints. They never affect grouping, ranking or membership;
// they exist so a human reading the table gets a first guess at what the axis means.
export const HINT_WORDS: Array<[RegExp, string]> = [
  [/unsuccess|not successful|fail|error|unable|declin|reject|block|cancel|expire/i, 'negative'],
  [/process|pending|in progress|waiting|progressing/i, 'in-flight'],
  [/success|complete|done|approved/i, 'positive'],
];

export function hintOf(texts: string[]): string {
  const votes = new Map<string, number>();
  for (const t of texts) {
    for (const [re, word] of HINT_WORDS) {
      if (re.test(t)) {
        votes.set(word, (votes.get(word) ?? 0) + 1);
        break;
      }
    }
  }
  if (votes.size === 0) return '';
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function deriveFamilyAxes(g: Graph, members: string[], showHint: boolean): DerivedFamily {
  const presence = new Map<string, string[]>();
  const sizes = new Map<string, { w: number; h: number }>();
  const depths = new Map<string, number>();
  const textsByMember = new Map<string, string[]>();
  const rootDepth = g.depthOf(members[0]);

  for (const m of members) {
    const sub = g.subtree(m);
    const comps = new Set<string>();
    const texts: string[] = [];
    for (const id of sub) {
      const n = g.nodes.get(id)!;
      if (n.type === 'INSTANCE' && n.main_component_id) {
        comps.add(n.main_component_id);
        const prev = sizes.get(n.main_component_id);
        const w = n.bbox_w ?? 0;
        const h = n.bbox_h ?? 0;
        if (!prev || w * h > prev.w * prev.h) sizes.set(n.main_component_id, { w, h });
        const rel = g.depthOf(id) - rootDepth;
        const prevDepth = depths.get(n.main_component_id);
        if (prevDepth === undefined || rel < prevDepth) depths.set(n.main_component_id, rel);
      }
      if (n.text_content) {
        const t = normalizeText(n.text_content);
        if (t && !isChrome(t)) texts.push(t);
      }
    }
    textsByMember.set(m, texts);
    for (const c of comps) {
      const bucket = presence.get(c);
      if (bucket) bucket.push(m);
      else presence.set(c, [m]);
    }
  }

  const switches = [...presence.entries()].filter(([, ids]) => ids.length > 0 && ids.length < members.length);
  if (switches.length === 0) {
    return { family: '', nameHint: g.nodes.get(members[0])!.name, members: members.length, axes: [], unresolved: [...members] };
  }

  // Components that always co-occur are the same switch: merge by identical presence signature.
  const bySignature = new Map<string, { ids: string[]; comps: string[] }>();
  for (const [comp, ids] of switches) {
    const sig = ids.slice().sort().join('|');
    const entry = bySignature.get(sig);
    if (entry) entry.comps.push(comp);
    else bySignature.set(sig, { ids, comps: [comp] });
  }

  const axes: DerivedAxis[] = [];
  for (const [, entry] of bySignature) {
    const ids = entry.ids;
    const comp = entry.comps[0];
    const others = members.filter((m) => ids.indexOf(m) === -1);
    const unique: string[] = [];
    for (const m of ids) {
      for (const t of textsByMember.get(m) ?? []) {
        let shared = false;
        for (const o of others) {
          if ((textsByMember.get(o) ?? []).indexOf(t) !== -1) {
            shared = true;
            break;
          }
        }
        if (!shared && unique.indexOf(t) === -1 && t.length >= 2) unique.push(t);
      }
    }
    unique.sort((a, b) => a.length - b.length);
    const size = sizes.get(comp) ?? { w: 0, h: 0 };
    const key = entry.comps.length > 1 ? comp + ' (+' + (entry.comps.length - 1) + ')' : comp;
    axes.push({
      key,
      members: ids,
      samples: unique.slice(0, 3).map((t) => t.slice(0, 56)),
      size: Math.round(size.w) + 'x' + Math.round(size.h),
      depth: depths.get(comp) ?? 0,
      hint: showHint ? hintOf(unique) : undefined,
    });
  }

  const unresolved: string[] = [];
  for (const m of members) {
    const own = axes.filter((a) => a.members.indexOf(m) !== -1);
    if (own.length !== 1) unresolved.push(m);
  }

  return { family: '', nameHint: g.nodes.get(members[0])!.name, members: members.length, axes, unresolved };
}

export const V2_MAJORS = ['老UI', '新UI', '系統UI', '彈窗類', '頁面類', '廢棄'] as const;

export interface ScreenLabelV2 {
  id: string;
  label: string;
  major: string;
  minor: string;
  generation: string;
  note?: string;
}

export interface ArchivedScreenLabelV2 extends ScreenLabelV2 {
  deletedAt: string;
}

export interface ScreenLabelsV2File {
  version: 2;
  sample?: string;
  note?: string;
  counts: Record<string, number>;
  screens: ScreenLabelV2[];
  archivedDeleted?: ArchivedScreenLabelV2[];
}

export function recomputeV2Counts(screens: ScreenLabelV2[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of screens) {
    counts[s.major] = (counts[s.major] ?? 0) + 1;
  }
  return counts;
}

export function loadScreenLabelsV2(path: string): ScreenLabelsV2File {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error('v2 labels file not found: ' + path);
  }
  const parsed = JSON.parse(raw) as Partial<ScreenLabelsV2File>;
  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.screens)) {
    throw new Error('invalid v2 labels file (expected version=2 and screens array): ' + path);
  }
  return {
    version: 2,
    sample: parsed.sample,
    note: parsed.note,
    counts: parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : recomputeV2Counts(parsed.screens),
    screens: parsed.screens,
  };
}

export function tryLoadScreenLabelsV2(path: string): ScreenLabelsV2File | null {
  if (!existsSync(path)) return null;
  return loadScreenLabelsV2(path);
}

export interface V2CategoryListItem {
  major: string;
  count: number;
  minors: Array<{ minor: string; count: number; pages: number }>;
}

export function summarizeCategoriesV2(screens: ScreenLabelV2[], pageById: Map<string, string>): V2CategoryListItem[] {
  const majors = new Map<string, { count: number; minors: Map<string, { count: number; pages: Set<string> }> }>();
  for (const r of screens) {
    const rec = majors.get(r.major) ?? { count: 0, minors: new Map() };
    rec.count += 1;
    const minor = r.minor || '(只到大類)';
    const sub = rec.minors.get(minor) ?? { count: 0, pages: new Set<string>() };
    sub.count += 1;
    const pg = (pageById.get(r.id) ?? '').trim();
    if (pg) sub.pages.add(pg);
    rec.minors.set(minor, sub);
    majors.set(r.major, rec);
  }
  return [...majors.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([major, rec]) => ({
      major,
      count: rec.count,
      minors: [...rec.minors.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([minor, sub]) => ({ minor, count: sub.count, pages: sub.pages.size })),
    }));
}

export interface V2CategoryReport {
  category: string;
  total: number;
  pages: Array<{ page: string; count: number; ids: string[] }>;
}

export function categoryReportV2(screens: ScreenLabelV2[], category: string, pageById: Map<string, string>): V2CategoryReport | null {
  let wanted = screens.filter((r) => r.label === category || r.minor === category);
  if (wanted.length === 0) {
    wanted = screens.filter((r) => r.major === category);
  }
  if (wanted.length === 0) return null;
  const groups = new Map<string, string[]>();
  for (const r of wanted) {
    const pg = (pageById.get(r.id) ?? '').trim() || '(未知頁面)';
    const list = groups.get(pg) ?? [];
    list.push(r.id);
    groups.set(pg, list);
  }
  const pages = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([page, ids]) => ({ page, count: ids.length, ids }));
  return { category, total: wanted.length, pages };
}


