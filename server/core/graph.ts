/// <reference lib="es2022" />
/**
 * Core graph + feature extraction.
 *
 * Pure by contract: no process.exit, no CLI formatting, no writes.
 * The CLI and any future MCP adapter both import this module.
 */
import { createHash } from 'node:crypto';
import Database = require('better-sqlite3');

export const SELECT_NODES =
  'select id, parent_id, child_index, type, name, page_id, page_name, ' +
  'bbox_x, bbox_y, bbox_w, bbox_h, text_content, main_component_id, is_icon_container from nodes';
export const SELECT_STYLE =
  'select id, style_json, text_style_json, layout_props_json, bound_variables_json ' +
  'from nodes where id = ?';

export interface NodeLite {
  id: string;
  parent_id: string | null;
  child_index: number;
  type: string;
  name: string;
  page_id: string;
  page_name: string;
  bbox_x: number | null;
  bbox_y: number | null;
  bbox_w: number | null;
  bbox_h: number | null;
  text_content: string | null;
  main_component_id: string | null;
  is_icon_container: number;
}

export interface StyleRow {
  id: string;
  style_json: string;
  text_style_json: string | null;
  layout_props_json: string;
  bound_variables_json: string;
}

export interface FillPayload {
  type?: string;
  hex?: string;
  stops?: Array<{ hex?: string }>;
}

export interface EffectPayload {
  type?: string;
  radius?: number;
}

export interface StylePayload {
  fills?: FillPayload[];
  strokes?: FillPayload[];
  effects?: EffectPayload[];
  cornerRadius?: number;
}

export interface TextStylePayload {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
}


export class Graph {
  readonly nodes = new Map<string, NodeLite>();
  readonly children = new Map<string, string[]>();
  readonly hash = new Map<string, string>();
  readonly byHash = new Map<string, string[]>();

  constructor(dbPath: string) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(SELECT_NODES).all() as NodeLite[];
    db.close();

    for (const r of rows) this.nodes.set(r.id, r);
    for (const r of rows) {
      if (r.parent_id === null) continue;
      const bucket = this.children.get(r.parent_id);
      if (bucket) bucket.push(r.id);
      else this.children.set(r.parent_id, [r.id]);
    }
    for (const bucket of this.children.values()) {
      bucket.sort((a, b) => this.nodes.get(a)!.child_index - this.nodes.get(b)!.child_index);
    }
    this.computeHashes(rows);
  }

  private computeHashes(rows: NodeLite[]): void {
    const stack: Array<[string, boolean]> = [];
    for (const r of rows) if (!this.hash.has(r.id)) stack.push([r.id, false]);
    while (stack.length > 0) {
      const [id, visited] = stack.pop()!;
      if (this.hash.has(id)) continue;
      const kids = this.children.get(id);
      if (!visited) {
        stack.push([id, true]);
        if (kids) for (const k of kids) if (!this.hash.has(k)) stack.push([k, false]);
        continue;
      }
      const node = this.nodes.get(id)!;
      const parts = kids ? kids.map((k) => this.hash.get(k)!) : [];
      const h = createHash('md5').update(node.type + '|' + parts.join('')).digest('hex');
      this.hash.set(id, h);
      const bucket = this.byHash.get(h);
      if (bucket) bucket.push(id);
      else this.byHash.set(h, [id]);
    }
  }

  subtree(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      out.push(cur);
      const kids = this.children.get(cur);
      if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
    return out;
  }

  depthOf(id: string): number {
    let d = 0;
    let cur = this.nodes.get(id);
    while (cur && cur.parent_id) {
      d += 1;
      cur = this.nodes.get(cur.parent_id);
    }
    return d;
  }

  topLevelMembers(hash: string): string[] {
    const ids = this.byHash.get(hash) ?? [];
    const set = new Set(ids);
    return ids.filter((id) => {
      let p = this.nodes.get(id)?.parent_id ?? null;
      while (p) {
        if (set.has(p)) return false;
        p = this.nodes.get(p)?.parent_id ?? null;
      }
      return true;
    });
  }
}

export function styleRows(dbPath: string, ids: string[]): Map<string, StyleRow> {
  const out = new Map<string, StyleRow>();
  if (ids.length === 0) return out;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const stmt = db.prepare(SELECT_STYLE);
  for (const id of ids) {
    const row = stmt.get(id) as StyleRow | undefined;
    if (row) out.set(id, row);
  }
  db.close();
  return out;
}

