/// <reference lib="es2022" />
/**
 * Visual Human-Review & Copy-as-Prompt Workbench (Dashboard + Master-Detail).
 *
 * Generates a standalone HTML workbench under .scratch/review.html for:
 *  - Designer-first Category Dashboard + Page-grouped Detail cards
 *  - Cold-start AST-only grouping (--unlabeled)
 *  - Category audit (--category <name>)
 *  - Stratified human spot-check (--sample <N>)
 *  - Targeted IDs / page filtering (--ids <a,b> / --page <substr>)
 *
 * Designers leave blank any item that looks fine, type freeform feedback only
 * where something is wrong, then click "複製為 Agent 提示詞".
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import Database = require('better-sqlite3');
import { AstGraphDB } from './db';
import { Graph, archetypeOf, findScreenRootCandidates, headlineOf, parseJson, type StylePayload } from './core/graph';
import { tryLoadScreenLabelsV2, type ScreenLabelV2 } from './core/semantics';

const ROOT = resolve(__dirname, '..');
const SCRATCH = resolve(ROOT, '.scratch');

export interface ReviewBoardOptions {
  dbPath: string;
  graph?: Graph;
  category?: string;
  page?: string;
  unlabeled?: boolean;
  sample?: number;
  ids?: string[];
  outPath?: string;
  open?: boolean;
}

export interface ReviewBoardResult {
  html: string;
  unique: number;
  screens: number;
  db: string;
  modeLabel: string;
  isColdStart: boolean;
}

export function generateReviewBoard(opts: ReviewBoardOptions): ReviewBoardResult {
  const dbPath = resolve(ROOT, opts.dbPath);
  if (!dbPath || !existsSync(dbPath)) {
    throw new Error('no database found; run the Figma extraction first');
  }
  const outPath = opts.outPath ? resolve(ROOT, opts.outPath) : join(SCRATCH, 'review.html');
  if (!(outPath === SCRATCH || outPath.startsWith(SCRATCH + sep))) {
    throw new Error('--out must stay inside .scratch/ (got ' + outPath + ')');
  }

  const categoryFilter = opts.category?.trim() ?? '';
  const pageFilter = opts.page?.trim() ?? '';
  const unlabeledOnly = opts.unlabeled === true;
  const sampleCount = typeof opts.sample === 'number' && opts.sample > 0 ? Math.max(1, Math.floor(opts.sample)) : 0;
  const idsFilter = (opts.ids ?? []).map((s) => s.trim()).filter(Boolean);

  const g = opts.graph ?? new Graph(dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let fileKey = '';
  let fileName = '';
  const pageMeta = new Map<string, { name: string; index: number }>();

  const v2Doc = tryLoadScreenLabelsV2(join(ROOT, 'labels/screens-v2.json'));
  const labelMap = new Map<string, ScreenLabelV2>();
  if (v2Doc) {
    for (const s of v2Doc.screens) labelMap.set(s.id, s);
  }

  const allRoots = findScreenRootCandidates(g);
  const idSet = new Set(idsFilter);
  const pageNeedle = pageFilter.toLowerCase();

  interface RawScreen {
    id: string;
    name: string;
    page: string;
    pageId: string;
    pageIndex: number;
    archetype: string;
    hash: string;
    nodes: number;
    headline: string;
    major: string;
    minor: string;
    label: string;
    generation: string;
    note: string;
  }

  interface Card {
    id: string;
    name: string;
    page: string;
    pageId: string;
    pageIndex: number;
    archetype: string;
    hash: string;
    shortHash: string;
    nodes: number;
    headline: string;
    copies: number;
    memberIds: string[];
    memberPages: string[];
    major: string;
    minor: string;
    label: string;
    generation: string;
    existingNote: string;
    palette: string[];
  }

  const rawScreens: RawScreen[] = [];
  let selectedCards: Card[] = [];

  try {
    const fileMeta = db.prepare('SELECT file_key, file_name FROM file_meta ORDER BY extracted_at DESC LIMIT 1').get() as
      | { file_key: string; file_name: string }
      | undefined;
    fileKey = fileMeta?.file_key ?? '';
    fileName = fileMeta?.file_name ?? '';
    for (const row of db.prepare('SELECT page_id, page_name, page_index FROM pages').all() as Array<{
      page_id: string;
      page_name: string;
      page_index: number;
    }>) {
      pageMeta.set(row.page_id, { name: row.page_name, index: row.page_index });
    }

    for (const id of allRoots) {
      const sub = g.subtree(id);
      if (sub.length < 40 && !idSet.has(id)) continue;
      const n = g.nodes.get(id)!;
      const pgInfo = pageMeta.get(n.page_id);
      const pageName = (pgInfo?.name ?? n.page_name ?? '').trim();
      const lbl = labelMap.get(id);

      if (idSet.size > 0 && !idSet.has(id)) continue;
      if (unlabeledOnly && lbl) continue;
      if (categoryFilter) {
        if (!lbl) continue;
        const matchMinor = lbl.minor === categoryFilter || lbl.label === categoryFilter;
        const matchMajor = lbl.major === categoryFilter;
        if (!matchMinor && !matchMajor) continue;
      }
      if (pageNeedle && pageName.toLowerCase().indexOf(pageNeedle) === -1) continue;

      const texts: string[] = [];
      for (const sid of sub) {
        const t = g.nodes.get(sid)?.text_content;
        if (t) texts.push(t);
      }
      rawScreens.push({
        id,
        name: n.name,
        page: pageName,
        pageId: n.page_id,
        pageIndex: pgInfo?.index ?? 9999,
        archetype: archetypeOf(g, id),
        hash: g.hash.get(id) ?? '',
        nodes: sub.length,
        headline: headlineOf(texts),
        major: lbl?.major ?? '',
        minor: lbl?.minor ?? '',
        label: lbl?.label ?? '',
        generation: lbl?.generation ?? '',
        note: lbl?.note ?? '',
      });
    }

    if (idSet.size > 0) {
      const included = new Set(rawScreens.map((r) => r.id));
      for (const id of idsFilter) {
        if (included.has(id) || !g.nodes.has(id)) continue;
        const n = g.nodes.get(id)!;
        const sub = g.subtree(id);
        const texts: string[] = [];
        for (const sid of sub) {
          const t = g.nodes.get(sid)?.text_content;
          if (t) texts.push(t);
        }
        const pgInfo = pageMeta.get(n.page_id);
        const lbl = labelMap.get(id);
        rawScreens.push({
          id,
          name: n.name,
          page: (pgInfo?.name ?? n.page_name ?? '').trim(),
          pageId: n.page_id,
          pageIndex: pgInfo?.index ?? 9999,
          archetype: archetypeOf(g, id),
          hash: g.hash.get(id) ?? '',
          nodes: sub.length,
          headline: headlineOf(texts),
          major: lbl?.major ?? '',
          minor: lbl?.minor ?? '',
          label: lbl?.label ?? '',
          generation: lbl?.generation ?? '',
          note: lbl?.note ?? '',
        });
      }
    }

    const cards: Card[] = [];
    if (idSet.size > 0) {
      for (const r of rawScreens) {
        cards.push({
          id: r.id,
          name: r.name,
          page: r.page,
          pageId: r.pageId,
          pageIndex: r.pageIndex,
          archetype: r.archetype,
          hash: r.hash,
          shortHash: r.hash.slice(0, 8),
          nodes: r.nodes,
          headline: r.headline,
          copies: 1,
          memberIds: [r.id],
          memberPages: r.page ? [r.page] : [],
          major: r.major,
          minor: r.minor,
          label: r.label,
          generation: r.generation,
          existingNote: r.note,
          palette: [],
        });
      }
    } else {
      const byKey = new Map<string, Card>();
      for (const r of rawScreens) {
        const k = r.hash + '|' + r.headline;
        const prev = byKey.get(k);
        if (!prev) {
          const card: Card = {
            id: r.id,
            name: r.name,
            page: r.page,
            pageId: r.pageId,
            pageIndex: r.pageIndex,
            archetype: r.archetype,
            hash: r.hash,
            shortHash: r.hash.slice(0, 8),
            nodes: r.nodes,
            headline: r.headline,
            copies: 1,
            memberIds: [r.id],
            memberPages: r.page ? [r.page] : [],
            major: r.major,
            minor: r.minor,
            label: r.label,
            generation: r.generation,
            existingNote: r.note,
            palette: [],
          };
          byKey.set(k, card);
          cards.push(card);
        } else {
          prev.copies += 1;
          prev.memberIds.push(r.id);
          if (r.page && prev.memberPages.indexOf(r.page) === -1) prev.memberPages.push(r.page);
        }
      }
    }

    selectedCards = cards;
    if (sampleCount > 0 && cards.length > sampleCount) {
      const sortedPool = cards.slice().sort((a, b) => {
        if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
        if (a.major !== b.major) return a.major < b.major ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
      const picked: Card[] = [];
      const step = sortedPool.length / sampleCount;
      for (let i = 0; i < sampleCount; i += 1) {
        const idx = Math.min(sortedPool.length - 1, Math.floor(i * step));
        picked.push(sortedPool[idx]);
      }
      selectedCards = picked;
    }

    const cardPalette = new Map<string, Map<string, number>>();
    const nodeToCard = new Map<string, string>();
    for (const c of selectedCards) {
      cardPalette.set(c.id, new Map<string, number>());
      const sub = g.subtree(c.id);
      const cap = Math.min(sub.length, 80);
      for (let i = 0; i < cap; i += 1) {
        const sid = sub[i];
        if (!nodeToCard.has(sid)) nodeToCard.set(sid, c.id);
      }
    }

    const addStyleToPalette = (cardId: string, styleJson: string): void => {
      const st = parseJson<StylePayload>(styleJson);
      if (!st) return;
      const pal = cardPalette.get(cardId);
      if (!pal) return;
      for (const f of st.fills ?? []) {
        if (f.hex) {
          const hx = f.hex.toUpperCase();
          pal.set(hx, (pal.get(hx) ?? 0) + 1);
        }
        for (const s of f.stops ?? []) {
          if (s.hex) {
            const hx = s.hex.toUpperCase();
            pal.set(hx, (pal.get(hx) ?? 0) + 1);
          }
        }
      }
      for (const s of st.strokes ?? []) {
        if (s.hex) {
          const hx = s.hex.toUpperCase();
          pal.set(hx, (pal.get(hx) ?? 0) + 1);
        }
      }
    };

    const targetIds = [...nodeToCard.keys()];
    if (targetIds.length > 0 && targetIds.length <= 4000 && fileKey) {
      for (let i = 0; i < targetIds.length; i += 500) {
        const part = targetIds.slice(i, i + 500);
        const rows = db
          .prepare('SELECT id, style_json FROM nodes WHERE file_key = ? AND id IN (' + part.map(() => '?').join(',') + ')')
          .all(fileKey, ...part) as Array<{ id: string; style_json: string }>;
        for (const r of rows) {
          const cid = nodeToCard.get(r.id);
          if (cid) addStyleToPalette(cid, r.style_json);
        }
      }
    } else if (targetIds.length > 0) {
      const sql = fileKey ? 'SELECT id, style_json FROM nodes WHERE file_key = ?' : 'SELECT id, style_json FROM nodes';
      const stmt = db.prepare(sql);
      const iter = (fileKey ? stmt.iterate(fileKey) : stmt.iterate()) as Iterable<{ id: string; style_json: string }>;
      for (const r of iter) {
        const cid = nodeToCard.get(r.id);
        if (cid) addStyleToPalette(cid, r.style_json);
      }
    }

    for (const c of selectedCards) {
      const pal = cardPalette.get(c.id);
      if (!pal) continue;
      c.palette = [...pal.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hx]) => hx);
    }
  } finally {
    db.close();
  }

  const famMap = new Map<string, Card[]>();
  let labeledUniqueCount = 0;
  let unlabeledUniqueCount = 0;
  for (const c of selectedCards) {
    const bucket = famMap.get(c.hash);
    if (bucket) bucket.push(c);
    else famMap.set(c.hash, [c]);
    if (c.major) labeledUniqueCount += 1;
    else unlabeledUniqueCount += 1;
  }

  const modeParts: string[] = [];
  if (categoryFilter) modeParts.push('分類=' + categoryFilter);
  if (unlabeledOnly) modeParts.push('僅未標註');
  if (pageFilter) modeParts.push('頁面含「' + pageFilter + '」');
  if (sampleCount > 0) modeParts.push('抽樣=' + sampleCount);
  if (idsFilter.length > 0) modeParts.push('指定ID=' + idsFilter.length);
  const modeLabel = modeParts.length > 0 ? modeParts.join(' · ') : '全量視圖';
  const isColdStart = !v2Doc || v2Doc.screens.length === 0;

  let autoSelectCategory = '';
  let autoSelectMode: 'overview' | 'category' | 'subset' = 'overview';
  if (categoryFilter && selectedCards.length > 0) {
    const catKeys = new Set(selectedCards.map((c) => (c.major || '未標註') + '::' + (c.minor || '(只到大類)')));
    if (catKeys.size === 1) {
      autoSelectCategory = [...catKeys][0];
      autoSelectMode = 'category';
    } else {
      autoSelectMode = 'subset';
    }
  } else if ((sampleCount > 0 || idsFilter.length > 0 || pageFilter) && selectedCards.length > 0 && selectedCards.length <= 60) {
    autoSelectMode = 'subset';
  }

  const payloadObj = {
    db: dbPath,
    fileName,
    modeLabel,
    isColdStart,
    defaultSidebarMode: (unlabeledOnly || isColdStart) && !categoryFilter ? 'families' : 'categories',
    totalRoots: allRoots.length,
    matchedScreens: rawScreens.length,
    uniqueCount: selectedCards.length,
    familyCount: famMap.size,
    labeledUniqueCount,
    unlabeledUniqueCount,
    autoSelectCategory,
    autoSelectMode,
    cards: selectedCards,
  };
  const payload = JSON.stringify(payloadObj).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="zh-Hant" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rea-FigmaDesign · 數據看板與人工複審</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-soft: #1c222b;
    --bg-hover: #212834;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-soft: #6e7681;
    --accent: #388bfd;
    --accent-bg: rgba(56, 139, 253, 0.14);
    --green: #3fb950;
    --green-bg: rgba(63, 185, 80, 0.14);
    --amber: #d29922;
    --amber-bg: rgba(210, 153, 34, 0.15);
    --purple: #bc8cff;
    --purple-bg: rgba(188, 140, 255, 0.14);
    --red: #f85149;
    --shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    --radius: 12px;
  }
  html[data-theme="light"] {
    --bg: #f6f8fa;
    --bg-elev: #ffffff;
    --bg-soft: #f0f3f6;
    --bg-hover: #eaeef2;
    --border: #d0d7de;
    --border-soft: #e6ebf1;
    --text: #1f2328;
    --text-muted: #59636e;
    --text-soft: #818b98;
    --accent: #0969da;
    --accent-bg: rgba(9, 105, 218, 0.1);
    --green: #1a7f37;
    --green-bg: rgba(26, 127, 55, 0.11);
    --amber: #9a6700;
    --amber-bg: rgba(154, 103, 0, 0.12);
    --purple: #8250df;
    --purple-bg: rgba(130, 80, 223, 0.1);
    --red: #cf222e;
    --shadow: 0 12px 28px rgba(31, 35, 40, 0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.5 -apple-system, "PingFang TC", "Microsoft YaHei", system-ui, sans-serif;
    display: flex;
    min-height: 100vh;
  }
  .sidebar {
    width: 280px;
    flex: 0 0 280px;
    height: 100vh;
    position: sticky;
    top: 0;
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sb-head {
    padding: 14px 14px 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  .sb-brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .sb-title { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
  .sb-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sb-nav-actions { display: flex; gap: 6px; margin-top: 10px; }
  .seg {
    display: flex;
    background: var(--bg-soft);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 2px;
    margin-top: 8px;
  }
  .seg button {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text-muted);
    padding: 5px 6px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .seg button.active { background: var(--accent); color: #fff; }
  .sb-search { width: 100%; margin-top: 8px; }
  .sb-scroll { flex: 1; overflow-y: auto; padding: 8px 10px 14px; }
  .sb-foot {
    padding: 10px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-elev);
  }
  .major-group { margin-bottom: 8px; }
  .major-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 6px;
    user-select: none;
  }
  .major-hdr:hover { background: var(--bg-hover); color: var(--text); }
  .cat-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 9px;
    margin: 2px 0;
    border-radius: 7px;
    cursor: pointer;
    color: var(--text);
    font-size: 12px;
    border: 1px solid transparent;
  }
  .cat-item:hover { background: var(--bg-hover); }
  .cat-item.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .cat-meta { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-soft);
    color: var(--text-muted);
  }
  .pill.green { background: var(--green-bg); color: var(--green); }
  .pill.accent { background: var(--accent-bg); color: var(--accent); }
  .pill.amber { background: var(--amber-bg); color: var(--amber); }
  .pill.purple { background: var(--purple-bg); color: var(--purple); }
  .pill.red { background: rgba(248,81,73,0.14); color: var(--red); }

  .workspace { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    padding: 10px 22px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .crumb { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .spacer { flex: 1; }
  .content { padding: 20px 24px 96px; max-width: 1320px; width: 100%; margin: 0 auto; }

  button.btn, .btn {
    background: var(--bg-soft);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 11px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  button.btn:hover { background: var(--bg-hover); }
  button.btn.primary { background: var(--green); border-color: var(--green); color: #fff; }
  button.btn.primary:hover { filter: brightness(1.08); }
  button.btn.accent { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.btn.ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
  button.btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
  button.btn.sm { padding: 4px 8px; font-size: 11px; border-radius: 6px; }
  input, select, textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 12px;
    font-family: inherit;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }

  .hint-bar {
    background: var(--accent-bg);
    border: 1px solid rgba(56,139,253,0.3);
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 12px;
    color: var(--text);
    margin-bottom: 18px;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  .kpi-card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .kpi-card.clickable { cursor: pointer; }
  .kpi-card.clickable:hover { border-color: var(--accent); }
  .kpi-label { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .kpi-val { font-size: 24px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi-sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
  .prog-track { height: 6px; background: var(--bg-soft); border-radius: 99px; overflow: hidden; margin-top: 8px; }
  .prog-fill { height: 100%; background: var(--green); border-radius: 99px; }

  .panel {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 20px;
  }
  .panel-title { font-size: 13px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; justify-content: space-between; }
  .dist-row {
    display: grid;
    grid-template-columns: 110px 1fr 120px;
    gap: 12px;
    align-items: center;
    padding: 6px 8px;
    border-radius: 8px;
    cursor: pointer;
  }
  .dist-row:hover { background: var(--bg-hover); }
  .dist-bar-wrap { height: 10px; background: var(--bg-soft); border-radius: 99px; overflow: hidden; }
  .dist-bar { height: 100%; border-radius: 99px; background: var(--accent); }
  .dist-num { text-align: right; font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

  .section-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 22px 0 10px;
    cursor: pointer;
  }
  .section-hdr h3 { margin: 0; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 12px;
  }
  .cat-card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    cursor: pointer;
    transition: transform 0.12s ease, border-color 0.12s ease;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cat-card:hover { transform: translateY(-2px); border-color: var(--accent); }
  .cat-card.has-note { border-color: var(--green); }
  .cat-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .cat-card-title { font-size: 14px; font-weight: 700; line-height: 1.3; word-break: break-word; }
  .cat-card-stat { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .palette-strip { display: flex; gap: 4px; align-items: center; }
  .sw { display: inline-block; width: 16px; height: 10px; border-radius: 3px; border: 1px solid rgba(128,128,128,0.28); }

  .detail-hero {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .detail-hero-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
  .detail-title { font-size: 18px; font-weight: 700; }
  .cat-note-box { width: 100%; min-height: 38px; resize: vertical; }
  .cat-note-box.filled, textarea.comment.filled { border-color: var(--green); background: var(--green-bg); }

  .filter-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 14px;
  }
  .page-group {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 12px;
    overflow: hidden;
  }
  .page-group-hdr {
    padding: 10px 14px;
    background: var(--bg-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }
  .page-group-hdr:hover { background: var(--bg-hover); }
  .page-group-title { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .page-group-body.hidden { display: none; }

  .screen-row {
    display: grid;
    grid-template-columns: auto 190px minmax(220px, 1fr) minmax(280px, 34%);
    gap: 14px;
    align-items: start;
    padding: 12px 14px;
    border-top: 1px solid var(--border-soft);
  }
  .screen-row:hover { background: var(--bg-hover); }
  .screen-row.has-note { background: rgba(63, 185, 80, 0.06); }
  .screen-row.selected { background: var(--accent-bg); }
  @media (max-width: 960px) {
    .screen-row { grid-template-columns: auto 1fr; }
  }
  .id-link {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    cursor: copy;
  }
  .id-link:hover { text-decoration: underline; }
  .layer-name { font-weight: 600; font-size: 13px; word-break: break-word; }
  .headline-txt {
    color: var(--text-muted);
    font-size: 12px;
    margin-top: 3px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  textarea.comment { width: 100%; min-height: 44px; resize: vertical; line-height: 1.45; }

  .unrec-row {
    display: grid;
    grid-template-columns: 200px minmax(220px, 1fr) minmax(300px, 38%);
    gap: 14px;
    align-items: start;
    padding: 12px 14px;
    border-top: 1px solid var(--border-soft);
    border-left: 3px solid var(--amber);
    background: rgba(210, 153, 34, 0.04);
  }
  .unrec-row:hover { background: var(--bg-hover); }
  .unrec-row.has-note { background: rgba(63, 185, 80, 0.06); border-left-color: var(--green); }
  @media (max-width: 960px) {
    .unrec-row { grid-template-columns: 1fr; }
  }
  .unrec-controls { display: flex; flex-direction: column; gap: 6px; }
  .unrec-cat { width: 100%; }
  .unrec-cat.filled { border-color: var(--green); background: var(--green-bg); }
  .unrec-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .lookup-batch-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 10px 14px;
    background: var(--bg-soft);
    border-top: 1px solid var(--border-soft);
  }
  .match-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 14px;
    background: var(--accent-bg);
    border-top: 1px solid var(--border-soft);
    font-size: 11px;
    color: var(--accent);
  }

  .float-bar {
    position: fixed;
    left: 304px;
    bottom: 16px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 12px;
    display: none;
    gap: 8px;
    align-items: center;
    box-shadow: var(--shadow);
    z-index: 30;
  }
  .float-bar.show { display: flex; }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 20px;
  }
  .modal-backdrop.show { display: flex; }
  .modal {
    width: min(740px, 100%);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .modal textarea { width: 100%; height: 280px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5; }
  .toast {
    position: fixed;
    bottom: 18px;
    right: 20px;
    background: var(--accent);
    color: #fff;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.18s;
    z-index: 60;
    pointer-events: none;
  }
  .toast.show { opacity: 1; }
  .muted { color: var(--text-muted); font-size: 12px; }
</style>
</head>
<body>
  <aside class="sidebar">
    <div class="sb-head">
      <div class="sb-brand">
        <div>
          <div class="sb-title">Rea-FigmaDesign</div>
          <div class="sb-sub" id="sb-sub"></div>
        </div>
        <button class="btn sm" id="btn-theme" title="切換深色／淺色模式">淺色</button>
      </div>
      <div class="sb-nav-actions">
        <button class="btn sm" style="flex:1;justify-content:center" id="btn-home">總覽看板</button>
      </div>
      <div class="seg">
        <button id="seg-cats" data-sb="categories">分類清單</button>
        <button id="seg-fams" data-sb="families">AST 家族歸組</button>
      </div>
      <input class="sb-search" id="sb-filter" placeholder="篩選分類名稱或 AST...">
    </div>
    <div class="sb-scroll" id="sb-list"></div>
    <div class="sb-foot">
      <div class="cat-item" id="btn-lookup-view" style="margin-bottom:4px">
        <span class="cat-name">Figma 選中查找</span>
        <span class="pill amber" id="sb-lookup-badge">0</span>
      </div>
      <div class="cat-item" id="btn-commented-view">
        <span class="cat-name">已填寫意見清單</span>
        <span class="pill green" id="sb-comment-badge">0</span>
      </div>
    </div>
  </aside>

  <div class="workspace">
    <header class="topbar">
      <div class="crumb" id="topbar-title">數據總覽看板</div>
      <span class="muted" id="topbar-sub"></span>
      <span class="pill" id="bridge-pill" title="啟動 npm run start:server 並在 Figma 開啟 Rea-FigmaDesign 插件即可即時聯動">○ 離線模式</span>
      <span class="spacer"></span>
      <button class="btn primary" id="btn-prompt">複製為 Agent 提示詞 (0)</button>
      <button class="btn ghost" id="btn-clear" style="color:var(--red)">清空意見</button>
    </header>
    <main class="content" id="content"></main>
  </div>

  <div class="float-bar" id="float-bar">
    <span class="muted" id="sel-stat">已勾選 0 筆</span>
    <button class="btn sm accent" id="btn-focus-selected">定位選中項到 Figma</button>
    <button class="btn sm ghost" id="btn-copy-ids">複製選中 ID</button>
    <button class="btn sm" id="btn-sel-clear">取消</button>
  </div>

  <div class="modal-backdrop" id="modal">
    <div class="modal">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong>Agent 提示詞預覽（已嘗試複製到剪貼簿，可直接貼回對話）</strong>
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="include-scope" checked> 附帶已核對範圍摘要
        </label>
      </div>
      <textarea id="modal-text" readonly></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn accent" id="modal-copy">再次複製</button>
        <button class="btn" id="modal-close">關閉</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="batch-modal">
    <div class="modal" style="width:min(460px,100%)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong id="batch-title">批量標註</strong>
        <span class="muted" id="batch-count" style="font-size:12px">已選中 0 筆</span>
      </div>
      <textarea id="batch-input" style="height:100px" placeholder="輸入要套用到本頁選中項的標註意見（例：分類應該是 老UI - 交易詳情）"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn" id="batch-cancel">取消</button>
        <button class="btn primary" id="batch-apply">套用標註</button>
      </div>
    </div>
  </div>

  <datalist id="all-cat-options"></datalist>
  <div class="toast" id="toast"></div>

<script>
const DATA = ${payload};
const STORAGE_KEY = 'rea-figma-workbench::' + DATA.db + '::' + DATA.modeLabel;
const THEME_KEY = 'rea-figma-theme';
const MAJOR_ORDER = ['頁面類', '彈窗類', '廢棄', '系統UI', '新UI', '老UI', '未標註'];

let sbMode = DATA.defaultSidebarMode || 'categories';
let viewMode = DATA.autoSelectMode || 'overview'; // 'overview' | 'category' | 'family' | 'subset' | 'commented'
let activeKey = DATA.autoSelectCategory || '';
const expandedMajors = new Set(['頁面類', '彈窗類', '廢棄', '系統UI', '新UI', '老UI', '未標註']);
const expandedOverviewMajors = new Set(['頁面類', '彈窗類', '廢棄', '系統UI']);
const expandedPages = new Set();
const selected = new Set();
let lastClickedId = '';
let detailFilter = { q: '', arch: '', gen: '', onlyCommented: false };
let pendingBatch = null;
let lastLookup = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { categories: {}, families: {}, items: {}, unrecorded: {} };
    const p = JSON.parse(raw);
    return { categories: p.categories || {}, families: p.families || {}, items: p.items || {}, unrecorded: p.unrecorded || {} };
  } catch (e) {
    return { categories: {}, families: {}, items: {}, unrecorded: {} };
  }
}
const state = loadState();
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  updateCommentCounters();
}

(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('btn-theme').textContent = saved === 'dark' ? '淺色' : '深色';
})();

document.getElementById('btn-theme').addEventListener('click', function() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  this.textContent = next === 'dark' ? '淺色' : '深色';
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
  });
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 1800);
}
function copyText(text, msg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function() {
      toast(msg || '已複製');
      return true;
    }).catch(function() { return false; });
  }
  return Promise.resolve(false);
}

// Live Bridge WebSocket client (connects to local server/ws-server.ts on 127.0.0.1:8765)
const BRIDGE_WS_URL = 'ws://127.0.0.1:8765';
let bridgeWs = null;
let bridgeWsOpen = false;
let bridgeStatus = { figma_connected: false, figma_file_name: '', figma_file_key: '' };
let bridgeBusy = false;
let bridgeBusyTimer = null;
let bridgeSeq = 0;

function updateBridgePill() {
  const pill = document.getElementById('bridge-pill');
  if (!pill) return;
  if (!bridgeWsOpen) {
    pill.className = 'pill';
    pill.textContent = '○ 離線模式（可用複製 ID）';
    return;
  }
  if (bridgeStatus.figma_connected) {
    pill.className = 'pill green';
    pill.textContent = '● Figma 已連線' + (bridgeStatus.figma_file_name ? ' · ' + bridgeStatus.figma_file_name : '');
  } else {
    pill.className = 'pill amber';
    pill.textContent = '○ 等待 Figma 插件連線';
  }
}

function connectBridge() {
  try {
    bridgeWs = new WebSocket(BRIDGE_WS_URL);
  } catch (e) {
    bridgeWsOpen = false;
    updateBridgePill();
    setTimeout(connectBridge, 3000);
    return;
  }
  bridgeWs.onopen = function() {
    bridgeWsOpen = true;
    updateBridgePill();
    try {
      bridgeWs.send(JSON.stringify({ type: 'BRIDGE_HELLO', payload: { role: 'review-ui' } }));
    } catch (e) {}
  };
  bridgeWs.onclose = function() {
    bridgeWsOpen = false;
    bridgeStatus.figma_connected = false;
    if (bridgeBusy) {
      bridgeBusy = false;
      if (bridgeBusyTimer) { clearTimeout(bridgeBusyTimer); bridgeBusyTimer = null; }
    }
    updateBridgePill();
    setTimeout(connectBridge, 3000);
  };
  bridgeWs.onerror = function() {
    bridgeWsOpen = false;
    updateBridgePill();
  };
  bridgeWs.onmessage = function(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'BRIDGE_STATUS' && msg.payload) {
      bridgeStatus = msg.payload;
      updateBridgePill();
      return;
    }
    if (msg.type === 'BRIDGE_FOCUS_RESULT' && msg.payload) {
      bridgeBusy = false;
      if (bridgeBusyTimer) { clearTimeout(bridgeBusyTimer); bridgeBusyTimer = null; }
      const r = msg.payload;
      if (r.ok) {
        if (r.page_only) {
          toast('已跳轉到頁面「' + (r.page_name || '') + '」');
        } else {
          const missNote = r.missing_ids && r.missing_ids.length ? '（另有 ' + r.missing_ids.length + ' 筆在目前檔案找不到）' : '';
          toast('已定位到「' + (r.page_name || '') + '」· 選中 ' + (r.selected_count || 0) + ' 個節點' + missNote);
        }
      } else {
        toast(r.error || 'Figma 定位失敗');
      }
      return;
    }
    if (msg.type === 'BRIDGE_LOOKUP_SELECTION' && msg.payload) {
      const p = msg.payload;
      const items = Array.isArray(p.items) ? p.items : [];
      const matchedByCard = new Map();
      const unrecordedList = [];
      items.forEach(function(it) {
        if (!it || !it.id) return;
        let card = byMemberId[it.id] || null;
        let matchVia = '';
        if (card) {
          matchVia = it.id === card.id ? 'exact' : 'copy';
        } else if (Array.isArray(it.ancestor_ids)) {
          for (let i = 0; i < it.ancestor_ids.length; i += 1) {
            const hit = byMemberId[it.ancestor_ids[i]];
            if (hit) {
              card = hit;
              matchVia = 'ancestor';
              break;
            }
          }
        }
        if (card) {
          if (!matchedByCard.has(card.id)) {
            matchedByCard.set(card.id, {
              card: card,
              matchVia: matchVia,
              matchedSelectedIds: [it.id],
              selectedName: it.name || ''
            });
          } else {
            const entry = matchedByCard.get(card.id);
            if (entry.matchedSelectedIds.indexOf(it.id) === -1) entry.matchedSelectedIds.push(it.id);
          }
        } else {
          const prev = state.unrecorded[it.id] || {};
          const rec = {
            id: it.id,
            name: it.name || prev.name || '(未命名)',
            type: it.type || prev.type || '',
            pageId: it.page_id || prev.pageId || p.page_id || '',
            pageName: it.page_name || prev.pageName || p.page_name || '',
            width: typeof it.width === 'number' ? it.width : prev.width,
            height: typeof it.height === 'number' ? it.height : prev.height,
            textPreview: it.text_preview || prev.textPreview || '',
            category: prev.category || '',
            note: prev.note || '',
            updatedAt: new Date().toISOString()
          };
          state.unrecorded[it.id] = rec;
          unrecordedList.push(rec);
        }
      });
      if (unrecordedList.length > 0) saveState();
      const matchedList = Array.from(matchedByCard.values());
      lastLookup = {
        pageId: p.page_id || '',
        pageName: p.page_name || '',
        receivedAt: new Date().toISOString(),
        total: items.length,
        matched: matchedList,
        unrecorded: unrecordedList
      };
      try {
        if (bridgeWs && bridgeWs.readyState === 1) {
          bridgeWs.send(JSON.stringify({
            type: 'BRIDGE_LOOKUP_RESULT',
            payload: {
              request_id: p.request_id,
              ok: true,
              total: items.length,
              matched_count: matchedList.length,
              unrecorded_count: unrecordedList.length
            }
          }));
        }
      } catch (e) {}
      viewMode = 'figma-lookup';
      renderAll();
      window.scrollTo(0, 0);
      toast('收到 Figma 選中項（' + items.length + ' 筆）：已收錄 ' + matchedList.length + ' · 未收錄 ' + unrecordedList.length);
    }
  };
}

function requestFigmaFocus(nodeIds, label, opts) {
  const o = opts || {};
  const pageOnly = o.pageOnly === true;
  if ((!nodeIds || nodeIds.length === 0) && !(pageOnly && (o.pageId || label))) {
    toast('沒有可定位的 node_id');
    return;
  }
  if (!bridgeWsOpen || !bridgeWs || bridgeWs.readyState !== 1 || !bridgeStatus.figma_connected) {
    toast('Figma 尚未連線：請先啟動 npm run start:server 並開啟 Figma 插件（或改用複製 ID）');
    return;
  }
  if (bridgeBusy) {
    toast('上一次定位仍在執行，請稍候');
    return;
  }
  const reqId = 'focus-' + Date.now() + '-' + (++bridgeSeq);
  bridgeBusy = true;
  if (bridgeBusyTimer) clearTimeout(bridgeBusyTimer);
  bridgeBusyTimer = setTimeout(function() {
    bridgeBusy = false;
    bridgeBusyTimer = null;
  }, 15000);
  toast((pageOnly ? '正在跳轉到頁面「' : '正在定位「') + (label || nodeIds[0]) + '」…');
  bridgeWs.send(JSON.stringify({
    type: 'BRIDGE_FOCUS_NODES',
    payload: {
      request_id: reqId,
      node_ids: nodeIds || [],
      page_id: o.pageId || undefined,
      page_name: label || undefined,
      page_only: pageOnly ? true : undefined
    }
  }));
}

const byId = {};
const byMemberId = {};
DATA.cards.forEach(function(c) {
  byId[c.id] = c;
  byMemberId[c.id] = c;
  (c.memberIds || []).forEach(function(mid) { byMemberId[mid] = c; });
});

// Aggregate Categories and AST Families
const catMap = new Map();
const majorAgg = new Map();
const famMap = new Map();

DATA.cards.forEach(function(c) {
  const maj = c.major || '未標註';
  const min = c.major ? (c.minor || '(只到大類)') : 'AST 待歸類';
  const key = maj + '::' + min;

  if (!catMap.has(key)) {
    catMap.set(key, {
      key: key,
      major: maj,
      minor: min,
      cards: [],
      totalScreens: 0,
      pages: new Set(),
      paletteCount: new Map()
    });
  }
  const rec = catMap.get(key);
  rec.cards.push(c);
  rec.totalScreens += c.copies;
  c.memberPages.forEach(function(p) { if (p) rec.pages.add(p); });
  (c.palette || []).forEach(function(hx) { rec.paletteCount.set(hx, (rec.paletteCount.get(hx) || 0) + 1); });

  if (!majorAgg.has(maj)) majorAgg.set(maj, { major: maj, unique: 0, screens: 0, minors: new Map() });
  const mRec = majorAgg.get(maj);
  mRec.unique += 1;
  mRec.screens += c.copies;
  mRec.minors.set(key, rec);

  if (!famMap.has(c.hash)) {
    famMap.set(c.hash, {
      hash: c.hash,
      shortHash: c.shortHash,
      cards: [],
      totalScreens: 0,
      pages: new Set(),
      paletteCount: new Map()
    });
  }
  const fRec = famMap.get(c.hash);
  fRec.cards.push(c);
  fRec.totalScreens += c.copies;
  c.memberPages.forEach(function(p) { if (p) fRec.pages.add(p); });
  (c.palette || []).forEach(function(hx) { fRec.paletteCount.set(hx, (fRec.paletteCount.get(hx) || 0) + 1); });
});

function topPalette(palMap, n) {
  return Array.from(palMap.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, n).map(function(x) { return x[0]; });
}

const sortedMajors = Array.from(majorAgg.values()).sort(function(a, b) {
  const ia = MAJOR_ORDER.indexOf(a.major);
  const ib = MAJOR_ORDER.indexOf(b.major);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return b.screens - a.screens;
});

const sortedFamilies = Array.from(famMap.values()).sort(function(a, b) {
  return b.totalScreens - a.totalScreens;
});

document.getElementById('sb-sub').textContent = (DATA.fileName || 'Figma AST') + ' · ' + DATA.modeLabel;

(function populateCatDatalist() {
  const dl = document.getElementById('all-cat-options');
  if (!dl) return;
  const opts = [];
  Array.from(catMap.values()).forEach(function(r) {
    if (r.major === '未標註') return;
    const label = r.major + (r.minor && r.minor !== '(只到大類)' ? ' / ' + r.minor : '');
    if (opts.indexOf(label) === -1) opts.push(label);
  });
  dl.innerHTML = opts.map(function(o) { return '<option value="' + esc(o) + '"></option>'; }).join('');
})();

function countCommentsInCards(cards) {
  let n = 0;
  cards.forEach(function(c) { if ((state.items[c.id] || '').trim()) n += 1; });
  return n;
}

function activeUnrecordedIds() {
  return Object.keys(state.unrecorded || {}).filter(function(id) {
    const u = state.unrecorded[id];
    return u && ((u.category || '').trim() || (u.note || '').trim());
  });
}

function totalCommentCount() {
  const c1 = Object.keys(state.categories).filter(function(k) { return (state.categories[k] || '').trim(); }).length;
  const c2 = Object.keys(state.families).filter(function(k) { return (state.families[k] || '').trim(); }).length;
  const c3 = Object.keys(state.items).filter(function(k) { return (state.items[k] || '').trim(); }).length;
  const c4 = activeUnrecordedIds().length;
  return c1 + c2 + c3 + c4;
}

function updateLookupBadge() {
  const el = document.getElementById('sb-lookup-badge');
  if (!el) return;
  const cnt = lastLookup ? lastLookup.total : activeUnrecordedIds().length;
  el.textContent = String(cnt);
}

function updateCommentCounters() {
  const total = totalCommentCount();
  document.getElementById('btn-prompt').textContent = '複製為 Agent 提示詞 (' + total + ')';
  document.getElementById('sb-comment-badge').textContent = String(total);
  updateLookupBadge();
}

function updateFloatBar() {
  const bar = document.getElementById('float-bar');
  document.getElementById('sel-stat').textContent = '已勾選 ' + selected.size + ' 筆';
  bar.classList.toggle('show', selected.size > 0);
}

function swatchesHtml(palette) {
  if (!palette || !palette.length) return '';
  return '<div class="palette-strip">' + palette.map(function(hx) {
    return '<span class="sw" style="background:' + esc(hx) + '" title="' + esc(hx) + '"></span>';
  }).join('') + '</div>';
}

function renderSidebar() {
  document.getElementById('seg-cats').classList.toggle('active', sbMode === 'categories');
  document.getElementById('seg-fams').classList.toggle('active', sbMode === 'families');
  document.getElementById('btn-lookup-view').classList.toggle('active', viewMode === 'figma-lookup');
  document.getElementById('btn-commented-view').classList.toggle('active', viewMode === 'commented');

  const q = document.getElementById('sb-filter').value.trim().toLowerCase();
  const container = document.getElementById('sb-list');

  if (sbMode === 'categories') {
    let html = '';
    sortedMajors.forEach(function(mRec) {
      const minors = Array.from(mRec.minors.values()).sort(function(a, b) { return b.totalScreens - a.totalScreens; });
      const filteredMinors = q ? minors.filter(function(r) {
        return (r.major + ' ' + r.minor).toLowerCase().indexOf(q) !== -1;
      }) : minors;
      if (q && filteredMinors.length === 0) return;

      const isOpen = q ? true : expandedMajors.has(mRec.major);
      html += '<div class="major-group">' +
        '<div class="major-hdr" data-toggle-major="' + esc(mRec.major) + '">' +
        '<span>' + (isOpen ? '▾ ' : '▸ ') + esc(mRec.major) + '</span>' +
        '<span>' + mRec.screens + '</span>' +
        '</div>';
      if (isOpen) {
        filteredMinors.forEach(function(r) {
          const noteCnt = ((state.categories[r.key] || '').trim() ? 1 : 0) + countCommentsInCards(r.cards);
          const isAct = viewMode === 'category' && activeKey === r.key;
          html += '<div class="cat-item' + (isAct ? ' active' : '') + '" data-open-cat="' + esc(r.key) + '" title="' + esc(r.major + ' / ' + r.minor) + '">' +
            '<span class="cat-name">' + esc(r.minor) + '</span>' +
            '<span class="cat-meta">' +
            (noteCnt > 0 ? '<span class="pill green">✎' + noteCnt + '</span>' : '') +
            '<span class="pill">' + r.totalScreens + '</span>' +
            '</span></div>';
        });
      }
      html += '</div>';
    });
    container.innerHTML = html || '<div class="muted" style="padding:10px">找不到符合的分類</div>';
    return;
  }

  // AST families mode
  const filteredFams = q ? sortedFamilies.filter(function(f) {
    const rep = f.cards[0];
    return (f.shortHash + ' ' + rep.name + ' ' + rep.headline).toLowerCase().indexOf(q) !== -1;
  }) : sortedFamilies;

  let html = '';
  filteredFams.slice(0, 200).forEach(function(f) {
    const rep = f.cards[0];
    const noteCnt = ((state.families[f.hash] || '').trim() ? 1 : 0) + countCommentsInCards(f.cards);
    const isAct = viewMode === 'family' && activeKey === f.hash;
    const label = rep.headline || rep.name || ('#' + f.shortHash);
    html += '<div class="cat-item' + (isAct ? ' active' : '') + '" data-open-fam="' + esc(f.hash) + '">' +
      '<span class="cat-name">#' + esc(f.shortHash) + ' · ' + esc(label) + '</span>' +
      '<span class="cat-meta">' +
      (noteCnt > 0 ? '<span class="pill green">✎' + noteCnt + '</span>' : '') +
      '<span class="pill">' + f.totalScreens + '</span>' +
      '</span></div>';
  });
  if (filteredFams.length > 200) {
    html += '<div class="muted" style="padding:8px">僅顯示前 200 組 AST 家族（共 ' + filteredFams.length + ' 組），請用搜尋縮小範圍</div>';
  }
  container.innerHTML = html || '<div class="muted" style="padding:10px">沒有 AST 家族</div>';
}

function renderOverview() {
  document.getElementById('topbar-title').textContent = '數據總覽看板';
  document.getElementById('topbar-sub').textContent = DATA.modeLabel;

  const pct = DATA.uniqueCount > 0 ? Math.round((100 * DATA.labeledUniqueCount) / DATA.uniqueCount) : 0;
  const minorTotal = Array.from(catMap.values()).filter(function(c) { return c.major !== '未標註'; }).length;
  const commentTotal = totalCommentCount();
  const maxMajorScreens = sortedMajors.length ? Math.max.apply(null, sortedMajors.map(function(m) { return m.screens; })) : 1;

  let html = '<div class="hint-bar">' +
    (DATA.isColdStart
      ? '目前為 <strong>純 AST 冷啟動視圖</strong>：機器已依結構自動分出 ' + DATA.familyCount + ' 組家族。點擊下方任一家族或左側清單開始歸類；<strong>沒問題直接留空</strong>，有意見請直接描述並複製為 Agent 提示詞。'
      : '點選任一分類卡片進入詳情頁檢視（已按 Figma 頁面分組）；<strong>沒問題的畫面直接留空</strong>，只需針對有偏差的地方寫意見，完成後點擊右上角「複製為 Agent 提示詞」。') +
    '</div>';

  html += '<div class="kpi-grid">' +
    '<div class="kpi-card"><div class="kpi-label">畫面總數</div><div class="kpi-val">' + DATA.matchedScreens.toLocaleString() + '</div><div class="kpi-sub">AST 去重後 ' + DATA.uniqueCount.toLocaleString() + ' 組 · ' + DATA.familyCount + ' 個結構家族</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">分類覆蓋</div><div class="kpi-val">' + sortedMajors.filter(function(m) { return m.major !== '未標註'; }).length + ' 大類</div><div class="kpi-sub">細分 ' + minorTotal + ' 個子分類</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">人工標註進度</div><div class="kpi-val">' + pct + '%</div><div class="kpi-sub">已標 ' + DATA.labeledUniqueCount + ' / 未標 ' + DATA.unlabeledUniqueCount + '（去重）</div><div class="prog-track"><div class="prog-fill" style="width:' + pct + '%"></div></div></div>' +
    '<div class="kpi-card clickable" id="kpi-comments"><div class="kpi-label">本次已填寫意見</div><div class="kpi-val" style="color:var(--green)">' + commentTotal + '</div><div class="kpi-sub">點擊檢視已填寫清單</div></div>' +
    '</div>';

  // Distribution bars
  if (!DATA.isColdStart && sortedMajors.length > 0) {
    html += '<div class="panel"><div class="panel-title"><span>大類分佈概覽</span><span class="muted">點擊任一大類跳至對應分類卡片</span></div>';
    sortedMajors.forEach(function(m) {
      const w = Math.max(2, Math.round((100 * m.screens) / Math.max(1, maxMajorScreens)));
      const share = DATA.matchedScreens > 0 ? ((100 * m.screens) / DATA.matchedScreens).toFixed(1) : '0.0';
      html += '<div class="dist-row" data-jump-major="' + esc(m.major) + '">' +
        '<strong>' + esc(m.major) + '</strong>' +
        '<div class="dist-bar-wrap"><div class="dist-bar" style="width:' + w + '%"></div></div>' +
        '<div class="dist-num">' + m.screens + ' (' + share + '%)</div>' +
        '</div>';
    });
    html += '</div>';
  }

  // Category Cards by Major (or Top AST families if cold-start)
  if (DATA.isColdStart) {
    html += '<div class="section-hdr"><h3>Top AST 相似家族（依畫面數量排序，前 60 組）</h3><span class="muted">點擊進入逐頁檢視與打標</span></div><div class="card-grid">';
    sortedFamilies.slice(0, 60).forEach(function(f) {
      const rep = f.cards[0];
      const pal = topPalette(f.paletteCount, 5);
      const noteCnt = ((state.families[f.hash] || '').trim() ? 1 : 0) + countCommentsInCards(f.cards);
      html += '<div class="cat-card' + (noteCnt > 0 ? ' has-note' : '') + '" data-open-fam="' + esc(f.hash) + '">' +
        '<div class="cat-card-top"><div class="cat-card-title">#' + esc(f.shortHash) + ' · ' + esc(rep.headline || rep.name) + '</div>' +
        (noteCnt > 0 ? '<span class="pill green">✎' + noteCnt + '</span>' : '') + '</div>' +
        '<div class="cat-card-stat">' + f.totalScreens + ' 畫面 · ' + f.pages.size + ' 個頁面</div>' +
        swatchesHtml(pal) +
        '</div>';
    });
    html += '</div>';
  } else {
    sortedMajors.forEach(function(m) {
      const minors = Array.from(m.minors.values()).sort(function(a, b) { return b.totalScreens - a.totalScreens; });
      const isOpen = expandedOverviewMajors.has(m.major);
      html += '<div id="sec-major-' + esc(m.major) + '" class="section-hdr" data-ov-major="' + esc(m.major) + '">' +
        '<h3>' + (isOpen ? '▾ ' : '▸ ') + esc(m.major) + ' <span class="pill">' + minors.length + ' 類 · ' + m.screens + ' 畫面</span></h3>' +
        '<span class="muted">' + (isOpen ? '點擊收合' : '點擊展開分類卡片') + '</span></div>';
      if (isOpen) {
        html += '<div class="card-grid">';
        minors.forEach(function(r) {
          const pal = topPalette(r.paletteCount, 5);
          const noteCnt = ((state.categories[r.key] || '').trim() ? 1 : 0) + countCommentsInCards(r.cards);
          html += '<div class="cat-card' + (noteCnt > 0 ? ' has-note' : '') + '" data-open-cat="' + esc(r.key) + '">' +
            '<div class="cat-card-top"><div class="cat-card-title">' + esc(r.minor) + '</div>' +
            (noteCnt > 0 ? '<span class="pill green">✎' + noteCnt + '</span>' : '') + '</div>' +
            '<div class="cat-card-stat">' + r.totalScreens + ' 畫面（去重 ' + r.cards.length + '） · ' + r.pages.size + ' 頁</div>' +
            swatchesHtml(pal) +
            '</div>';
        });
        html += '</div>';
      }
    });
  }

  document.getElementById('content').innerHTML = html;
}

function buildFigmaScript(cards) {
  const groups = {};
  cards.forEach(function(c) {
    const pid = c.pageId || '?';
    if (!groups[pid]) groups[pid] = [];
    groups[pid].push(c.id);
  });
  const NL = String.fromCharCode(10);
  return '(async () => {' + NL +
    '  const groups = ' + JSON.stringify(groups) + ';' + NL +
    '  for (const pid of Object.keys(groups)) {' + NL +
    '    const page = await figma.getNodeByIdAsync(pid);' + NL +
    '    if (!page) continue;' + NL +
    '    await figma.setCurrentPageAsync(page);' + NL +
    '    const nodes = [];' + NL +
    '    for (const id of groups[pid]) { const n = await figma.getNodeByIdAsync(id); if (n) nodes.push(n); }' + NL +
    '    figma.currentPage.selection = nodes;' + NL +
    '    figma.viewport.scrollAndZoomIntoView(nodes);' + NL +
    '  }' + NL +
    '})();';
}

function renderScreenRow(c) {
  const comment = state.items[c.id] || '';
  const isSel = selected.has(c.id);
  const cls = ['screen-row', comment.trim() ? 'has-note' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
  const archCls = c.archetype === 'overlay' ? 'purple' : (c.archetype === 'overlay-panel' ? 'accent' : '');
  const genCls = c.generation === 'new' ? 'green' : (c.generation === 'old' ? 'red' : '');

  return '<div class="' + cls + '" data-id="' + esc(c.id) + '">' +
    '<div style="padding-top:3px"><input type="checkbox" class="row-chk" data-id="' + esc(c.id) + '"' + (isSel ? ' checked' : '') + '></div>' +
    '<div>' +
    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="id-link" data-copy="' + esc(c.id) + '" title="點擊複製 node_id">' + esc(c.id) + '</span><button class="btn sm focus-node-btn" data-focus-id="' + esc(c.id) + '" title="在 Figma 中切換頁面並聚焦到此畫面">定位</button></div>' +
    '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">' +
    '<span class="pill ' + archCls + '">' + esc(c.archetype) + '</span>' +
    (c.generation ? '<span class="pill ' + genCls + '">' + esc(c.generation) + '</span>' : '') +
    (c.copies > 1 ? '<span class="pill amber" title="' + esc(c.memberIds.join(', ')) + '">×' + c.copies + '</span>' : '') +
    '</div>' +
    '<div style="margin-top:6px">' + swatchesHtml(c.palette) + '</div>' +
    '</div>' +
    '<div>' +
    '<div class="layer-name">' + esc(c.name || '(無名)') + '</div>' +
    '<div class="headline-txt" title="' + esc(c.headline) + '">' + esc(c.headline || '(無文案)') + '</div>' +
    (c.major ? '<div class="muted" style="margin-top:4px">' + esc(c.major + (c.minor ? ' / ' + c.minor : '')) + ' · #' + esc(c.shortHash) + '</div>' : '<div class="muted" style="margin-top:4px">AST #' + esc(c.shortHash) + '</div>') +
    '</div>' +
    '<div>' +
    '<textarea class="comment item-comment' + (comment.trim() ? ' filled' : '') + '" data-id="' + esc(c.id) + '" placeholder="沒問題留空；有問題請描述（如：應歸入交易詳情 / 老UI / 廢棄）">' + esc(comment) + '</textarea>' +
    '</div>' +
    '</div>';
}

function renderDetailView(opts) {
  const title = opts.title;
  const sub = opts.sub;
  const cards = opts.cards;
  const groupKind = opts.groupKind; // 'category' | 'family' | 'subset'
  const groupKey = opts.groupKey;
  const pal = opts.palette;

  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>' + esc(title) + '</span>';
  document.getElementById('topbar-sub').textContent = sub;

  let html = '<div class="detail-hero">' +
    '<div class="detail-hero-row">' +
    '<div><div class="detail-title">' + esc(title) + '</div><div class="muted" style="margin-top:2px">' + esc(sub) + '</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    swatchesHtml(pal) +
    '<button class="btn sm ghost" id="btn-copy-group-ids">複製全部 ID (' + cards.length + ')</button>' +
    '</div></div>';

  if (groupKind === 'category' || groupKind === 'family') {
    const val = groupKind === 'category' ? (state.categories[groupKey] || '') : (state.families[groupKey] || '');
    const ph = groupKind === 'category'
      ? '對整個「' + title + '」分類有整體意見請寫這裡（沒問題留空；例如：這個分類底下有混入彈窗，請拆出）'
      : '對整個 AST 家族 #' + groupKey.slice(0, 8) + ' 有整體歸類意見請寫這裡（沒問題留空；例如：整組歸為 頁面類 / 收銀台）';
    html += '<textarea class="cat-note-box' + (val.trim() ? ' filled' : '') + '" id="group-comment-box" data-kind="' + groupKind + '" data-key="' + esc(groupKey) + '" placeholder="' + esc(ph) + '">' + esc(val) + '</textarea>';
  }
  html += '</div>';

  // Lightweight detail filters
  html += '<div class="filter-strip">' +
    '<input id="dt-q" style="width:230px" value="' + esc(detailFilter.q) + '" placeholder="搜尋頁面 / 圖層 / 文案 / ID">' +
    '<select id="dt-arch"><option value="">全部原型</option><option value="page"' + (detailFilter.arch === 'page' ? ' selected' : '') + '>page</option><option value="overlay-panel"' + (detailFilter.arch === 'overlay-panel' ? ' selected' : '') + '>overlay-panel</option><option value="overlay"' + (detailFilter.arch === 'overlay' ? ' selected' : '') + '>overlay</option></select>' +
    '<select id="dt-gen"><option value="">全部世代</option><option value="new"' + (detailFilter.gen === 'new' ? ' selected' : '') + '>new</option><option value="old"' + (detailFilter.gen === 'old' ? ' selected' : '') + '>old</option></select>' +
    '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" id="dt-only-comment"' + (detailFilter.onlyCommented ? ' checked' : '') + '> 只看已填意見</label>' +
    '<span class="spacer"></span>' +
    '<button class="btn sm" id="btn-expand-pages">展開全部頁面</button>' +
    '<button class="btn sm" id="btn-collapse-pages">收合全部頁面</button>' +
    '</div>';

  const filtered = cards.filter(function(c) {
    if (detailFilter.arch && c.archetype !== detailFilter.arch) return false;
    if (detailFilter.gen && c.generation !== detailFilter.gen) return false;
    if (detailFilter.onlyCommented && !(state.items[c.id] || '').trim()) return false;
    if (detailFilter.q) {
      const hay = (c.id + ' ' + c.page + ' ' + c.name + ' ' + c.headline + ' ' + c.shortHash).toLowerCase();
      if (hay.indexOf(detailFilter.q.toLowerCase()) === -1) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    html += '<div class="panel"><div class="muted">目前篩選條件下沒有畫面。</div></div>';
    document.getElementById('content').innerHTML = html;
    return;
  }

  // Group by Figma Page
  const byPage = new Map();
  filtered.forEach(function(c) {
    const pg = c.page || '(未知頁面)';
    if (!byPage.has(pg)) byPage.set(pg, []);
    byPage.get(pg).push(c);
  });
  const sortedPages = Array.from(byPage.entries()).sort(function(a, b) { return b[1].length - a[1].length; });

  // Auto-expand first 3 pages on fresh view
  const scopePrefix = groupKind + ':' + groupKey + ':';
  const anyExplicit = sortedPages.some(function(e) { return expandedPages.has(scopePrefix + e[0]) || expandedPages.has('COLLAPSED::' + scopePrefix + e[0]); });
  if (!anyExplicit) {
    sortedPages.slice(0, 3).forEach(function(e) { expandedPages.add(scopePrefix + e[0]); });
  }

  sortedPages.forEach(function(entry) {
    const pg = entry[0];
    const list = entry[1];
    const pKey = scopePrefix + pg;
    const isOpen = detailFilter.q || detailFilter.onlyCommented ? true : expandedPages.has(pKey);
    const totalInPage = list.reduce(function(s, x) { return s + x.copies; }, 0);
    const noteCnt = countCommentsInCards(list);

    html += '<div class="page-group">' +
      '<div class="page-group-hdr" data-toggle-page="' + esc(pKey) + '">' +
      '<div class="page-group-title"><span>' + (isOpen ? '▾' : '▸') + '</span><span>' + esc(pg) + '</span>' +
      '<span class="pill">' + list.length + ' 組 / ' + totalInPage + ' 畫面</span>' +
      (noteCnt > 0 ? '<span class="pill green">✎ ' + noteCnt + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button class="btn sm batch-label-page" data-page-key="' + esc(pg) + '">批量標註</button>' +
      '<button class="btn sm accent focus-page-figma" data-page-key="' + esc(pg) + '" title="僅切換 Figma 到此頁面（不一次全選全部節點）">定位到 Figma</button>' +
      '<button class="btn sm select-page-all" data-page-key="' + esc(pg) + '">全選</button>' +
      '<button class="btn sm select-page-none" data-page-key="' + esc(pg) + '">取消全選</button>' +
      '<button class="btn sm ghost copy-page-ids" data-page-key="' + esc(pg) + '">複製 ID</button>' +
      '</div></div>';

    html += '<div class="page-group-body' + (isOpen ? '' : ' hidden') + '">';
    if (isOpen) {
      list.forEach(function(c) { html += renderScreenRow(c); });
    }
    html += '</div></div>';
  });

  document.getElementById('content').innerHTML = html;
  window.__currentGroupCards = filtered;
  window.__currentByPage = byPage;
  window.__currentScopePrefix = scopePrefix;
}

function renderUnrecordedRow(it) {
  const u = (state.unrecorded && state.unrecorded[it.id]) || it;
  const catVal = u.category || '';
  const noteVal = u.note || '';
  const hasNote = Boolean(catVal.trim() || noteVal.trim());
  const dims = (typeof u.width === 'number' && typeof u.height === 'number') ? (u.width + '×' + u.height) : '';
  return '<div class="unrec-row' + (hasNote ? ' has-note' : '') + '" data-unrec-row="' + esc(u.id) + '">' +
    '<div>' +
    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
    '<span class="id-link" data-copy="' + esc(u.id) + '" title="點擊複製 node_id">' + esc(u.id) + '</span>' +
    '<button class="btn sm focus-node-btn" data-focus-id="' + esc(u.id) + '" data-focus-page="' + esc(u.pageName || '') + '" title="在 Figma 中切換頁面並聚焦到此節點">定位</button>' +
    '</div>' +
    '<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">' +
    '<span class="pill amber">未收錄 · 新</span>' +
    (u.type ? '<span class="pill">' + esc(u.type) + '</span>' : '') +
    (dims ? '<span class="pill">' + esc(dims) + '</span>' : '') +
    '</div>' +
    '</div>' +
    '<div>' +
    '<div class="layer-name">' + esc(u.name || '(未命名)') + '</div>' +
    '<div class="headline-txt" title="' + esc(u.textPreview || '') + '">' + esc(u.textPreview || '(無文案預覽)') + '</div>' +
    '<div class="muted" style="margin-top:4px">Figma 頁面：' + esc(u.pageName || '-') + '</div>' +
    '</div>' +
    '<div class="unrec-controls">' +
    '<input class="unrec-cat' + (catVal.trim() ? ' filled' : '') + '" list="all-cat-options" data-unrec-id="' + esc(u.id) + '" value="' + esc(catVal) + '" placeholder="人工填寫／選擇分類（例：頁面類 / 交易詳情，留空交由 Agent 判斷）">' +
    '<textarea class="comment unrec-note' + (noteVal.trim() ? ' filled' : '') + '" data-unrec-id="' + esc(u.id) + '" placeholder="備註說明，或直接留給 Agent 歸類意見...">' + esc(noteVal) + '</textarea>' +
    '<div class="unrec-actions">' +
    '<button class="btn sm unrec-ask-agent" data-unrec-id="' + esc(u.id) + '">交給 Agent 分類</button>' +
    '<button class="btn sm ghost unrec-clear" data-unrec-id="' + esc(u.id) + '">清除</button>' +
    '</div>' +
    '</div>' +
    '</div>';
}

function renderLookupView() {
  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>Figma 選中查找</span>';
  document.getElementById('topbar-sub').textContent = lastLookup ? ('來自「' + (lastLookup.pageName || 'Figma') + '」· 共 ' + lastLookup.total + ' 筆') : '在 Figma 中選中單個或多個設計稿後，於插件點擊「查找選中項 → 複審台」';

  if (!lastLookup) {
    window.__currentGroupCards = [];
    window.__currentByPage = new Map();
    document.getElementById('content').innerHTML = '<div class="panel">' +
      '<div class="panel-title"><span>等待接收 Figma 選中項</span></div>' +
      '<div class="muted" style="line-height:1.8">1. 確認已啟動 <code>npm run start:server</code> 並在 Figma Desktop 開啟「Rea-FigmaDesign AST 探針」插件。<br>2. 在 Figma 畫布中單選或多選設計稿節點。<br>3. 點擊插件內的 <strong>「查找選中項 → 複審台」</strong> 按鈕，工作台會自動區分「已收錄」與「未收錄（新畫面）」。</div>' +
      '</div>';
    return;
  }

  const matched = lastLookup.matched || [];
  const unrecorded = lastLookup.unrecorded || [];
  const matchedCards = matched.map(function(m) { return m.card; });
  const pgKey = lastLookup.pageName || '查找結果';
  window.__currentGroupCards = matchedCards;
  window.__currentByPage = matchedCards.length > 0 ? new Map([[pgKey, matchedCards]]) : new Map();

  let html = '<div class="detail-hero">' +
    '<div class="detail-hero-row">' +
    '<div><div class="detail-title">Figma 畫布選中查找 · ' + esc(pgKey) + '</div>' +
    '<div class="muted" style="margin-top:2px">本次選中 ' + lastLookup.total + ' 個節點 · 已收錄 ' + matched.length + ' 組 · 未收錄（新畫面）' + unrecorded.length + ' 筆</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<span class="pill green">已收錄 ' + matched.length + ' 筆</span>' +
    '<span class="pill amber">未收錄（新） ' + unrecorded.length + ' 筆</span>' +
    '</div></div></div>';

  if (unrecorded.length > 0) {
    html += '<div class="panel" style="padding:0;overflow:hidden">' +
      '<div class="panel-title" style="padding:14px 16px 10px;margin:0;flex-wrap:wrap;gap:8px">' +
      '<span>一、未收錄新畫面 <span class="pill amber">' + unrecorded.length + '</span></span>' +
      '<button class="btn sm" id="btn-unrec-all-agent">全部交給 Agent 分類</button>' +
      '</div>';
    if (unrecorded.length > 1) {
      html += '<div class="lookup-batch-bar">' +
        '<input id="unrec-batch-cat" list="all-cat-options" style="min-width:210px;flex:1" placeholder="批量指定分類（選填，例：頁面類 / 交易詳情）">' +
        '<input id="unrec-batch-note" style="min-width:220px;flex:1" placeholder="批量備註給 Agent（選填）">' +
        '<button class="btn sm accent" id="btn-unrec-batch-apply">套用到本批未收錄 (' + unrecorded.length + ')</button>' +
        '</div>';
    }
    unrecorded.forEach(function(it) { html += renderUnrecordedRow(it); });
    html += '</div>';
  }

  if (matched.length > 0) {
    const first = matchedCards[0];
    html += '<div class="page-group">' +
      '<div class="page-group-hdr">' +
      '<div class="page-group-title"><span>▾</span><span>二、已收錄畫面 · ' + esc(pgKey) + '</span><span class="pill green">' + matched.length + ' 組</span></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button class="btn sm batch-label-page" data-page-key="' + esc(pgKey) + '">批量標註</button>' +
      '<button class="btn sm accent focus-page-figma" data-page-key="' + esc(pgKey) + '" data-page-id="' + esc(lastLookup.pageId || (first ? first.pageId : '')) + '" title="僅切換 Figma 到此頁面（不一次全選全部節點）">定位到 Figma</button>' +
      '<button class="btn sm select-page-all" data-page-key="' + esc(pgKey) + '">全選</button>' +
      '<button class="btn sm select-page-none" data-page-key="' + esc(pgKey) + '">取消全選</button>' +
      '<button class="btn sm ghost copy-page-ids" data-page-key="' + esc(pgKey) + '">複製 ID</button>' +
      '</div></div>' +
      '<div class="page-group-body">';

    matched.forEach(function(m) {
      const c = m.card;
      const catKey = (c.major || '未標註') + '::' + (c.major ? (c.minor || '(只到大類)') : 'AST 待歸類');
      if (m.matchVia !== 'exact' || c.major) {
        const reason = m.matchVia === 'copy'
          ? ('由 Figma 選中 ' + m.matchedSelectedIds.join(', ') + ' 匹配（同構複本 → 代表節點 ' + c.id + '）')
          : (m.matchVia === 'ancestor'
            ? ('由子節點 ' + m.matchedSelectedIds.join(', ') + ' 匹配到所屬畫面 ' + c.id)
            : ('目前收錄分類：' + (c.major ? (c.major + (c.minor ? ' / ' + c.minor : '')) : '未標註')));
        html += '<div class="match-banner">' +
          '<span>' + esc(reason) + '</span>' +
          (catMap.has(catKey) ? '<button class="btn sm" data-open-cat="' + esc(catKey) + '">前往分類</button>' : '') +
          '</div>';
      }
      html += renderScreenRow(c);
    });
    html += '</div></div>';
  }

  document.getElementById('content').innerHTML = html;
}

function renderCommentedView() {
  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>已填寫意見清單</span>';
  document.getElementById('topbar-sub').textContent = '僅列出目前有填寫修改／補充意見的項目';

  const catKeys = Object.keys(state.categories).filter(function(k) { return (state.categories[k] || '').trim(); });
  const famKeys = Object.keys(state.families).filter(function(k) { return (state.families[k] || '').trim(); });
  const itemIds = Object.keys(state.items).filter(function(k) { return (state.items[k] || '').trim() && byId[k]; });
  const unrecIds = activeUnrecordedIds();

  if (catKeys.length === 0 && famKeys.length === 0 && itemIds.length === 0 && unrecIds.length === 0) {
    document.getElementById('content').innerHTML = '<div class="panel"><div class="muted">目前尚未填寫任何意見。請從左側分類、總覽看板或 Figma 選中查找開始填寫。</div></div>';
    return;
  }

  let html = '';
  if (catKeys.length > 0) {
    html += '<div class="panel"><div class="panel-title"><span>一、分類整體意見 (' + catKeys.length + ')</span></div>';
    catKeys.forEach(function(k) {
      const rec = catMap.get(k);
      const label = rec ? (rec.major + ' / ' + rec.minor) : k;
      html += '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong>' + esc(label) + '</strong>' +
        '<button class="btn sm" data-open-cat="' + esc(k) + '">跳至分類</button></div>' +
        '<textarea class="cat-note-box filled" data-kind="category" data-key="' + esc(k) + '">' + esc(state.categories[k]) + '</textarea>' +
        '</div>';
    });
    html += '</div>';
  }

  if (famKeys.length > 0) {
    html += '<div class="panel"><div class="panel-title"><span>二、AST 家族意見 (' + famKeys.length + ')</span></div>';
    famKeys.forEach(function(h) {
      const f = famMap.get(h);
      html += '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong>AST 家族 #' + esc(h.slice(0, 8)) + (f ? '（' + f.totalScreens + ' 畫面）' : '') + '</strong>' +
        '<button class="btn sm" data-open-fam="' + esc(h) + '">跳至家族</button></div>' +
        '<textarea class="cat-note-box filled" data-kind="family" data-key="' + esc(h) + '">' + esc(state.families[h]) + '</textarea>' +
        '</div>';
    });
    html += '</div>';
  }

  if (itemIds.length > 0) {
    html += '<div class="panel" style="padding:0;overflow:hidden"><div class="panel-title" style="padding:14px 16px 6px"><span>三、單筆畫面意見 (' + itemIds.length + ')</span></div>';
    itemIds.forEach(function(id) { html += renderScreenRow(byId[id]); });
    html += '</div>';
  }

  if (unrecIds.length > 0) {
    html += '<div class="panel" style="padding:0;overflow:hidden"><div class="panel-title" style="padding:14px 16px 6px"><span>四、Figma 未收錄新畫面 (' + unrecIds.length + ')</span></div>';
    unrecIds.forEach(function(id) { html += renderUnrecordedRow(state.unrecorded[id]); });
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function renderMain() {
  if (viewMode === 'overview') {
    renderOverview();
  } else if (viewMode === 'category') {
    const rec = catMap.get(activeKey);
    if (!rec) { viewMode = 'overview'; renderOverview(); return; }
    renderDetailView({
      title: rec.major + ' / ' + rec.minor,
      sub: '去重 ' + rec.cards.length + ' 組 · 共 ' + rec.totalScreens + ' 個畫面 · 出現於 ' + rec.pages.size + ' 個 Figma 頁面',
      cards: rec.cards,
      groupKind: 'category',
      groupKey: rec.key,
      palette: topPalette(rec.paletteCount, 6)
    });
  } else if (viewMode === 'family') {
    const f = famMap.get(activeKey);
    if (!f) { viewMode = 'overview'; renderOverview(); return; }
    renderDetailView({
      title: 'AST 家族 #' + f.shortHash,
      sub: '結構完全相同 · 去重 ' + f.cards.length + ' 組 · 共 ' + f.totalScreens + ' 個畫面 · ' + f.pages.size + ' 個頁面',
      cards: f.cards,
      groupKind: 'family',
      groupKey: f.hash,
      palette: topPalette(f.paletteCount, 6)
    });
  } else if (viewMode === 'subset') {
    const pages = new Set();
    const pal = new Map();
    let total = 0;
    DATA.cards.forEach(function(c) {
      total += c.copies;
      c.memberPages.forEach(function(p) { pages.add(p); });
      (c.palette || []).forEach(function(hx) { pal.set(hx, (pal.get(hx) || 0) + 1); });
    });
    renderDetailView({
      title: DATA.modeLabel,
      sub: '去重 ' + DATA.cards.length + ' 組 · 共 ' + total + ' 個畫面 · ' + pages.size + ' 個 Figma 頁面',
      cards: DATA.cards,
      groupKind: 'subset',
      groupKey: 'subset',
      palette: topPalette(pal, 6)
    });
  } else if (viewMode === 'figma-lookup') {
    renderLookupView();
  } else if (viewMode === 'commented') {
    renderCommentedView();
  }
}

function renderAll() {
  renderSidebar();
  renderMain();
  updateCommentCounters();
  updateFloatBar();
}

function openCategory(key) {
  viewMode = 'category';
  activeKey = key;
  detailFilter = { q: '', arch: '', gen: '', onlyCommented: false };
  renderAll();
  window.scrollTo(0, 0);
}

function openFamily(hash) {
  viewMode = 'family';
  activeKey = hash;
  detailFilter = { q: '', arch: '', gen: '', onlyCommented: false };
  renderAll();
  window.scrollTo(0, 0);
}

// Sidebar events
document.getElementById('btn-home').addEventListener('click', function() {
  viewMode = 'overview';
  activeKey = '';
  renderAll();
  window.scrollTo(0, 0);
});
document.getElementById('seg-cats').addEventListener('click', function() { sbMode = 'categories'; renderSidebar(); });
document.getElementById('seg-fams').addEventListener('click', function() { sbMode = 'families'; renderSidebar(); });
document.getElementById('sb-filter').addEventListener('input', renderSidebar);
document.getElementById('btn-lookup-view').addEventListener('click', function() {
  viewMode = 'figma-lookup';
  renderAll();
  window.scrollTo(0, 0);
});
document.getElementById('btn-commented-view').addEventListener('click', function() {
  viewMode = 'commented';
  renderAll();
  window.scrollTo(0, 0);
});

document.getElementById('sb-list').addEventListener('click', function(ev) {
  const majEl = ev.target.closest('[data-toggle-major]');
  if (majEl) {
    const m = majEl.getAttribute('data-toggle-major');
    if (expandedMajors.has(m)) expandedMajors.delete(m);
    else expandedMajors.add(m);
    renderSidebar();
    return;
  }
  const catEl = ev.target.closest('[data-open-cat]');
  if (catEl) { openCategory(catEl.getAttribute('data-open-cat')); return; }
  const famEl = ev.target.closest('[data-open-fam]');
  if (famEl) { openFamily(famEl.getAttribute('data-open-fam')); return; }
});

// Content delegation
document.getElementById('content').addEventListener('click', function(ev) {
  const t = ev.target;
  if (t.id === 'btn-back') { viewMode = 'overview'; activeKey = ''; renderAll(); return; }
  if (t.id === 'kpi-comments' || t.closest('#kpi-comments')) { viewMode = 'commented'; renderAll(); return; }

  const jumpMaj = t.closest('[data-jump-major]');
  if (jumpMaj) {
    const m = jumpMaj.getAttribute('data-jump-major');
    expandedOverviewMajors.add(m);
    renderMain();
    const el = document.getElementById('sec-major-' + m);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const ovMaj = t.closest('[data-ov-major]');
  if (ovMaj) {
    const m = ovMaj.getAttribute('data-ov-major');
    if (expandedOverviewMajors.has(m)) expandedOverviewMajors.delete(m);
    else expandedOverviewMajors.add(m);
    renderMain();
    return;
  }

  const catEl = t.closest('[data-open-cat]');
  if (catEl) { openCategory(catEl.getAttribute('data-open-cat')); return; }
  const famEl = t.closest('[data-open-fam]');
  if (famEl) { openFamily(famEl.getAttribute('data-open-fam')); return; }

  if (t.classList.contains('id-link')) {
    const id = t.getAttribute('data-copy');
    copyText(id, '已複製 ID: ' + id);
    return;
  }

  if (t.classList.contains('focus-node-btn')) {
    ev.stopPropagation();
    const id = t.getAttribute('data-focus-id');
    const c = byId[id];
    const u = state.unrecorded && state.unrecorded[id];
    const label = (c && c.page) || t.getAttribute('data-focus-page') || (u && u.pageName) || id;
    requestFigmaFocus([id], label);
    return;
  }

  if (t.classList.contains('unrec-ask-agent')) {
    ev.stopPropagation();
    const id = t.getAttribute('data-unrec-id');
    if (!state.unrecorded[id] && lastLookup && lastLookup.unrecorded) {
      const found = lastLookup.unrecorded.find(function(x) { return x.id === id; });
      if (found) state.unrecorded[id] = Object.assign({}, found);
    }
    if (state.unrecorded[id]) {
      state.unrecorded[id].note = '未收錄新畫面，請 Agent 協助判斷分類並納入標註';
      saveState();
      renderAll();
      toast('已標記交給 Agent 分類：' + id);
    }
    return;
  }

  if (t.classList.contains('unrec-clear')) {
    ev.stopPropagation();
    const id = t.getAttribute('data-unrec-id');
    if (state.unrecorded[id]) {
      state.unrecorded[id].category = '';
      state.unrecorded[id].note = '';
      saveState();
      renderAll();
    }
    return;
  }

  if (t.id === 'btn-unrec-all-agent') {
    const list = (lastLookup && lastLookup.unrecorded) || [];
    let count = 0;
    list.forEach(function(it) {
      const cur = state.unrecorded[it.id] || it;
      if (!(cur.category || '').trim() && !(cur.note || '').trim()) {
        state.unrecorded[it.id] = Object.assign({}, cur, { note: '未收錄新畫面，請 Agent 協助判斷分類並納入標註' });
        count += 1;
      }
    });
    if (count > 0) {
      saveState();
      renderAll();
      toast('已標記 ' + count + ' 筆未收錄畫面交給 Agent 分類');
    } else {
      toast('所有未收錄項目皆已填寫分類或備註');
    }
    return;
  }

  if (t.id === 'btn-unrec-batch-apply') {
    const cat = (document.getElementById('unrec-batch-cat').value || '').trim();
    const note = (document.getElementById('unrec-batch-note').value || '').trim();
    if (!cat && !note) {
      toast('請至少填寫批量分類或批量備註');
      return;
    }
    const list = (lastLookup && lastLookup.unrecorded) || [];
    list.forEach(function(it) {
      const cur = state.unrecorded[it.id] || Object.assign({}, it);
      if (cat) cur.category = cat;
      if (note) cur.note = note;
      state.unrecorded[it.id] = cur;
    });
    saveState();
    renderAll();
    toast('已套用到 ' + list.length + ' 筆未收錄畫面');
    return;
  }

  if (t.classList.contains('copy-page-ids')) {
    ev.stopPropagation();
    const pg = t.getAttribute('data-page-key');
    const list = (window.__currentByPage && window.__currentByPage.get(pg)) || [];
    copyText(list.map(function(c) { return c.id; }).join(String.fromCharCode(10)), '已複製本頁 ' + list.length + ' 個 ID');
    return;
  }
  if (t.classList.contains('batch-label-page')) {
    ev.stopPropagation();
    const pg = t.getAttribute('data-page-key');
    const list = (window.__currentByPage && window.__currentByPage.get(pg)) || [];
    const pageIdSet = new Set(list.map(function(c) { return c.id; }));
    let hasOtherPage = false;
    selected.forEach(function(id) {
      if (!pageIdSet.has(id)) hasOtherPage = true;
    });
    if (hasOtherPage) {
      toast('不支援跨頁批量標註，請先取消其他頁面的勾選後再對本頁操作');
      return;
    }
    const targets = list.filter(function(c) { return selected.has(c.id); });
    if (targets.length === 0) {
      toast('請先勾選本頁要批量標註的畫面（可點右側「全選」）');
      return;
    }
    pendingBatch = { page: pg, ids: targets.map(function(c) { return c.id; }) };
    document.getElementById('batch-title').textContent = '批量標註 · ' + pg;
    document.getElementById('batch-count').textContent = '已選中 ' + targets.length + ' 筆';
    const inp = document.getElementById('batch-input');
    inp.value = '';
    document.getElementById('batch-modal').classList.add('show');
    setTimeout(function() { inp.focus(); }, 0);
    return;
  }
  if (t.classList.contains('focus-page-figma')) {
    ev.stopPropagation();
    const pg = t.getAttribute('data-page-key');
    const list = (window.__currentByPage && window.__currentByPage.get(pg)) || [];
    const first = list[0];
    const pgId = t.getAttribute('data-page-id') || (first ? first.pageId : '');
    requestFigmaFocus(first ? [first.id] : [], pg, { pageOnly: true, pageId: pgId });
    return;
  }
  if (t.classList.contains('select-page-all')) {
    ev.stopPropagation();
    const pg = t.getAttribute('data-page-key');
    const list = (window.__currentByPage && window.__currentByPage.get(pg)) || [];
    list.forEach(function(c) { selected.add(c.id); });
    renderMain();
    updateFloatBar();
    toast('已全選本頁 ' + list.length + ' 筆');
    return;
  }
  if (t.classList.contains('select-page-none')) {
    ev.stopPropagation();
    const pg = t.getAttribute('data-page-key');
    const list = (window.__currentByPage && window.__currentByPage.get(pg)) || [];
    list.forEach(function(c) { selected.delete(c.id); });
    renderMain();
    updateFloatBar();
    toast('已取消本頁勾選');
    return;
  }

  const pgHdr = t.closest('[data-toggle-page]');
  if (pgHdr) {
    const k = pgHdr.getAttribute('data-toggle-page');
    if (expandedPages.has(k)) {
      expandedPages.delete(k);
      expandedPages.add('COLLAPSED::' + k);
    } else {
      expandedPages.add(k);
      expandedPages.delete('COLLAPSED::' + k);
    }
    renderMain();
    return;
  }

  if (t.id === 'btn-expand-pages' && window.__currentByPage) {
    window.__currentByPage.forEach(function(_, pg) {
      const k = window.__currentScopePrefix + pg;
      expandedPages.add(k);
      expandedPages.delete('COLLAPSED::' + k);
    });
    renderMain();
    return;
  }
  if (t.id === 'btn-collapse-pages' && window.__currentByPage) {
    window.__currentByPage.forEach(function(_, pg) {
      const k = window.__currentScopePrefix + pg;
      expandedPages.delete(k);
      expandedPages.add('COLLAPSED::' + k);
    });
    renderMain();
    return;
  }

  if (t.id === 'btn-copy-group-ids') {
    const list = window.__currentGroupCards || [];
    copyText(list.map(function(c) { return c.id; }).join(String.fromCharCode(10)), '已複製 ' + list.length + ' 個 ID');
    return;
  }

  if (t.classList.contains('row-chk')) {
    const id = t.getAttribute('data-id');
    const boxes = Array.from(document.querySelectorAll('#content .row-chk'));
    if (ev.shiftKey && lastClickedId) {
      const ids = boxes.map(function(b) { return b.getAttribute('data-id'); });
      const a = ids.indexOf(lastClickedId);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let i = lo; i <= hi; i += 1) {
          if (t.checked) selected.add(ids[i]);
          else selected.delete(ids[i]);
          boxes[i].checked = t.checked;
          const row = boxes[i].closest('.screen-row');
          if (row) row.classList.toggle('selected', t.checked);
        }
      }
    } else {
      if (t.checked) selected.add(id);
      else selected.delete(id);
      const row = t.closest('.screen-row');
      if (row) row.classList.toggle('selected', t.checked);
    }
    lastClickedId = id;
    updateFloatBar();
  }
});

document.getElementById('content').addEventListener('input', function(ev) {
  const t = ev.target;
  if (t.id === 'dt-q') { detailFilter.q = t.value; renderMain(); document.getElementById('dt-q').focus(); return; }
  if (t.classList.contains('item-comment')) {
    const id = t.getAttribute('data-id');
    state.items[id] = t.value;
    t.classList.toggle('filled', t.value.trim().length > 0);
    const row = t.closest('.screen-row');
    if (row) row.classList.toggle('has-note', t.value.trim().length > 0);
    saveState();
    renderSidebar();
    return;
  }
  if (t.classList.contains('unrec-cat')) {
    const id = t.getAttribute('data-unrec-id');
    if (state.unrecorded[id]) {
      state.unrecorded[id].category = t.value;
      t.classList.toggle('filled', t.value.trim().length > 0);
      const row = t.closest('.unrec-row');
      if (row) {
        const hasAny = Boolean(t.value.trim() || (state.unrecorded[id].note || '').trim());
        row.classList.toggle('has-note', hasAny);
      }
      saveState();
      renderSidebar();
    }
    return;
  }
  if (t.classList.contains('unrec-note')) {
    const id = t.getAttribute('data-unrec-id');
    if (state.unrecorded[id]) {
      state.unrecorded[id].note = t.value;
      t.classList.toggle('filled', t.value.trim().length > 0);
      const row = t.closest('.unrec-row');
      if (row) {
        const hasAny = Boolean(t.value.trim() || (state.unrecorded[id].category || '').trim());
        row.classList.toggle('has-note', hasAny);
      }
      saveState();
      renderSidebar();
    }
    return;
  }
  if (t.classList.contains('cat-note-box')) {
    const kind = t.getAttribute('data-kind');
    const key = t.getAttribute('data-key');
    if (kind === 'category') state.categories[key] = t.value;
    else if (kind === 'family') state.families[key] = t.value;
    t.classList.toggle('filled', t.value.trim().length > 0);
    saveState();
    renderSidebar();
  }
});

document.getElementById('content').addEventListener('change', function(ev) {
  const t = ev.target;
  if (t.id === 'dt-arch') { detailFilter.arch = t.value; renderMain(); }
  else if (t.id === 'dt-gen') { detailFilter.gen = t.value; renderMain(); }
  else if (t.id === 'dt-only-comment') { detailFilter.onlyCommented = t.checked; renderMain(); }
});

// Topbar & float bar actions
document.getElementById('topbar-title').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'btn-back') {
    viewMode = 'overview';
    activeKey = '';
    renderAll();
  }
});

document.getElementById('btn-copy-ids').addEventListener('click', function() {
  const ids = Array.from(selected);
  copyText(ids.join(String.fromCharCode(10)), '已複製 ' + ids.length + ' 個 ID');
});
document.getElementById('btn-focus-selected').addEventListener('click', function() {
  const list = Array.from(selected).map(function(id) { return byId[id]; }).filter(Boolean);
  if (list.length === 0) return;
  const pages = Array.from(new Set(list.map(function(c) { return c.pageId || c.page || '?'; })));
  if (pages.length > 1) {
    toast('已選項目跨 ' + pages.length + ' 個頁面，請改點各頁標題的「定位到 Figma」逐頁選中');
    return;
  }
  requestFigmaFocus(list.map(function(c) { return c.id; }), list[0].page || list[0].id);
});
document.getElementById('btn-sel-clear').addEventListener('click', function() {
  selected.clear();
  renderMain();
  updateFloatBar();
});

document.getElementById('btn-clear').addEventListener('click', function() {
  state.categories = {};
  state.families = {};
  state.items = {};
  state.unrecorded = {};
  saveState();
  renderAll();
  toast('已清空所有意見');
});

function buildAgentPrompt() {
  const BT = String.fromCharCode(96);
  const NL = String.fromCharCode(10);
  const catEntries = Object.keys(state.categories).filter(function(k) { return (state.categories[k] || '').trim(); });
  const famEntries = Object.keys(state.families).filter(function(h) { return (state.families[h] || '').trim(); });
  const itemIds = Object.keys(state.items).filter(function(id) { return (state.items[id] || '').trim() && byId[id]; });
  const unrecIds = activeUnrecordedIds();

  const lines = [];
  lines.push('請根據以下我在 Rea-FigmaDesign 複審工作台填寫的人工核對意見，協助核查並整理要寫入 ' + BT + 'labels/screens-v2.json' + BT + ' 的修改方案：');
  lines.push('');

  if (document.getElementById('include-scope').checked) {
    lines.push('## 核對範圍');
    lines.push('- 圖譜：' + BT + DATA.db + BT);
    lines.push('- 檢視範圍：' + DATA.modeLabel + '（去重 ' + DATA.uniqueCount + ' 組 / 共 ' + DATA.matchedScreens + ' 個畫面）');
    lines.push('- 本次提出意見：分類意見 ' + catEntries.length + ' 筆、AST 家族意見 ' + famEntries.length + ' 組、單筆畫面意見 ' + itemIds.length + ' 筆、未收錄新畫面 ' + unrecIds.length + ' 筆（其餘留空項目視為無需修改）');
    lines.push('');
  }

  if (catEntries.length > 0) {
    lines.push('## 一、分類整體意見');
    catEntries.forEach(function(k, idx) {
      const rec = catMap.get(k);
      const title = rec ? (rec.major + ' / ' + rec.minor) : k;
      const sampleIds = rec ? rec.cards.slice(0, 10).map(function(c) { return c.id; }).join(', ') : '';
      lines.push((idx + 1) + '. **分類：' + title + '**' + (rec ? '（共 ' + rec.totalScreens + ' 畫面 / ' + rec.pages.size + ' 頁）' : ''));
      if (sampleIds) lines.push('   - 代表 node_id：' + BT + sampleIds + BT);
      lines.push('   - **我的意見**：' + state.categories[k].trim());
    });
    lines.push('');
  }

  if (famEntries.length > 0) {
    lines.push('## 二、AST 家族批次意見');
    famEntries.forEach(function(h, idx) {
      const f = famMap.get(h);
      const allIds = f ? Array.from(new Set(f.cards.flatMap(function(c) { return c.memberIds; }))) : [];
      const idPreview = allIds.slice(0, 20).join(', ') + (allIds.length > 20 ? ' ...（共 ' + allIds.length + ' 個）' : '');
      lines.push((idx + 1) + '. **AST 家族 #' + h.slice(0, 8) + '**' + (f ? '（共 ' + f.totalScreens + ' 個畫面 · ' + f.pages.size + ' 頁）' : ''));
      if (idPreview) lines.push('   - 涵蓋 node_id：' + BT + idPreview + BT);
      lines.push('   - **我的意見**：' + state.families[h].trim());
    });
    lines.push('');
  }

  if (itemIds.length > 0) {
    lines.push('## 三、單筆畫面核對意見');
    itemIds.forEach(function(id, idx) {
      const c = byId[id];
      const cur = c.major ? (c.major + (c.minor ? ' / ' + c.minor : '') + (c.generation ? ' (' + c.generation + ')' : '')) : '未標註';
      const copyNote = c.copies > 1 ? '（同構複本共 ' + c.copies + ' 個：' + c.memberIds.slice(0, 8).join(', ') + (c.memberIds.length > 8 ? '…' : '') + '）' : '';
      lines.push((idx + 1) + '. **' + BT + c.id + BT + '** · 頁面：' + (c.page || '-') + ' · 圖層：' + c.name + ' · 原型：' + c.archetype + copyNote);
      lines.push('   - 目前狀態：' + cur);
      lines.push('   - **我的意見**：' + state.items[id].trim());
    });
    lines.push('');
  }

  if (unrecIds.length > 0) {
    lines.push('## 四、Figma 未收錄新畫面（待同步與分類）');
    unrecIds.forEach(function(id, idx) {
      const u = state.unrecorded[id];
      const dims = (typeof u.width === 'number' && typeof u.height === 'number') ? (' · 尺寸：' + u.width + '×' + u.height) : '';
      lines.push((idx + 1) + '. **' + BT + u.id + BT + '** · 頁面：' + (u.pageName || '-') + ' · 圖層：' + (u.name || '-') + ' · 類型：' + (u.type || '-') + dims);
      if (u.textPreview) lines.push('   - 文案摘要：' + u.textPreview);
      lines.push('   - 人工指定分類：' + ((u.category || '').trim() ? u.category.trim() : '未指定，請 Agent 判斷分類'));
      if ((u.note || '').trim()) lines.push('   - **我的備註**：' + u.note.trim());
    });
    lines.push('');
  }

  if (catEntries.length === 0 && famEntries.length === 0 && itemIds.length === 0 && unrecIds.length === 0) {
    lines.push('（本次檢視尚未填寫任何具體修改意見，現有標註可視為確認無誤。）');
    lines.push('');
  }

  lines.push('## 處理要求');
  lines.push('1. 請只針對上述有填寫意見的分類、家族或 ID 核對 SQLite 與 ' + BT + 'labels/screens-v2.json' + BT + '，不要改動未提及的標註。');
  lines.push('2. 若單筆有同構複本（copies > 1）或屬於 AST 家族，請先用 ' + BT + 'apply_labels(dryRun: true)' + BT + ' 列出受影響的所有 node_id 與修改前後對照表。');
  lines.push('3. 等我確認對照表後再正式寫入 ' + BT + 'labels/screens-v2.json' + BT + '。');
  if (unrecIds.length > 0) {
    lines.push('4. 針對「四、Figma 未收錄新畫面」，請先檢查 SQLite 是否已匯入對應 node_id；若尚未匯入請提醒我先在插件重新匯出該頁面，再協助歸類並列出要寫入 ' + BT + 'labels/screens-v2.json' + BT + ' 的新增方案供確認。');
  }
  return lines.join(NL);
}

function showPromptModal() {
  const prompt = buildAgentPrompt();
  document.getElementById('modal-text').value = prompt;
  document.getElementById('modal').classList.add('show');
  copyText(prompt, '已複製 Agent 提示詞到剪貼簿');
}

document.getElementById('btn-prompt').addEventListener('click', showPromptModal);
document.getElementById('include-scope').addEventListener('change', function() {
  document.getElementById('modal-text').value = buildAgentPrompt();
});
document.getElementById('modal-copy').addEventListener('click', function() {
  copyText(document.getElementById('modal-text').value, '已重新複製到剪貼簿');
});
document.getElementById('modal-close').addEventListener('click', function() {
  document.getElementById('modal').classList.remove('show');
});
document.getElementById('modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'modal') this.classList.remove('show');
});

function closeBatchModal() {
  document.getElementById('batch-modal').classList.remove('show');
  pendingBatch = null;
}
function applyBatchLabel() {
  if (!pendingBatch || !pendingBatch.ids || pendingBatch.ids.length === 0) {
    closeBatchModal();
    return;
  }
  const text = (document.getElementById('batch-input').value || '').trim();
  if (!text) {
    toast('請輸入標註內容');
    document.getElementById('batch-input').focus();
    return;
  }
  pendingBatch.ids.forEach(function(id) {
    state.items[id] = text;
  });
  saveState();
  const pageName = pendingBatch.page;
  const count = pendingBatch.ids.length;
  closeBatchModal();
  renderAll();
  toast('已批量標註「' + pageName + '」共 ' + count + ' 筆');
}
document.getElementById('batch-cancel').addEventListener('click', closeBatchModal);
document.getElementById('batch-apply').addEventListener('click', applyBatchLabel);
document.getElementById('batch-modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'batch-modal') closeBatchModal();
});
document.getElementById('batch-input').addEventListener('keydown', function(ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault();
    applyBatchLabel();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closeBatchModal();
  }
});

renderAll();
connectBridge();
</script>
</body>
</html>`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');

  if (opts.open && process.platform === 'darwin') {
    spawn('/usr/bin/open', [outPath], { detached: true, stdio: 'ignore' }).unref();
  }

  return {
    html: outPath,
    unique: selectedCards.length,
    screens: rawScreens.length,
    db: dbPath,
    modeLabel,
    isColdStart,
  };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const args = process.argv.slice(2);
  let dbFlag = '';
  let category = '';
  let page = '';
  let unlabeled = false;
  let sample = 0;
  let ids: string[] = [];
  let outPath = '';
  let open = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--db') dbFlag = args[++i] ?? '';
    else if (a === '--category') category = args[++i] ?? '';
    else if (a === '--page') page = args[++i] ?? '';
    else if (a === '--unlabeled') unlabeled = true;
    else if (a === '--sample') sample = Math.max(1, Number(args[++i] ?? 10) || 10);
    else if (a === '--ids') ids = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') outPath = args[++i] ?? '';
    else if (a === '--open') open = true;
    else if (!a.startsWith('--') && !dbFlag) dbFlag = a;
  }

  const dbPath = dbFlag ? resolve(ROOT, dbFlag) : (AstGraphDB.resolveLatestGraphDb(ROOT) ?? '');
  try {
    const res = generateReviewBoard({ dbPath, category, page, unlabeled, sample, ids, outPath, open });
    console.log('review.html written · unique=' + res.unique + ' screens=' + res.screens + ' db=' + res.db);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
