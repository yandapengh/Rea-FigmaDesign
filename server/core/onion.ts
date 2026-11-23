/// <reference lib="es2022" />
/**
 * Tier 1.5 onion normalization (stage 5, promoted from the lab).
 *
 * Additive layer only: Tier 1 hashes in graph.ts stay untouched.
 */
import { createHash } from 'node:crypto';
import Database = require('better-sqlite3');
import { Graph, headlineOf } from './graph';

export interface OnionOptions {
  textBucket?: boolean;
  dimBucket?: boolean;
  runMin?: number;
}

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/** Transparent single-child FRAME/GROUP wrappers, read from style JSON. */
export function transparentShells(g: Graph, dbPath: string): Set<string> {
  const cand: string[] = [];
  for (const [id, n] of g.nodes) {
    if (n.type !== 'FRAME' && n.type !== 'GROUP') continue;
    const kids = g.children.get(id);
    if (kids && kids.length === 1) cand.push(id);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const out = new Set<string>();
  for (let i = 0; i < cand.length; i += 500) {
    const part = cand.slice(i, i + 500);
    const rows = db.prepare('SELECT id, style_json FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string; style_json: string }>;
    for (const row of rows) {
      try {
        const st = JSON.parse(row.style_json) as { fills?: Array<{ opacity?: number }>; strokes?: unknown[]; effects?: unknown[]; cornerRadius?: unknown };
        const visibleFill = (st.fills ?? []).some((f) => typeof f.opacity !== 'number' || f.opacity > 0.05);
        const hasStroke = (st.strokes ?? []).length > 0;
        const hasEffect = (st.effects ?? []).length > 0;
        const radius = typeof st.cornerRadius === 'number' ? st.cornerRadius : 0;
        if (!visibleFill && !hasStroke && !hasEffect && radius === 0) out.add(row.id);
      } catch {
        // skip malformed style rows
      }
    }
  }
  db.close();
  return out;
}

function textBucket(text: string | null): string {
  if (!text) return 'none';
  const s = text.trim();
  if (!s) return 'empty';
  if (/^[\d\s.,%+\-]+$/.test(s)) return s.length > 4 ? 'num-long' : 'num';
  return s.length > 24 ? 'long' : 'short';
}

/** Compute onion-normalized hashes for every node in the graph. */
export function onionHashes(g: Graph, dbPath: string, options: OnionOptions = {}): Map<string, string> {
  const shells = transparentShells(g, dbPath);
  const runMin = options.runMin ?? 3;
  const memo = new Map<string, string>();
  const visit = (id: string): string => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const n = g.nodes.get(id);
    if (!n) return '';
    if (n.is_icon_container === 1) { memo.set(id, 'ICON'); return 'ICON'; }
    const tokens = (g.children.get(id) ?? []).map((kid) => visit(kid));
    const collapsed: string[] = [];
    for (let i = 0; i < tokens.length;) {
      let j = i + 1;
      while (j < tokens.length && tokens[j] === tokens[i]) j += 1;
      const run = j - i;
      if (run >= runMin) {
        const bucket = run >= 11 ? '11+' : run >= 6 ? '6-10' : run >= 4 ? '4-5' : '3';
        collapsed.push('RUN' + bucket + ':' + tokens[i]);
      } else {
        for (let k = 0; k < run; k += 1) collapsed.push(tokens[i]);
      }
      i = j;
    }
    const isScreen = Math.abs((n.bbox_w ?? 0) - 390) <= 4 && Math.abs((n.bbox_h ?? 0) - 844) <= 6;
    if (!isScreen && shells.has(id) && collapsed.length === 1) {
      memo.set(id, collapsed[0]);
      return collapsed[0];
    }
    let key = n.type + '|' + collapsed.join('');
    if (options.textBucket && n.type === 'TEXT') key += '|T' + textBucket(n.text_content);
    if (options.dimBucket && (n.type === 'FRAME' || n.type === 'INSTANCE' || n.type === 'COMPONENT')) {
      key += '|D' + Math.round((n.bbox_w ?? 0) / 50) * 50 + 'x' + Math.round((n.bbox_h ?? 0) / 50) * 50;
    }
    const hash = md5(key);
    memo.set(id, hash);
    return hash;
  };
  for (const id of g.nodes.keys()) visit(id);
  return memo;
}

export interface OnionScreenGroup {
  key: string;
  ids: string[];
  tier1Keys: string[];
  headline: string;
}

/** Screen-level groups: onion hash + headline. */
export function onionScreenGroups(g: Graph, hashes: Map<string, string>): OnionScreenGroup[] {
  const candidates = new Set<string>();
  for (const [id, n] of g.nodes) {
    if (n.type !== 'FRAME' && n.type !== 'COMPONENT' && n.type !== 'INSTANCE') continue;
    if (Math.abs((n.bbox_w ?? 0) - 390) > 4 || Math.abs((n.bbox_h ?? 0) - 844) > 6) continue;
    candidates.add(id);
  }
  const roots = [...candidates].filter((id) => {
    let p = g.nodes.get(id)?.parent_id ?? null;
    while (p) { if (candidates.has(p)) return false; p = g.nodes.get(p)?.parent_id ?? null; }
    return true;
  });
  const groups = new Map<string, OnionScreenGroup>();
  for (const id of roots) {
    const sub = g.subtree(id);
    const texts: string[] = [];
    for (const sid of sub) { const t = g.nodes.get(sid)?.text_content; if (t) texts.push(t); }
    const headline = headlineOf(texts).toLowerCase().replace(/\d+/g, '#').trim();
    const onion = hashes.get(id) ?? '';
    const key = onion + '|' + headline;
    const group = groups.get(key) ?? { key, ids: [], tier1Keys: [], headline };
    group.ids.push(id);
    const t1 = (g.hash.get(id) ?? '') + '|' + headline;
    if (group.tier1Keys.indexOf(t1) === -1) group.tier1Keys.push(t1);
    groups.set(key, group);
  }
  return [...groups.values()];
}