export function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as T) : null;
  } catch {
    return null;
  }
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export const CHROME = new Set(['Done', 'Done (3s)', 'Ok (3s)', '9:41', 'Close', 'Back']);

export function isChrome(t: string): boolean {
  if (CHROME.has(t)) return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;
  return false;
}



export function hasTextIn(g: Graph, id: string): boolean {
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const n = g.nodes.get(cur)!;
    if (n.type === 'TEXT' && n.text_content && n.text_content.trim()) return true;
    const kids = g.children.get(cur);
    if (kids) for (const k of kids) stack.push(k);
  }
  return false;
}

export function archetypeOf(g: Graph, id: string): string {
  const n = g.nodes.get(id)!;
  const w = n.bbox_w ?? 0;
  const h = n.bbox_h ?? 0;
  if (w <= 0 || h <= 0) return 'unknown';
  const area = w * h;
  let cur = id;
  // Unwrap single full-bleed wrapper instances (designers nest the real screen one level down).
  for (let i = 0; i < 4; i += 1) {
    const kids = g.children.get(cur) ?? [];
    if (kids.length !== 1) break;
    const k = g.nodes.get(kids[0])!;
    if ((k.bbox_w ?? 0) >= 0.95 * w && (k.bbox_h ?? 0) >= 0.95 * h) {
      cur = kids[0];
      continue;
    }
    break;
  }
  const kids = g.children.get(cur) ?? [];
  // A scrim is a frame-sized, text-free layer stacked under a smaller panel.
  // child_index is the z-order, so "index i has a smaller sibling above it" is directly readable.
  for (let i = 0; i + 1 < kids.length; i += 1) {
    const kn = g.nodes.get(kids[i])!;
    const kw = kn.bbox_w ?? 0;
    const kh = kn.bbox_h ?? 0;
    if (Math.abs(kw - w) > 3 || Math.abs(kh - h) > 3) continue;
    const above = g.nodes.get(kids[i + 1])!;
    const aboveArea = (above.bbox_w ?? 0) * (above.bbox_h ?? 0);
    if (aboveArea >= 0.5 * area) continue;
    if (hasTextIn(g, kids[i])) continue;
    return 'overlay-panel';
  }
  let full = 0;
  for (const k of kids) {
    const kn = g.nodes.get(k)!;
    if ((kn.bbox_w ?? 0) * (kn.bbox_h ?? 0) >= 0.9 * area) full += 1;
  }
  return full >= 2 ? 'overlay' : 'page';
}

export function headlineOf(texts: string[]): string {
  let best = '';
  for (const t of texts) {
    if (isChrome(t)) continue;
    if (t.length > best.length) best = t;
  }
  return best.slice(0, 58);
}

export interface Slots {
  texts: string[];
  icons: string[];
  instances: number;
  iconsCount: number;
  nodes: number;
}

export function slotsOf(g: Graph, id: string): Slots {
  const ids = g.subtree(id);
  const texts: string[] = [];
  const icons = new Set<string>();
  let instances = 0;
  let iconsCount = 0;
  for (const nid of ids) {
    const n = g.nodes.get(nid)!;
    if (n.text_content) {
      const t = normalizeText(n.text_content);
      if (t) texts.push(t);
    }
    if (n.type === 'INSTANCE') {
      instances += 1;
      if (n.main_component_id) icons.add(n.main_component_id);
    }
    if (n.is_icon_container === 1) iconsCount += 1;
  }
  return { texts, icons: [...icons].sort(), instances, iconsCount, nodes: ids.length };
}

export function typeHist(g: Graph, ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ids) {
    const t = g.nodes.get(id)!.type;
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface StyleProfile {
  nodes: number;
  palette: Map<string, number>;
  gradientStops: number;
  radii: Map<number, number>;
  fonts: Map<string, number>;
  sizes: Map<number, number>;
  effects: Map<string, number>;
  tokens: number;
  tokenLibraries: number;
  spacing: Map<number, number>;
  texts: number;
  icons: number;
  instances: number;
  types: Map<string, number>;
}

export function profileOf(g: Graph, dbPath: string, ids: string[]): StyleProfile {
  const rows = styleRows(dbPath, ids);
  const p: StyleProfile = {
    nodes: ids.length,
    palette: new Map(),
    gradientStops: 0,
    radii: new Map(),
    fonts: new Map(),
    sizes: new Map(),
    effects: new Map(),
    tokens: 0,
    tokenLibraries: 0,
    spacing: new Map(),
    texts: 0,
    icons: 0,
    instances: 0,
    types: new Map(),
  };
  const libs = new Set<string>();
  for (const id of ids) {
    const n = g.nodes.get(id)!;
    p.types.set(n.type, (p.types.get(n.type) ?? 0) + 1);
    if (n.type === 'TEXT') p.texts += 1;
    if (n.type === 'INSTANCE') p.instances += 1;
    if (n.is_icon_container === 1) p.icons += 1;
    const row = rows.get(id);
    if (!row) continue;
    const style = parseJson<StylePayload>(row.style_json);
    if (style) {
      for (const f of style.fills ?? []) {
        if (f.hex) {
          const key = f.hex.toUpperCase();
          p.palette.set(key, (p.palette.get(key) ?? 0) + 1);
        }
        for (const s of f.stops ?? []) {
          if (s.hex) {
            p.gradientStops += 1;
            const key = s.hex.toUpperCase();
            p.palette.set(key, (p.palette.get(key) ?? 0) + 1);
          }
        }
      }
      if (style.cornerRadius && style.cornerRadius > 0) {
        p.radii.set(style.cornerRadius, (p.radii.get(style.cornerRadius) ?? 0) + 1);
      }
      for (const e of style.effects ?? []) {
        if (e.type) p.effects.set(e.type, (p.effects.get(e.type) ?? 0) + 1);
      }
    }
    const ts = parseJson<TextStylePayload>(row.text_style_json);
    if (ts && ts.fontFamily) {
      const key = ts.fontFamily + ' ' + (ts.fontWeight ?? '') + '/' + (ts.fontSize ?? '');
      p.fonts.set(key, (p.fonts.get(key) ?? 0) + 1);
    }
    if (ts && typeof ts.fontSize === 'number') {
      p.sizes.set(ts.fontSize, (p.sizes.get(ts.fontSize) ?? 0) + 1);
    }
    const bound = row.bound_variables_json;
    if (bound && bound !== '{}' && bound !== '[]') {
      p.tokens += 1;
      const parsed = parseJson<Record<string, { id?: string }>>(bound);
      if (parsed) {
        for (const v of Object.values(parsed)) {
          const vid = v && typeof v === 'object' ? v.id : undefined;
          if (typeof vid === 'string') {
            const m = /^VariableID:([^/]+)\//.exec(vid);
            if (m) libs.add(m[1]);
          }
        }
      }
    }
    const layout = parseJson<{ itemSpacing?: number }>(row.layout_props_json);
    if (layout && typeof layout.itemSpacing === 'number' && layout.itemSpacing > 0) {
      p.spacing.set(layout.itemSpacing, (p.spacing.get(layout.itemSpacing) ?? 0) + 1);
    }
  }
  p.tokenLibraries = libs.size;
  return p;
}

export function topEntries<K>(m: Map<K, number>, n: number): Array<[K, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Top-level 390x844 frame/component/instance screen root candidates (non-nested, sorted). */
export function findScreenRootCandidates(g: Graph): string[] {
  const cand = new Set<string>();
  for (const [id, n] of g.nodes) {
    if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
    if (Math.abs((n.bbox_w ?? 0) - 390) > 4 || Math.abs((n.bbox_h ?? 0) - 844) > 6) continue;
    cand.add(id);
  }
  const roots: string[] = [];
  for (const id of cand) {
    let p = g.nodes.get(id)?.parent_id ?? null;
    let nested = false;
    while (p) {
      if (cand.has(p)) {
        nested = true;
        break;
      }
      p = g.nodes.get(p)?.parent_id ?? null;
    }
    if (!nested) roots.push(id);
  }
  return roots.sort();
}

/** Screen roots filtered by minimum subtree node count (default 40). */
export function findScreenRoots(g: Graph, minNodes = 40): string[] {
  return findScreenRootCandidates(g).filter((id) => g.subtree(id).length >= minNodes);
}


