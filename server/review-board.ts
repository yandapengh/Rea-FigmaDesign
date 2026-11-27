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
import { Graph, archetypeOf, findScreenRootCandidates, headlineOf, parseJson, type ScreenSpec, type StylePayload } from './core/graph';
import {
  listProjects,
  listWorkspaces,
  loadLastSync,
  loadProposals,
  makeCompositeScreenId,
  projectReviewHtmlName,
  resolveProject,
  resolveWorkspace,
  type LastSyncReport,
  type ProjectInfo,
  type WorkspaceInfo,
} from './core/projects';
import { buildInlineSearchZhJs } from './core/search-zh';
import { tryLoadScreenLabelsV2, type ScreenLabelV2 } from './core/semantics';
import { generateProjectHub } from './review-hub';

const ROOT = resolve(__dirname, '..');
const SCRATCH = resolve(ROOT, '.scratch');

export interface ReviewBoardOptions {
  projectId?: string;
  dbPath?: string;
  labelsPath?: string;
  screenSpec?: Partial<ScreenSpec>;
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
  projectId: string;
  html: string;
  unique: number;
  screens: number;
  db: string;
  modeLabel: string;
  isColdStart: boolean;
}

export function generateReviewBoard(opts: ReviewBoardOptions): ReviewBoardResult {
  const matchedWs: WorkspaceInfo | null = (!opts.dbPath && opts.projectId)
    ? resolveWorkspace(ROOT, opts.projectId)
    : null;
  const isWorkspace = matchedWs !== null;
  const resolved = isWorkspace ? null : resolveProject(ROOT, { project: opts.projectId, dbPath: opts.dbPath });
  const boardId = isWorkspace ? matchedWs!.id : resolved!.id;
  const boardName = isWorkspace ? matchedWs!.name : resolved!.name;
  const dbPath = isWorkspace
    ? (matchedWs!.sourceProjects[0]?.dbPath || join(ROOT, 'data'))
    : (opts.dbPath ? resolve(ROOT, opts.dbPath) : resolved!.dbPath);
  const sources: ProjectInfo[] = isWorkspace ? matchedWs!.sourceProjects : [resolved!];

  if (sources.length === 0) {
    throw new Error('應用組合「' + boardName + '」目前沒有可用的已匯出 Figma 來源檔');
  }
  for (const src of sources) {
    if (!src.dbPath || !existsSync(src.dbPath)) {
      throw new Error('no database found for ' + src.id + '; run the Figma extraction first');
    }
  }

  const outPath = opts.outPath ? resolve(ROOT, opts.outPath) : join(SCRATCH, projectReviewHtmlName(boardId));
  if (!(outPath === SCRATCH || outPath.startsWith(SCRATCH + sep))) {
    throw new Error('--out must stay inside .scratch/ (got ' + outPath + ')');
  }

  const categoryFilter = opts.category?.trim() ?? '';
  const pageFilter = opts.page?.trim() ?? '';
  const unlabeledOnly = opts.unlabeled === true;
  const sampleCount = typeof opts.sample === 'number' && opts.sample > 0 ? Math.max(1, Math.floor(opts.sample)) : 0;
  const idsFilter = (opts.ids ?? []).map((s) => s.trim()).filter(Boolean);

  let fileKey = isWorkspace ? '' : (resolved!.fileKey || '');
  let fileName = isWorkspace ? matchedWs!.name : (resolved!.fileName || '');

  const labelsRelPath = isWorkspace ? matchedWs!.labelsRelPath : resolved!.labelsRelPath;
  const labelsAbsPath = opts.labelsPath
    ? resolve(ROOT, opts.labelsPath)
    : (isWorkspace ? matchedWs!.labelsPath : resolved!.labelsPath);
  const v2Doc = tryLoadScreenLabelsV2(labelsAbsPath);
  const labelMap = new Map<string, ScreenLabelV2>();
  if (v2Doc) {
    for (const s of v2Doc.screens) labelMap.set(s.id, s);
  }

  const baseSpec = isWorkspace ? matchedWs!.config.screenSpec : resolved!.config.screenSpec;
  const screenSpec: ScreenSpec = {
    ...baseSpec,
    ...(opts.screenSpec ?? {}),
    widths: opts.screenSpec?.widths && opts.screenSpec.widths.length > 0 ? opts.screenSpec.widths : baseSpec.widths,
  };
  const idSet = new Set(idsFilter);
  const pageNeedle = pageFilter.toLowerCase();

  interface RawScreen {
    id: string;
    rawId: string;
    name: string;
    page: string;
    rawPageName: string;
    pageId: string;
    rawPageId: string;
    pageIndex: number;
    sourceId: string;
    sourceName: string;
    sourceFileKey: string;
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
    rawId: string;
    name: string;
    page: string;
    rawPageName: string;
    pageId: string;
    rawPageId: string;
    pageIndex: number;
    sourceId: string;
    sourceName: string;
    sourceFileKey: string;
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
  const rawPaletteByScreen = new Map<string, string[]>();
  let totalRootsCount = 0;

  for (let sIdx = 0; sIdx < sources.length; sIdx += 1) {
    const src = sources[sIdx];
    const g = (!isWorkspace && opts.graph) ? opts.graph : new Graph(src.dbPath);
    const db = new Database(src.dbPath, { readonly: true, fileMustExist: true });
    const srcFallbackMap = new Map<string, ScreenLabelV2>();
    if (isWorkspace) {
      const srcDoc = tryLoadScreenLabelsV2(src.labelsPath);
      if (srcDoc) for (const lbl of srcDoc.screens) srcFallbackMap.set(lbl.id, lbl);
    }

    const srcRoots = findScreenRootCandidates(g, screenSpec);
    totalRootsCount += srcRoots.length;
    const srcScreens: RawScreen[] = [];

    try {
      const fileMeta = db.prepare('SELECT file_key, file_name FROM file_meta ORDER BY extracted_at DESC LIMIT 1').get() as
        | { file_key: string; file_name: string }
        | undefined;
      const srcFileKey = fileMeta?.file_key ?? src.fileKey ?? '';
      const srcFileName = fileMeta?.file_name ?? src.fileName ?? src.id;
      if (!isWorkspace) {
        fileKey = srcFileKey;
        fileName = srcFileName;
      }

      const pageMeta = new Map<string, { name: string; index: number }>();
      for (const row of db.prepare('SELECT page_id, page_name, page_index FROM pages').all() as Array<{
        page_id: string;
        page_name: string;
        page_index: number;
      }>) {
        pageMeta.set(row.page_id, { name: row.page_name, index: row.page_index });
      }

      const seenRaw = new Set<string>();
      const appendScreen = (rawId: string, checkMinNodes: boolean): void => {
        if (seenRaw.has(rawId) || !g.nodes.has(rawId)) return;
        const sub = g.subtree(rawId);
        if (checkMinNodes && sub.length < screenSpec.minNodes && !idSet.has(rawId) && !idSet.has(makeCompositeScreenId(src.id, rawId))) return;
        const screenId = isWorkspace ? makeCompositeScreenId(src.id, rawId) : rawId;
        if (idSet.size > 0 && !idSet.has(screenId) && !idSet.has(rawId)) return;

        const n = g.nodes.get(rawId)!;
        const pgInfo = pageMeta.get(n.page_id);
        const rawPageName = (pgInfo?.name ?? n.page_name ?? '').trim();
        const displayPage = isWorkspace ? ('[' + srcFileName + '] ' + (rawPageName || '(未命名頁面)')) : rawPageName;
        const lbl = labelMap.get(screenId) ?? (isWorkspace ? srcFallbackMap.get(rawId) : undefined);

        if (unlabeledOnly && lbl) return;
        if (categoryFilter) {
          if (!lbl) return;
          const matchMinor = lbl.minor === categoryFilter || lbl.label === categoryFilter;
          const matchMajor = lbl.major === categoryFilter;
          if (!matchMinor && !matchMajor) return;
        }
        if (pageNeedle && displayPage.toLowerCase().indexOf(pageNeedle) === -1) return;

        const texts: string[] = [];
        for (const sid of sub) {
          const t = g.nodes.get(sid)?.text_content;
          if (t) texts.push(t);
        }
        seenRaw.add(rawId);
        const rec: RawScreen = {
          id: screenId,
          rawId,
          name: n.name,
          page: displayPage,
          rawPageName: rawPageName || '(未命名頁面)',
          pageId: isWorkspace ? makeCompositeScreenId(src.id, n.page_id) : n.page_id,
          rawPageId: n.page_id,
          pageIndex: sIdx * 10000 + (pgInfo?.index ?? 9999),
          sourceId: src.id,
          sourceName: srcFileName,
          sourceFileKey: srcFileKey,
          archetype: archetypeOf(g, rawId),
          hash: g.hash.get(rawId) ?? '',
          nodes: sub.length,
          headline: headlineOf(texts),
          major: lbl?.major ?? '',
          minor: lbl?.minor ?? '',
          label: lbl?.label ?? '',
          generation: lbl?.generation ?? '',
          note: lbl?.note ?? '',
        };
        srcScreens.push(rec);
        rawScreens.push(rec);
      };

      for (const rawId of srcRoots) appendScreen(rawId, true);
      if (idSet.size > 0) {
        for (const target of idsFilter) {
          const rawCandidate = target.startsWith(src.id + '::') ? target.slice(src.id.length + 2) : target;
          appendScreen(rawCandidate, false);
        }
      }

      // Extract top palette hex colors per screen from this source SQLite DB
      const cardPalette = new Map<string, Map<string, number>>();
      const nodeToScreen = new Map<string, string>();
      for (const r of srcScreens) {
        cardPalette.set(r.id, new Map<string, number>());
        const sub = g.subtree(r.rawId);
        const cap = Math.min(sub.length, 80);
        for (let i = 0; i < cap; i += 1) {
          const sid = sub[i];
          if (!nodeToScreen.has(sid)) nodeToScreen.set(sid, r.id);
        }
      }
      const addStyleToPalette = (screenId: string, styleJson: string): void => {
        const st = parseJson<StylePayload>(styleJson);
        if (!st) return;
        const pal = cardPalette.get(screenId);
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

      const targetIds = [...nodeToScreen.keys()];
      if (targetIds.length > 0 && targetIds.length <= 4000 && srcFileKey) {
        for (let i = 0; i < targetIds.length; i += 500) {
          const part = targetIds.slice(i, i + 500);
          const rows = db
            .prepare('SELECT id, style_json FROM nodes WHERE file_key = ? AND id IN (' + part.map(() => '?').join(',') + ')')
            .all(srcFileKey, ...part) as Array<{ id: string; style_json: string }>;
          for (const r of rows) {
            const sid = nodeToScreen.get(r.id);
            if (sid) addStyleToPalette(sid, r.style_json);
          }
        }
      } else if (targetIds.length > 0) {
        const sql = srcFileKey ? 'SELECT id, style_json FROM nodes WHERE file_key = ?' : 'SELECT id, style_json FROM nodes';
        const stmt = db.prepare(sql);
        const iter = (srcFileKey ? stmt.iterate(srcFileKey) : stmt.iterate()) as Iterable<{ id: string; style_json: string }>;
        for (const r of iter) {
          const sid = nodeToScreen.get(r.id);
          if (sid) addStyleToPalette(sid, r.style_json);
        }
      }

      for (const r of srcScreens) {
        const pal = cardPalette.get(r.id);
        if (!pal) continue;
        rawPaletteByScreen.set(
          r.id,
          [...pal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([hx]) => hx),
        );
      }
    } finally {
      db.close();
    }
  }

  const cards: Card[] = [];
  if (idSet.size > 0) {
    for (const r of rawScreens) {
      cards.push({
        id: r.id,
        rawId: r.rawId,
        name: r.name,
        page: r.page,
        rawPageName: r.rawPageName,
        pageId: r.pageId,
        rawPageId: r.rawPageId,
        pageIndex: r.pageIndex,
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        sourceFileKey: r.sourceFileKey,
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
        palette: rawPaletteByScreen.get(r.id) ?? [],
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
          rawId: r.rawId,
          name: r.name,
          page: r.page,
          rawPageName: r.rawPageName,
          pageId: r.pageId,
          rawPageId: r.rawPageId,
          pageIndex: r.pageIndex,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          sourceFileKey: r.sourceFileKey,
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
          palette: rawPaletteByScreen.get(r.id) ?? [],
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

  const paletteByHash = new Map<string, string[]>();
  for (const c of selectedCards) {
    if (c.palette.length > 0 && !paletteByHash.has(c.hash)) paletteByHash.set(c.hash, c.palette);
  }

  // Per-page cards (deduplicated strictly within each Figma page & category so Page View / Category View never leak cross-page memberIds)
  const pageCards: Card[] = [];
  if (idSet.size > 0) {
    for (const r of rawScreens) {
      pageCards.push({
        id: r.id,
        rawId: r.rawId,
        name: r.name,
        page: r.page,
        rawPageName: r.rawPageName,
        pageId: r.pageId,
        rawPageId: r.rawPageId,
        pageIndex: r.pageIndex,
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        sourceFileKey: r.sourceFileKey,
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
        palette: rawPaletteByScreen.get(r.id) ?? paletteByHash.get(r.hash) ?? [],
      });
    }
  } else {
    const byPageKey = new Map<string, Card>();
    for (const r of rawScreens) {
      const k = r.sourceId + '|' + r.rawPageId + '|' + r.major + '|' + r.minor + '|' + r.hash + '|' + r.headline;
      const prev = byPageKey.get(k);
      if (!prev) {
        const card: Card = {
          id: r.id,
          rawId: r.rawId,
          name: r.name,
          page: r.page,
          rawPageName: r.rawPageName,
          pageId: r.pageId,
          rawPageId: r.rawPageId,
          pageIndex: r.pageIndex,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          sourceFileKey: r.sourceFileKey,
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
          palette: rawPaletteByScreen.get(r.id) ?? paletteByHash.get(r.hash) ?? [],
        };
        byPageKey.set(k, card);
        pageCards.push(card);
      } else {
        prev.copies += 1;
        prev.memberIds.push(r.id);
      }
    }
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
  if (isWorkspace) modeParts.push('多檔組合（' + sources.length + ' 份）');
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
    const catKeys = new Set(selectedCards.map((c) => (c.major || '未標註') + '::' + (c.minor || '(未細分)')));
    if (catKeys.size === 1) {
      autoSelectCategory = [...catKeys][0];
      autoSelectMode = 'category';
    } else {
      autoSelectMode = 'subset';
    }
  } else if ((sampleCount > 0 || idsFilter.length > 0 || pageFilter) && selectedCards.length > 0 && selectedCards.length <= 60) {
    autoSelectMode = 'subset';
  }

  const proposalsDoc = loadProposals(ROOT, boardId);
  const activeProposals = (proposalsDoc?.items ?? []).filter((it) => {
    const cur = labelMap.get(it.id);
    if (!cur) return false;
    return cur.major === it.currentMajor && (cur.minor || '') === (it.currentMinor || '');
  });

  let mergedLastSync: LastSyncReport | null = null;
  if (!isWorkspace) {
    mergedLastSync = loadLastSync(dbPath);
  } else {
    let bestTs = '';
    for (const src of sources) {
      const ls = loadLastSync(src.dbPath);
      if (!ls || ls.isInitialImport) continue;
      if (ls.addedScreens.length === 0 && ls.removedScreens.length === 0) continue;
      if (ls.syncedAt >= bestTs) {
        bestTs = ls.syncedAt;
        mergedLastSync = {
          ...ls,
          touchedPages: ls.touchedPages.map((pn) => '[' + src.fileName + '] ' + pn),
          prunedPages: ls.prunedPages.map((pn) => '[' + src.fileName + '] ' + pn),
          addedScreens: ls.addedScreens.map((s) => ({
            ...s,
            id: makeCompositeScreenId(src.id, s.id),
            pageName: '[' + src.fileName + '] ' + s.pageName,
          })),
          removedScreens: ls.removedScreens.map((s) => ({
            ...s,
            id: makeCompositeScreenId(src.id, s.id),
            pageName: '[' + src.fileName + '] ' + s.pageName,
          })),
        };
      }
    }
  }

  const payloadObj = {
    projectId: boardId,
    projectName: boardName,
    isWorkspace,
    sources: sources.map((s) => ({ id: s.id, name: s.name, fileName: s.fileName, fileKey: s.fileKey })),
    fileKey,
    db: isWorkspace ? sources.map((s) => s.dbPath).join(', ') : dbPath,
    fileName,
    labelsPath: labelsRelPath,
    screenSpec,
    majorOrder: (isWorkspace ? matchedWs!.config.majorOrder : resolved!.config.majorOrder) ?? ['新UI', '老UI', '系統UI', '未標註'],
    hubHref: './review.html',
    modeLabel,
    isColdStart,
    isSampled: sampleCount > 0,
    defaultSidebarMode: (unlabeledOnly || isColdStart) && !categoryFilter ? 'families' : 'categories',
    totalRoots: totalRootsCount,
    matchedScreens: rawScreens.length,
    uniqueCount: selectedCards.length,
    familyCount: famMap.size,
    labeledUniqueCount,
    unlabeledUniqueCount,
    autoSelectCategory,
    autoSelectMode,
    proposalsScope: proposalsDoc?.scope || '',
    proposals: activeProposals,
    lastSync: mergedLastSync,
    cards: selectedCards,
    pageCards,
  };
  const payload = JSON.stringify(payloadObj).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rea-FigmaDesign · 數據看板與人工複審</title>
<style>
  :root {
    --bg: #f5f7fa;
    --bg-elev: #ffffff;
    --bg-soft: #eef2f6;
    --bg-hover: #e5ecf4;
    --border: #d0d7de;
    --border-soft: #e6ebf1;
    --text: #1f2328;
    --text-muted: #59636e;
    --text-soft: #818b98;
    --accent: #0969da;
    --accent-bg: #e8f1ff;
    --green: #1a7f37;
    --green-bg: #dafbe1;
    --amber: #9a6700;
    --amber-bg: #fff8c5;
    --purple: #8250df;
    --purple-bg: #fbefff;
    --red: #cf222e;
    --shadow: 0 10px 28px rgba(31, 35, 40, 0.12);
    --radius: 12px;
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
    width: 292px;
    flex: 0 0 292px;
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
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .seg button.active { background: var(--accent); color: #fff; box-shadow: 0 1px 3px rgba(9,105,218,0.22); }
  .sb-search { width: 100%; margin-top: 8px; }
  .sb-scroll { flex: 1; overflow-y: auto; padding: 8px 10px 14px; }
  .sb-foot {
    padding: 10px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-elev);
  }
  .major-group { margin-bottom: 6px; border-radius: 9px; border: 1px solid transparent; }
  .major-group.open { background: #f7f9fc; border-color: var(--border-soft); }
  .major-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 9px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 8px;
    user-select: none;
  }
  .major-hdr:hover { background: var(--bg-hover); color: var(--text); }
  .major-group.open .major-hdr { color: var(--text); }
  .major-hdr-left { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .major-chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: var(--bg-soft);
    color: var(--text-muted);
    font-size: 11px;
    flex-shrink: 0;
  }
  .major-group.open .major-chev { background: #dce8fb; color: var(--accent); }
  .major-children {
    margin: 2px 6px 6px 14px;
    padding-left: 10px;
    border-left: 2px solid #cbd5e1;
  }
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
    border: 1.5px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .cat-item:hover { background: var(--bg-hover); }
  .cat-item.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    box-shadow: inset 3.5px 0 0 var(--accent), 0 1px 3px rgba(9, 105, 218, 0.14);
    color: #0550ae;
    font-weight: 700;
  }
  .cat-item.active .pill:not(.green):not(.amber) { background: var(--accent); color: #fff; }
  .cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .cat-meta { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .sb-source-picker {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--bg-soft);
  }
  .sb-src-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sb-src-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 148px;
    overflow-y: auto;
  }
  .sb-src-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--bg-elev);
    cursor: pointer;
    font-size: 12px;
    color: var(--text);
    transition: background 0.12s, border-color 0.12s;
  }
  .sb-src-item:hover { background: var(--bg-hover); }
  .sb-src-item.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: #0550ae;
    font-weight: 700;
  }
  .sb-src-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .sb-src-dot { width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; flex-shrink: 0; }
  .sb-src-dot.live { background: var(--green); }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-soft);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .pill.green { background: var(--green-bg); color: var(--green); }
  .pill.accent { background: var(--accent-bg); color: var(--accent); }
  .pill.amber { background: var(--amber-bg); color: var(--amber); }
  .pill.purple { background: var(--purple-bg); color: var(--purple); }
  .pill.red { background: rgba(207, 34, 46, 0.12); color: var(--red); }
  .pill.solid-blue { background: var(--accent); color: #fff; }
  .pill.solid-amber { background: #d97706; color: #fff; }

  .workspace { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 25;
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
  button.btn:hover, .btn:hover { background: var(--bg-hover); }
  button.btn.primary { background: var(--green); border-color: var(--green); color: #fff; }
  button.btn.primary:hover { filter: brightness(1.06); }
  button.btn.accent { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.btn.accent:hover { filter: brightness(1.06); }
  button.btn.ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
  button.btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
  button.btn.sm, .btn.sm { padding: 4px 9px; font-size: 11.5px; border-radius: 6px; }
  input, select, textarea {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 12px;
    font-family: inherit;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(9,105,218,0.12); }
  .row-chk, .grp-chk {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
    margin: 0;
  }

  .menu-wrap { position: relative; display: inline-flex; }
  .menu-pop {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    min-width: 220px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 5px;
    box-shadow: var(--shadow);
    z-index: 48;
    display: none;
    flex-direction: column;
    gap: 2px;
  }
  .menu-pop.show { display: flex; }
  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--text);
    padding: 7px 10px;
    border-radius: 7px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .menu-item:hover { background: var(--bg-hover); }
  .menu-item.danger { color: var(--red); }

  .hint-bar {
    background: var(--accent-bg);
    border: 1px solid #b6d4fe;
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
  .sw { display: inline-block; width: 16px; height: 10px; border-radius: 3px; border: 1px solid rgba(31,35,40,0.18); }

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

  .cat-stack-bar {
    height: 10px;
    border-radius: 99px;
    overflow: hidden;
    display: flex;
    background: var(--bg-soft);
    border: 1px solid var(--border-soft);
  }
  .cat-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .cat-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 99px;
    border: 1px solid var(--border);
    background: var(--bg-soft);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
  }
  .cat-chip:hover { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }
  .cat-dot { width: 8px; height: 8px; border-radius: 99px; display: inline-block; }

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
    overflow: visible;
  }
  .page-group.has-sel { border-color: #84b6f4; box-shadow: 0 2px 8px rgba(9, 105, 218, 0.08); }
  .page-group-hdr {
    padding: 10px 14px;
    background: var(--bg-soft);
    border-radius: var(--radius) var(--radius) 0 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }
  .page-group-hdr.collapsed-hdr { border-radius: var(--radius); }
  .page-group-hdr:hover { background: var(--bg-hover); }
  .page-group-title { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .page-group-body.hidden { display: none; }
  .page-group-body .screen-row:last-child { border-bottom-left-radius: var(--radius); border-bottom-right-radius: var(--radius); }

  .screen-row {
    display: grid;
    grid-template-columns: auto 210px minmax(220px, 1fr) minmax(280px, 34%);
    gap: 14px;
    align-items: start;
    padding: 12px 14px;
    border-top: 1px solid var(--border-soft);
    transition: background 0.1s;
  }
  .screen-row:hover { background: #f2f6fb; }
  .screen-row.has-note { background: rgba(26, 127, 55, 0.05); }
  .screen-row.focused-row {
    background: #fffbeb;
    box-shadow: inset 4px 0 0 #d97706;
    outline: 1.5px solid #f59e0b;
    outline-offset: -1.5px;
  }
  .screen-row.selected {
    background: #ebf3ff;
    box-shadow: inset 4px 0 0 var(--accent);
    border-top-color: #b6d4fe;
  }
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
  .cat-select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    height: 30px;
    padding: 0 28px 0 9px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background-color: var(--bg-elev);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.25L6 7.75L9.5 4.25' fill='none' stroke='%2357606a' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 9px center;
    background-size: 12px;
    color: var(--text);
    cursor: pointer;
  }
  .cat-select:hover { border-color: #94a3b8; }
  .cat-select.filled { border-color: var(--accent); background-color: var(--accent-bg); font-weight: 600; color: #0550ae; }
  .quick-cat-sel { height: 28px; margin-bottom: 6px; background-color: var(--bg-soft); }
  .cat-combo { position: relative; width: 100%; }
  .cat-combo.quick { margin-bottom: 6px; }
  .cat-combo-input {
    width: 100%;
    height: 30px;
    padding: 0 42px 0 9px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background-color: var(--bg-elev);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.25L6 7.75L9.5 4.25' fill='none' stroke='%2357606a' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 9px center;
    background-size: 12px;
    color: var(--text);
  }
  .cat-combo-input.quick-cat-sel { height: 28px; margin-bottom: 0; background-color: var(--bg-soft); }
  .cat-combo-input:hover { border-color: #94a3b8; }
  .cat-combo-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.14); background-color: var(--bg-elev); }
  .cat-combo-input.filled { border-color: var(--accent); background-color: var(--accent-bg); font-weight: 600; color: #0550ae; }
  .cat-combo-clear {
    position: absolute;
    right: 24px;
    top: 50%;
    transform: translateY(-50%);
    border: 0;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .cat-combo-clear:hover { background: var(--bg-hover); color: var(--text); }
  .cat-combo-input:placeholder-shown + .cat-combo-clear { display: none; }
  #cat-combo-menu {
    position: fixed;
    z-index: 160;
    display: none;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 30px rgba(31, 35, 40, 0.16);
    max-height: 290px;
    overflow-y: auto;
    padding: 6px;
  }
  .cat-combo-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px 6px;
    font-size: 11px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-soft);
    margin-bottom: 4px;
  }
  .cat-combo-grp {
    padding: 6px 8px 3px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .cat-combo-opt {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text);
  }
  .cat-combo-opt:hover, .cat-combo-opt.active { background: var(--accent-bg); color: #0550ae; }
  .cat-combo-empty { padding: 14px 10px; text-align: center; font-size: 12px; color: var(--text-muted); }
  .direct-hint { margin-top: 4px; font-size: 11px; color: var(--green); font-weight: 600; min-height: 0; }

  .unrec-row {
    display: grid;
    grid-template-columns: 200px minmax(220px, 1fr) minmax(300px, 38%);
    gap: 14px;
    align-items: start;
    padding: 12px 14px;
    border-top: 1px solid var(--border-soft);
    border-left: 3px solid var(--amber);
    background: rgba(217, 119, 6, 0.04);
  }
  .unrec-row:hover { background: var(--bg-hover); }
  .unrec-row.has-note { background: rgba(26, 127, 55, 0.05); border-left-color: var(--green); }
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
  .temp-batch-strip {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    margin-bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .temp-batch-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .temp-batch-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .batch-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 99px;
    border: 1px solid var(--border);
    background: var(--bg-soft);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
  }
  .batch-pill:hover { border-color: var(--accent); background: var(--bg-hover); }
  .batch-pill.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }
  .batch-pill-name {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .batch-pill-act {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 3px;
    font-size: 12px;
    line-height: 1;
    border-radius: 4px;
  }
  .batch-pill-act:hover { background: rgba(31, 35, 40, 0.08); color: var(--text); }
  .prop-tabs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }
  .prop-tab {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.12s, background 0.12s;
  }
  .prop-tab:hover { border-color: var(--accent); background: #f8fbff; }
  .prop-tab.active { border-color: var(--accent); background: var(--accent-bg); box-shadow: inset 3px 0 0 var(--accent); }
  .prop-tab-title { font-size: 12px; font-weight: 700; color: var(--text); }
  .prop-tab-num { font-size: 18px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .prop-row {
    display: grid;
    grid-template-columns: 195px minmax(220px, 1fr) minmax(270px, 34%);
    gap: 14px;
    align-items: start;
    padding: 12px 14px;
    border-top: 1px solid var(--border-soft);
    transition: background 0.1s;
  }
  .prop-row:hover { background: #f5f8fc; }
  .prop-row.dec-accept { background: rgba(26, 127, 55, 0.06); box-shadow: inset 4px 0 0 var(--green); }
  .prop-row.dec-override { background: rgba(9, 105, 218, 0.06); box-shadow: inset 4px 0 0 var(--accent); }
  .prop-row.dec-skip { background: var(--bg-soft); opacity: 0.62; }
  @media (max-width: 960px) {
    .prop-row { grid-template-columns: 1fr; }
  }
  .prop-suggest-box {
    margin-top: 6px;
    padding: 6px 9px;
    border-radius: 7px;
    background: var(--bg-soft);
    border: 1px solid var(--border-soft);
    font-size: 12px;
  }
  .prop-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }
  .prop-custom-row {
    display: flex;
    gap: 5px;
    align-items: center;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--border-soft);
  }
  .prop-custom-major { width: 78px; flex-shrink: 0; height: 28px; padding: 0 22px 0 7px; background-position: right 7px center; }
  .prop-custom-minor { flex: 1; min-width: 0; height: 28px; padding: 3px 8px; font-size: 12px; border-radius: 6px; }
  .prop-custom-minor.filled { border-color: var(--accent); background: var(--accent-bg); font-weight: 600; }
  .prop-divider { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 11.5px; margin: 2px 0; }
  .prop-divider::before, .prop-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
  .commit-list {
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--bg-soft);
    font-size: 12px;
    line-height: 1.7;
  }
  .batch-rename-input {
    height: 28px;
    padding: 2px 8px;
    font-size: 12px;
    border: 1.5px solid var(--accent);
    border-radius: 99px;
    min-width: 180px;
  }

  .float-bar {
    position: fixed;
    left: 312px;
    bottom: 18px;
    background: var(--bg-elev);
    border: 1.5px solid var(--accent);
    border-radius: 12px;
    padding: 8px 14px;
    display: none;
    gap: 8px;
    align-items: center;
    box-shadow: var(--shadow);
    z-index: 35;
    flex-wrap: wrap;
  }
  .float-bar.show { display: flex; }
  .info-wrap { position: relative; display: inline-flex; align-items: center; gap: 4px; }
  .info-btn {
    width: 22px;
    height: 22px;
    border-radius: 99px;
    border: 1px solid var(--border);
    background: var(--bg-soft);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 700;
    font-family: Georgia, serif;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .info-btn:hover, .info-btn.active { border-color: var(--purple); color: var(--purple); background: var(--purple-bg); }
  .info-pop {
    position: absolute;
    left: 0;
    bottom: calc(100% + 10px);
    width: 340px;
    max-width: calc(100vw - 40px);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.16);
    z-index: 60;
    display: none;
    font-size: 12px;
    line-height: 1.55;
    color: var(--text);
  }
  .info-pop.show { display: block; }
  .info-pop-title { font-weight: 700; font-size: 13px; margin-bottom: 6px; color: var(--purple); display: flex; align-items: center; justify-content: space-between; }
  .info-pop ul { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 5px; }
  .info-pop code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; background: var(--bg-soft); padding: 1px 4px; border-radius: 4px; }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 55;
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
    z-index: 65;
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
      </div>
      <div class="sb-nav-actions">
        <a class="btn sm" id="btn-hub" href="./review.html" style="justify-content:center;text-decoration:none" title="返回專案空間切換其他專案">← 專案空間</a>
        <button class="btn sm" style="flex:1;justify-content:center" id="btn-home">總覽看板</button>
      </div>
      <div class="seg">
        <button id="seg-cats" data-sb="categories">分類</button>
        <button id="seg-pages" data-sb="pages">頁面</button>
        <button id="seg-fams" data-sb="families">AST</button>
      </div>
      <div id="sb-source-picker" class="sb-source-picker" style="display:none"></div>
      <input class="sb-search" id="sb-filter" placeholder="篩選分類名稱...">
    </div>
    <div class="sb-scroll" id="sb-list"></div>
    <div class="sb-foot">
      <div class="cat-item" id="btn-sync-diff-view" style="margin-bottom:4px">
        <span class="cat-name">最近同步變更</span>
        <span class="pill" id="sb-sync-diff-badge">0</span>
      </div>
      <div class="cat-item" id="btn-proposals-view" style="margin-bottom:4px">
        <span class="cat-name">Agent 預分類驗收</span>
        <span class="pill accent" id="sb-proposals-badge">0</span>
      </div>
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
      <button class="btn" id="btn-direct-commit" type="button" title="將已標註的確定標準分類寫入標註檔並重建頁面">重建頁面 (0)</button>
      <button class="btn primary" id="btn-prompt">複製為 Agent 提示詞 (0)</button>
      <div class="menu-wrap">
        <button class="btn" id="btn-top-menu" type="button" title="更多設定與操作">⋯</button>
        <div class="menu-pop" id="top-menu-pop">
          <button class="menu-item" id="menu-show-spec" type="button">檢視畫布識別規則</button>
          <button class="menu-item danger" id="menu-clear-all" type="button">清空所有意見</button>
        </div>
      </div>
    </header>
    <main class="content" id="content"></main>
  </div>

  <div class="float-bar" id="float-bar">
    <span class="pill solid-blue" id="sel-stat">已選 0 筆</span>
    <button class="btn sm primary" id="btn-batch-selected">批量標註</button>
    <button class="btn sm accent" id="btn-focus-selected">在 Figma 選中</button>
    <div class="info-wrap">
      <button class="btn sm" id="btn-stage-selected" type="button" style="border-color:#8250df;color:#8250df;background:#f5f0ff">生成臨時拼板</button>
      <button class="info-btn" id="btn-stage-info" type="button" title="什麼是臨時拼板？" aria-label="臨時拼板功能說明">i</button>
      <div class="info-pop" id="stage-info-pop">
        <div class="info-pop-title">什麼是「生成臨時拼板」？</div>
        <ul>
          <li><strong>整齊預覽：</strong>在 Figma 空白處建一個 <code>[Rea 臨時預覽 · 可刪除]</code> Section，把分散的畫面複製排成整齊網格，方便一次人眼走查。</li>
          <li><strong>精準對應原稿：</strong>每個副本都寫入隱藏的原稿 ID（不改圖層名、不動原稿）。預覽時框選有問題的副本，按插件「查找選中項」就會自動對應回真正原稿。</li>
          <li><strong>零殘留：</strong>看完直接刪掉該 Section（或點插件「清理臨時拼板」），對原本設計稿零影響。</li>
        </ul>
      </div>
    </div>
    <button class="btn sm ghost" id="btn-copy-ids">複製 ID</button>
    <button class="btn sm" id="btn-sel-clear">取消</button>
  </div>

  <div class="modal-backdrop" id="modal">
    <div class="modal">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <strong>Agent 提示詞預覽（已嘗試複製到剪貼簿，可直接貼回對話）</strong>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer" title="自動排除上次已複製且內容未再改動的舊意見">
            <input type="checkbox" id="only-unsent" checked> 僅含本次新增／修改意見
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="checkbox" id="include-scope" checked> 附帶已核對範圍摘要
          </label>
        </div>
      </div>
      <textarea id="modal-text" readonly></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center">
        <button class="btn ghost" id="modal-clear-exported" type="button" style="margin-right:auto;display:none">清空已複製舊意見</button>
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
      <div class="cat-combo">
        <input id="batch-cat-select" class="cat-combo-input" data-combo-kind="batch" autocomplete="off" placeholder="搜尋或下拉選擇標準分類（支援簡繁，如：弹窗）…">
        <button type="button" class="cat-combo-clear" data-clear-combo="batch-cat-select" title="清除">✕</button>
      </div>
      <textarea id="batch-input" style="height:100px" placeholder="輸入或由上方搜尋選擇標準分類（例：新UI / 收銀台、老UI / 廢棄、系統UI / 系統彈窗）"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn" id="batch-cancel">取消</button>
        <button class="btn primary" id="batch-apply">確認標註</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="commit-modal">
    <div class="modal" style="width:min(540px,100%)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong>確認寫入正式分類（labels/screens-v2.json）</strong>
        <span class="pill green" id="commit-count">0 筆</span>
      </div>
      <div class="muted">以下為本次你已採納或改選的標準分類統計，確認後將直接更新標註檔並自動重建看板：</div>
      <div class="commit-list" id="commit-summary"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost" id="commit-copy-fallback" type="button" style="margin-right:auto">複製為 Agent 落盤指令</button>
        <button class="btn" id="commit-cancel" type="button">取消</button>
        <button class="btn primary" id="commit-confirm-direct" type="button">確定直接落盤並刷新</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="prop-group-modal">
    <div class="modal" style="width:min(480px,100%)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <strong id="prop-grp-title">整組改分類</strong>
        <span class="pill accent" id="prop-grp-count">0 筆</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label class="muted" for="prop-grp-sel">方式一：搜尋／選擇現有標準分類</label>
        <div class="cat-combo">
          <input id="prop-grp-sel" class="cat-combo-input" data-combo-kind="prop-grp" autocomplete="off" placeholder="搜尋或下拉選擇現有標準分類（支援簡繁，如：弹窗）…">
          <button type="button" class="cat-combo-clear" data-clear-combo="prop-grp-sel" title="清除">✕</button>
        </div>
      </div>
      <div class="prop-divider">或方式二：輸入自訂新分類（獨立於下拉）</div>
      <div style="display:flex;gap:6px;align-items:center">
        <select id="prop-grp-custom-major" class="cat-select" style="width:92px;flex-shrink:0">
          <option value="新UI">新UI</option>
          <option value="老UI">老UI</option>
          <option value="系統UI">系統UI</option>
        </select>
        <input id="prop-grp-custom-minor" style="flex:1;height:30px" placeholder="輸入新分類名稱（例：錢包頁）">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
        <button class="btn" id="prop-grp-cancel" type="button">取消</button>
        <button class="btn primary" id="prop-grp-apply" type="button">套用到本組</button>
      </div>
    </div>
  </div>

  <datalist id="all-cat-options"></datalist>
  <div id="cat-combo-menu" role="listbox"></div>
  <div class="toast" id="toast"></div>

<script>
const DATA = ${payload};
${buildInlineSearchZhJs()}
const STORAGE_KEY = 'rea-figma-workbench::' + (DATA.projectId || DATA.db) + '::' + DATA.modeLabel;
const MAJOR_ORDER = Array.isArray(DATA.majorOrder) && DATA.majorOrder.length > 0 ? DATA.majorOrder : ['新UI', '老UI', '系統UI', '未標註'];
const CAT_COLORS = ['#0969da', '#1a7f37', '#8250df', '#d97706', '#cf222e', '#0891b2', '#4f46e5', '#64748b'];

let sbMode = DATA.defaultSidebarMode || 'categories';
let viewMode = DATA.autoSelectMode || 'overview'; // 'overview' | 'category' | 'page' | 'family' | 'subset' | 'figma-lookup' | 'commented'
let activeKey = DATA.autoSelectCategory || '';
const expandedMajors = new Set(MAJOR_ORDER);
const expandedOverviewMajors = new Set(['新UI', '系統UI']);
const expandedPages = new Set();
const selected = new Set();
let lastClickedId = '';
let focusedNodeId = '';
let activePageSourceId = '';
let detailFilter = { q: '', arch: '', gen: '', source: '', onlyCommented: false };
let pendingBatch = null;
// Temporary in-memory Figma lookup batches (never persisted to localStorage)
let lookupBatches = [];
let activeBatchId = '';
let lookupBatchSeq = 0;
let renamingBatchId = '';
let propFilter = 'all';
let propGroupBy = 'target';
let pendingCommitItems = [];
let pendingCommitContext = { mode: 'proposals', sourceItemKeys: [] };
let pendingPropGroupKey = '';
const lastSyncAddedSet = new Set(
  ((DATA.lastSync && !DATA.lastSync.isInitialImport && Array.isArray(DATA.lastSync.addedScreens)) ? DATA.lastSync.addedScreens : [])
    .map(function(s) { return s.id; })
);

function getActiveLookupBatch() {
  if (activeBatchId) {
    const found = lookupBatches.find(function(b) { return b.batchId === activeBatchId; });
    if (found) return found;
  }
  return lookupBatches.length > 0 ? lookupBatches[lookupBatches.length - 1] : null;
}

function emptyExported() {
  return { categories: {}, families: {}, items: {}, unrecorded: {} };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { categories: {}, families: {}, items: {}, unrecorded: {}, proposals: {}, exported: emptyExported() };
    const p = JSON.parse(raw);
    const exp = p.exported || {};
    return {
      categories: p.categories || {},
      families: p.families || {},
      items: p.items || {},
      unrecorded: p.unrecorded || {},
      proposals: p.proposals || {},
      exported: {
        categories: exp.categories || {},
        families: exp.families || {},
        items: exp.items || {},
        unrecorded: exp.unrecorded || {}
      }
    };
  } catch (e) {
    return { categories: {}, families: {}, items: {}, unrecorded: {}, proposals: {}, exported: emptyExported() };
  }
}
const state = loadState();
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  updateCommentCounters();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
  });
}
let toastTimer = null;
function toast(msg, durationMs) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.remove('show'); }, durationMs || 1800);
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

function stripCompositeId(id) {
  const s = String(id || '');
  const idx = s.indexOf('::');
  if (idx === -1) return { sourceId: '', rawId: s };
  return { sourceId: s.slice(0, idx), rawId: s.slice(idx + 2) };
}

function rawNodeId(id) {
  return stripCompositeId(id).rawId;
}

function isMatchingFigmaForSource(fileKey, fileName) {
  if (!bridgeStatus.figma_connected) return false;
  const clients = Array.isArray(bridgeStatus.figma_clients) && bridgeStatus.figma_clients.length > 0
    ? bridgeStatus.figma_clients
    : [{ file_key: bridgeStatus.figma_file_key, file_name: bridgeStatus.figma_file_name }];
  return clients.some(function(c) {
    if (!c) return false;
    if (c.file_key && c.file_key !== '0:0' && fileKey && fileKey !== '0:0' && c.file_key === fileKey) return true;
    if (c.file_name && fileName && c.file_name === fileName) return true;
    return false;
  });
}

function isMatchingFigma() {
  if (DATA.isWorkspace && Array.isArray(DATA.sources) && DATA.sources.length > 0) {
    return DATA.sources.some(function(s) { return isMatchingFigmaForSource(s.fileKey, s.fileName); });
  }
  return isMatchingFigmaForSource(DATA.fileKey, DATA.fileName);
}

function collectBridgeTarget(cards, onlyPageId) {
  const list = Array.isArray(cards) ? cards : [];
  const srcIds = new Set();
  const srcNames = new Set();
  let targetFileKey = DATA.fileKey || '';
  let targetFileName = DATA.fileName || '';
  list.forEach(function(c) {
    if (!c) return;
    const sid = c.sourceId || stripCompositeId(c.id).sourceId || DATA.projectId || '';
    if (sid) srcIds.add(sid);
    if (c.sourceName) srcNames.add(c.sourceName);
    if (c.sourceFileKey) targetFileKey = c.sourceFileKey;
    if (c.sourceName) targetFileName = c.sourceName;
  });
  if (DATA.isWorkspace && srcIds.size > 1) {
    return {
      error: '所選項目跨 ' + srcIds.size + ' 個來源 Figma 檔案（' + Array.from(srcNames).join('、') + '），請切換到單一來源篩選後再同步到 Figma'
    };
  }
  const compositeIds = collectMemberIds(list, onlyPageId);
  const rawIds = compositeIds.map(rawNodeId);
  const rawPageId = onlyPageId ? rawNodeId(onlyPageId) : '';
  return {
    rawIds: rawIds,
    rawPageId: rawPageId,
    fileKey: targetFileKey,
    fileName: targetFileName
  };
}

function updateBridgePill() {
  const pill = document.getElementById('bridge-pill');
  if (!pill) return;
  if (!bridgeWsOpen) {
    pill.className = 'pill';
    pill.textContent = '○ 離線模式（可用複製 ID）';
    return;
  }
  if (bridgeStatus.figma_connected) {
    if (isMatchingFigma() || (!DATA.fileName && !DATA.isWorkspace)) {
      pill.className = 'pill green';
      pill.textContent = '● Figma 已連線' + (bridgeStatus.figma_file_name ? ' · ' + bridgeStatus.figma_file_name : '');
    } else {
      pill.className = 'pill amber';
      pill.textContent = '⚠ Figma 開啟了「' + (bridgeStatus.figma_file_name || '其他檔案') + '」';
    }
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
      bridgeWs.send(JSON.stringify({
        type: 'BRIDGE_HELLO',
        payload: {
          role: 'review-ui',
          project_id: DATA.projectId || undefined,
          file_key: DATA.fileKey || undefined,
          file_name: DATA.fileName || undefined,
          source_files: (DATA.isWorkspace && Array.isArray(DATA.sources))
            ? DATA.sources.map(function(s) { return { file_key: s.fileKey || undefined, file_name: s.fileName || undefined }; })
            : undefined
        }
      }));
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
      if (sbMode === 'pages' && DATA.isWorkspace) renderSidebar();
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
          const hasMiss = Boolean(r.missing_ids && r.missing_ids.length);
          const missNote = hasMiss ? '（另有 ' + r.missing_ids.length + ' 筆在 Figma 找不到，可能已刪除，建議在插件對該頁做單頁增量匯出）' : '';
          toast('已定位到「' + (r.page_name || '') + '」· 選中 ' + (r.selected_count || 0) + ' 個節點' + missNote, hasMiss ? 4500 : 1800);
        }
      } else {
        toast(r.error || 'Figma 定位失敗', 4200);
      }
      return;
    }
    if (msg.type === 'BRIDGE_STAGE_RESULT' && msg.payload) {
      bridgeBusy = false;
      if (bridgeBusyTimer) { clearTimeout(bridgeBusyTimer); bridgeBusyTimer = null; }
      const r = msg.payload;
      if (r.ok) {
        const hasMiss = Boolean(r.missing_ids && r.missing_ids.length);
        const missNote = hasMiss ? '（另有 ' + r.missing_ids.length + ' 筆找不到，可能已刪除）' : '';
        toast('已生成臨時拼板「' + (r.section_name || '') + '」· 共 ' + (r.staged_count || 0) + ' 個畫面' + missNote, hasMiss ? 4200 : 2500);
      } else {
        toast(r.error || '生成臨時拼板失敗', 4200);
      }
      return;
    }
    if (msg.type === 'BRIDGE_LOOKUP_SELECTION' && msg.payload) {
      const p = msg.payload;
      const items = Array.isArray(p.items) ? p.items : [];
      const matchedList = [];
      const seenMatchedIds = new Set();
      const unrecordedList = [];
      selected.clear();

      let matchedSrc = null;
      if (DATA.isWorkspace && Array.isArray(DATA.sources)) {
        matchedSrc = DATA.sources.find(function(s) {
          if (s.fileKey && s.fileKey !== '0:0' && p.file_key && p.file_key !== '0:0' && s.fileKey === p.file_key) return true;
          if (s.fileName && p.file_name && s.fileName === p.file_name) return true;
          return false;
        }) || null;
      }
      function toLookupId(rawId) {
        return matchedSrc ? (matchedSrc.id + '::' + rawId) : rawId;
      }

      items.forEach(function(it) {
        if (!it || !it.id) return;
        const fullId = toLookupId(it.id);
        const base = byMemberId[fullId] || byMemberId[it.id] || null;
        if (base) {
          const itemKey = matchedSrc ? fullId : (base.sourceId ? (base.sourceId + '::' + it.id) : it.id);
          if (seenMatchedIds.has(itemKey)) return;
          seenMatchedIds.add(itemKey);
          const matchVia = itemKey === base.id ? 'exact' : 'copy';
          const pgName = it.page_name || p.page_name || base.page || '';
          const pgId = (matchedSrc ? (matchedSrc.id + '::' + (it.page_id || p.page_id || '')) : '') || base.pageId || it.page_id || p.page_id || '';
          const rowCard = {
            id: itemKey,
            rawId: it.id,
            name: it.name || base.name || '(未命名)',
            page: pgName,
            rawPageName: it.page_name || p.page_name || base.rawPageName || base.page || '',
            pageId: pgId,
            rawPageId: it.page_id || p.page_id || base.rawPageId || '',
            pageIndex: base.pageIndex,
            archetype: base.archetype,
            hash: base.hash,
            shortHash: base.shortHash,
            nodes: base.nodes,
            headline: it.text_preview || base.headline || '',
            copies: 1,
            memberIds: [itemKey],
            memberPages: pgName ? [pgName] : [],
            major: base.major,
            minor: base.minor,
            label: base.label,
            generation: base.generation,
            palette: base.palette || [],
            repId: base.id,
            sourceId: (matchedSrc && matchedSrc.id) || base.sourceId || '',
            sourceName: (matchedSrc && matchedSrc.fileName) || base.sourceName || '',
            sourceFileKey: (matchedSrc && matchedSrc.fileKey) || base.sourceFileKey || ''
          };
          lookupCardById[rowCard.id] = rowCard;
          matchedList.push({
            card: rowCard,
            matchVia: matchVia,
            matchedSelectedIds: [it.id],
            selectedName: it.name || ''
          });
          return;
        }

        let ancCard = null;
        if (Array.isArray(it.ancestor_ids)) {
          for (let i = 0; i < it.ancestor_ids.length; i += 1) {
            const ancFull = toLookupId(it.ancestor_ids[i]);
            const hit = byMemberId[ancFull] || byMemberId[it.ancestor_ids[i]];
            if (hit) {
              ancCard = hit;
              break;
            }
          }
        }
        if (ancCard) {
          if (!seenMatchedIds.has(ancCard.id)) {
            seenMatchedIds.add(ancCard.id);
            lookupCardById[ancCard.id] = ancCard;
            matchedList.push({
              card: ancCard,
              matchVia: 'ancestor',
              matchedSelectedIds: [it.id],
              selectedName: it.name || ''
            });
          } else {
            const prevEntry = matchedList.find(function(x) { return x.card.id === ancCard.id; });
            if (prevEntry && prevEntry.matchedSelectedIds.indexOf(it.id) === -1) {
              prevEntry.matchedSelectedIds.push(it.id);
            }
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

      matchedList.forEach(function(m) { selected.add(m.card.id); });
      if (unrecordedList.length > 0) saveState();
      const seqNum = ++lookupBatchSeq;
      const expSections = Array.isArray(p.expanded_from_sections) ? p.expanded_from_sections : [];
      const batchName = expSections.length > 0
        ? ('批次 #' + seqNum + ' · ' + expSections.slice(0, 2).join(' + ') + (expSections.length > 2 ? ' 等' : ''))
        : ('批次 #' + seqNum + ' · ' + (p.page_name || 'Figma 選區'));
      const newBatch = {
        batchId: 'batch-' + seqNum,
        name: batchName,
        pageId: p.page_id || '',
        pageName: p.page_name || '',
        expandedSections: expSections,
        receivedAt: new Date().toISOString(),
        total: items.length,
        matched: matchedList,
        unrecorded: unrecordedList,
        allNodeIds: items.map(function(it) { return it.id; })
      };
      lookupBatches.push(newBatch);
      if (lookupBatches.length > 30) lookupBatches.shift();
      activeBatchId = newBatch.batchId;
      renamingBatchId = '';
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
      toast('已建立臨時「' + newBatch.name + '」（' + items.length + ' 筆）：已收錄 ' + matchedList.length + ' · 未收錄 ' + unrecordedList.length);
    }
  };
}

function requestFigmaFocus(nodeIds, label, opts) {
  const o = opts || {};
  const pageOnly = o.pageOnly === true;
  const cleanIds = Array.isArray(nodeIds) ? nodeIds.map(rawNodeId).filter(Boolean) : [];
  const rawPageId = o.pageId ? rawNodeId(o.pageId) : undefined;
  const targetFileKey = o.fileKey || DATA.fileKey || '';
  const targetFileName = o.fileName || DATA.fileName || '';
  if (cleanIds.length === 0 && !(pageOnly && (rawPageId || label))) {
    toast('沒有可定位的 node_id');
    return;
  }
  if (!bridgeWsOpen || !bridgeWs || bridgeWs.readyState !== 1 || !bridgeStatus.figma_connected) {
    toast('Figma 尚未連線：請先啟動 npm run start:server 並開啟 Figma 插件（或改用複製 ID）');
    return;
  }
  if (targetFileName && !isMatchingFigmaForSource(targetFileKey, targetFileName)) {
    toast('目前 Figma 開啟的是「' + (bridgeStatus.figma_file_name || '其他檔案') + '」，與目標檔案「' + targetFileName + '」不符');
    return;
  }
  if (!targetFileName && DATA.isWorkspace && !isMatchingFigma()) {
    toast('目前 Figma 開啟的是「' + (bridgeStatus.figma_file_name || '其他檔案') + '」，與目前應用組合檔案不符');
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
  toast((pageOnly ? '正在跳轉到頁面「' : '正在定位「') + (label || cleanIds[0]) + '」…');
  bridgeWs.send(JSON.stringify({
    type: 'BRIDGE_FOCUS_NODES',
    payload: {
      request_id: reqId,
      node_ids: cleanIds,
      project_id: DATA.projectId || undefined,
      file_key: targetFileKey || undefined,
      file_name: targetFileName || undefined,
      page_id: rawPageId || undefined,
      page_name: label || undefined,
      page_only: pageOnly ? true : undefined
    }
  }));
}

function requestFigmaStageBoard(nodeIds, title, opts) {
  const o = opts || {};
  const list = Array.isArray(nodeIds) ? nodeIds.map(rawNodeId).filter(Boolean) : [];
  const targetPageId = o.targetPageId ? rawNodeId(o.targetPageId) : undefined;
  const targetFileKey = o.fileKey || DATA.fileKey || '';
  const targetFileName = o.fileName || DATA.fileName || '';
  if (list.length === 0) {
    toast('沒有可加入臨時拼板的 node_id');
    return;
  }
  if (!bridgeWsOpen || !bridgeWs || bridgeWs.readyState !== 1 || !bridgeStatus.figma_connected) {
    toast('Figma 尚未連線：請先啟動 npm run start:server 並開啟 Figma 插件');
    return;
  }
  if (targetFileName && !isMatchingFigmaForSource(targetFileKey, targetFileName)) {
    toast('目前 Figma 開啟的是「' + (bridgeStatus.figma_file_name || '其他檔案') + '」，與目標檔案「' + targetFileName + '」不符');
    return;
  }
  if (!targetFileName && DATA.isWorkspace && !isMatchingFigma()) {
    toast('目前 Figma 開啟的是「' + (bridgeStatus.figma_file_name || '其他檔案') + '」，與目前應用組合檔案不符');
    return;
  }
  if (bridgeBusy) {
    toast('上一次 Figma 操作仍在執行，請稍候');
    return;
  }
  let sendIds = list;
  if (sendIds.length > 120) {
    if (!confirm('目前已選 ' + sendIds.length + ' 個畫面，臨時拼板單次最多複製前 120 個畫面，是否繼續生成？')) return;
    sendIds = sendIds.slice(0, 120);
  } else if (sendIds.length > 60) {
    if (!confirm('將在 Figma 空白處生成包含 ' + sendIds.length + ' 個畫面副本的臨時預覽拼板，是否繼續？')) return;
  }
  const reqId = 'stage-' + Date.now() + '-' + (++bridgeSeq);
  bridgeBusy = true;
  if (bridgeBusyTimer) clearTimeout(bridgeBusyTimer);
  bridgeBusyTimer = setTimeout(function() {
    bridgeBusy = false;
    bridgeBusyTimer = null;
  }, 30000);
  toast('正在 Figma 生成臨時拼板（' + sendIds.length + ' 個畫面）…');
  bridgeWs.send(JSON.stringify({
    type: 'BRIDGE_STAGE_BOARD',
    payload: {
      request_id: reqId,
      node_ids: sendIds,
      title: title || '選中畫面',
      project_id: DATA.projectId || undefined,
      file_key: targetFileKey || undefined,
      file_name: targetFileName || undefined,
      target_page_id: targetPageId || undefined
    }
  }));
}

const byId = {};
const byMemberId = {};
let lookupCardById = {};

(DATA.pageCards || DATA.cards || []).forEach(function(c) {
  byId[c.id] = c;
  byMemberId[c.id] = c;
  (c.memberIds || []).forEach(function(mid) { byMemberId[mid] = c; });
});
if (DATA.isSampled) {
  DATA.cards.forEach(function(c) {
    if (!byId[c.id]) byId[c.id] = c;
    if (!byMemberId[c.id]) byMemberId[c.id] = c;
    (c.memberIds || []).forEach(function(mid) { if (!byMemberId[mid]) byMemberId[mid] = c; });
  });
}

function resolveCardForId(id) {
  if (lookupCardById[id]) return lookupCardById[id];
  if (byId[id]) return byId[id];
  const base = byMemberId[id];
  if (!base) return null;
  const parsed = stripCompositeId(id);
  const synth = {
    id: id,
    rawId: parsed.rawId,
    name: base.name,
    page: base.page,
    rawPageName: base.rawPageName || base.page || '',
    pageId: base.pageId,
    rawPageId: base.rawPageId || rawNodeId(base.pageId || ''),
    pageIndex: base.pageIndex,
    archetype: base.archetype,
    hash: base.hash,
    shortHash: base.shortHash,
    nodes: base.nodes,
    headline: base.headline,
    copies: 1,
    memberIds: [id],
    memberPages: base.page ? [base.page] : [],
    major: base.major,
    minor: base.minor,
    label: base.label,
    generation: base.generation,
    palette: base.palette || [],
    repId: base.id,
    sourceId: base.sourceId || parsed.sourceId || '',
    sourceName: base.sourceName || '',
    sourceFileKey: base.sourceFileKey || ''
  };
  lookupCardById[id] = synth;
  return synth;
}

const workCards = (!DATA.isSampled && Array.isArray(DATA.pageCards) && DATA.pageCards.length > 0) ? DATA.pageCards : DATA.cards;

// Aggregate Categories, AST Families, and Figma Pages from strictly single-page cards
const catMap = new Map();
const majorAgg = new Map();
const famMap = new Map();
const figmaPageMap = new Map();

workCards.forEach(function(c) {
  const maj = c.major || '未標註';
  const min = c.major ? (c.minor || '(未細分)') : 'AST 待歸類';
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

(DATA.pageCards || DATA.cards).forEach(function(c) {
  const pg = c.page || '(未知頁面)';
  if (!figmaPageMap.has(pg)) {
    figmaPageMap.set(pg, {
      page: pg,
      rawPageName: c.rawPageName || pg,
      pageId: c.pageId || '',
      pageIndex: typeof c.pageIndex === 'number' ? c.pageIndex : 9999,
      sourceId: c.sourceId || '',
      sourceName: c.sourceName || '',
      sourceFileKey: c.sourceFileKey || '',
      cards: [],
      totalScreens: 0,
      labeledScreens: 0,
      unlabeledScreens: 0,
      catCount: new Map(),
      paletteCount: new Map()
    });
  }
  const pRec = figmaPageMap.get(pg);
  pRec.cards.push(c);
  pRec.totalScreens += c.copies;
  if (c.major) pRec.labeledScreens += c.copies;
  else pRec.unlabeledScreens += c.copies;
  const cLabel = c.major ? (c.major + (c.minor ? ' / ' + c.minor : '')) : '未標註';
  pRec.catCount.set(cLabel, (pRec.catCount.get(cLabel) || 0) + c.copies);
  (c.palette || []).forEach(function(hx) { pRec.paletteCount.set(hx, (pRec.paletteCount.get(hx) || 0) + 1); });
});

const sortedFigmaPages = Array.from(figmaPageMap.values()).sort(function(a, b) {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  return b.totalScreens - a.totalScreens;
});

const sourceStatsById = new Map();
if (DATA.isWorkspace && Array.isArray(DATA.sources)) {
  DATA.sources.forEach(function(s) {
    sourceStatsById.set(s.id, {
      id: s.id,
      fileName: s.fileName || s.id,
      fileKey: s.fileKey || '',
      totalScreens: 0,
      unlabeledScreens: 0,
      pageCount: 0
    });
  });
  sortedFigmaPages.forEach(function(p) {
    if (!p.sourceId || !sourceStatsById.has(p.sourceId)) return;
    const st = sourceStatsById.get(p.sourceId);
    st.pageCount += 1;
    st.totalScreens += p.totalScreens;
    st.unlabeledScreens += p.unlabeledScreens;
  });
  if (DATA.sources.length > 0) {
    const withUnlabeled = DATA.sources.find(function(s) {
      const st = sourceStatsById.get(s.id);
      return st && st.unlabeledScreens > 0;
    });
    activePageSourceId = withUnlabeled ? withUnlabeled.id : DATA.sources[0].id;
  }
}

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
  const coreDefaults = [
    '新UI', '新UI / 廢棄',
    '老UI', '老UI / 廢棄',
    '系統UI', '系統UI / 系統彈窗', '系統UI / 系統短信'
  ];
  const byMajor = new Map();
  const seen = new Set();
  const countByLabel = new Map();
  function addOpt(label, maj, cnt) {
    if (!label) return;
    if (typeof cnt === 'number' && cnt > 0) countByLabel.set(label, cnt);
    if (seen.has(label)) return;
    seen.add(label);
    const m = maj || label.split(' / ')[0];
    if (!byMajor.has(m)) byMajor.set(m, []);
    byMajor.get(m).push(label);
  }
  coreDefaults.forEach(function(lbl) { addOpt(lbl); });
  sortedMajors.forEach(function(mRec) {
    if (mRec.major === '未標註') return;
    addOpt(mRec.major, mRec.major, mRec.screens);
    const minors = Array.from(mRec.minors.values()).sort(function(a, b) { return b.totalScreens - a.totalScreens; });
    minors.forEach(function(r) {
      const lbl = (r.minor && r.minor !== '(未細分)') ? (r.major + ' / ' + r.minor) : r.major;
      addOpt(lbl, r.major, r.totalScreens);
    });
  });
  window.__canonicalCatSet = seen;
  const allOpts = Array.from(seen);
  if (dl) {
    dl.innerHTML = allOpts.map(function(o) { return '<option value="' + esc(o) + '"></option>'; }).join('');
  }
  const order = Array.from(byMajor.keys()).sort(function(a, b) {
    const ia = MAJOR_ORDER.indexOf(a);
    const ib = MAJOR_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  let groupsHtml = '';
  const groupsData = [];
  order.forEach(function(maj) {
    const list = byMajor.get(maj) || [];
    groupsHtml += '<optgroup label="' + esc(maj) + '">' +
      list.map(function(o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
      '</optgroup>';
    groupsData.push({
      major: maj,
      items: list.map(function(o) { return { value: o, count: countByLabel.get(o) || 0 }; })
    });
  });
  window.__catSelectGroupsHtml = groupsHtml;
  window.__canonicalCatGroups = groupsData;
})();

let comboActiveInput = null;
let comboFlatItems = [];
let comboHighlightIdx = 0;

function positionCatComboMenu(inp) {
  const menu = document.getElementById('cat-combo-menu');
  if (!menu || !inp) return;
  const r = inp.getBoundingClientRect();
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const width = Math.max(r.width, 280);
  const left = Math.max(8, Math.min(r.left, vw - width - 8));
  menu.style.width = width + 'px';
  menu.style.left = left + 'px';
  const spaceBelow = vh - r.bottom - 10;
  const spaceAbove = r.top - 10;
  if (spaceBelow < 210 && spaceAbove > spaceBelow) {
    menu.style.top = 'auto';
    menu.style.bottom = (vh - r.top + 4) + 'px';
    menu.style.maxHeight = Math.max(140, Math.min(290, spaceAbove)) + 'px';
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.maxHeight = Math.max(140, Math.min(290, spaceBelow)) + 'px';
  }
}

function closeCatComboMenu() {
  const menu = document.getElementById('cat-combo-menu');
  if (menu) menu.style.display = 'none';
  comboActiveInput = null;
  comboFlatItems = [];
  comboHighlightIdx = 0;
}

function renderCatComboMenu(inp, queryText) {
  const menu = document.getElementById('cat-combo-menu');
  if (!menu || !inp) return;
  comboActiveInput = inp;
  const q = String(queryText == null ? inp.value : queryText).trim();
  const groups = Array.isArray(window.__canonicalCatGroups) ? window.__canonicalCatGroups : [];
  const filteredGroups = [];
  comboFlatItems = [];
  groups.forEach(function(g) {
    const matched = q ? g.items.filter(function(it) { return matchesSearch(it.value, q); }) : g.items;
    if (matched.length === 0) return;
    filteredGroups.push({ major: g.major, items: matched });
    matched.forEach(function(it) { comboFlatItems.push(it); });
  });
  if (comboHighlightIdx >= comboFlatItems.length) comboHighlightIdx = 0;
  if (comboHighlightIdx < 0) comboHighlightIdx = 0;

  let html = '<div class="cat-combo-meta">' +
    '<span>' + (q ? ('找到 ' + comboFlatItems.length + ' 個相關分類') : ('共 ' + comboFlatItems.length + ' 個標準分類（可直接打字搜尋）')) + '</span>' +
    '<span>↑↓ 選擇 · Enter 確認</span>' +
    '</div>';
  if (comboFlatItems.length === 0) {
    html += '<div class="cat-combo-empty">找不到與「' + esc(q) + '」相符的標準分類</div>';
  } else {
    let idx = 0;
    filteredGroups.forEach(function(g) {
      html += '<div class="cat-combo-grp">' + esc(g.major) + '</div>';
      g.items.forEach(function(it) {
        const isAct = idx === comboHighlightIdx;
        html += '<div class="cat-combo-opt' + (isAct ? ' active' : '') + '" data-combo-idx="' + idx + '" data-val="' + esc(it.value) + '">' +
          '<span>' + esc(it.value) + '</span>' +
          (it.count > 0 ? '<span class="pill">' + it.count + '</span>' : '') +
          '</div>';
        idx += 1;
      });
    });
  }
  menu.innerHTML = html;
  menu.style.display = 'block';
  positionCatComboMenu(inp);
}

function selectCatComboValue(inp, val) {
  if (!inp || !val) return;
  const kind = inp.getAttribute('data-combo-kind') || '';
  if (kind === 'batch') {
    inp.value = val;
    inp.setAttribute('data-selected-val', val);
    inp.classList.add('filled');
    closeCatComboMenu();
    const ta = document.getElementById('batch-input');
    if (ta) {
      ta.value = val;
      ta.focus();
    }
    return;
  }
  if (kind === 'quick') {
    inp.value = val;
    closeCatComboMenu();
    applyQuickCat(inp);
    return;
  }
  if (kind === 'prop-override') {
    const id = inp.getAttribute('data-prop-override-id');
    closeCatComboMenu();
    if (!id) return;
    if (!state.proposals) state.proposals = {};
    state.proposals[id] = { decision: 'override', target: val };
    saveState();
    renderAll();
    toast('已改選標準分類：' + val);
    return;
  }
  if (kind === 'prop-grp') {
    inp.value = val;
    inp.setAttribute('data-selected-val', val);
    inp.classList.add('filled');
    const customInp = document.getElementById('prop-grp-custom-minor');
    if (customInp) customInp.value = '';
    closeCatComboMenu();
  }
}

function restoreUnpickedComboInput(inp) {
  if (!inp) return;
  const kind = inp.getAttribute('data-combo-kind') || '';
  if (kind === 'quick') {
    inp.value = '';
    return;
  }
  const prev = inp.getAttribute('data-selected-val') || '';
  if (inp.value !== prev) {
    inp.value = prev;
    inp.classList.toggle('filled', Boolean(prev));
  }
}

document.addEventListener('focusin', function(ev) {
  const inp = ev.target && ev.target.closest ? ev.target.closest('.cat-combo-input') : null;
  if (!inp) return;
  comboHighlightIdx = 0;
  const committed = inp.getAttribute('data-selected-val') || '';
  const initialQuery = (committed && inp.value === committed) ? '' : inp.value;
  renderCatComboMenu(inp, initialQuery);
  if (committed && inp.value === committed && inp.select) {
    try { inp.select(); } catch (e) {}
  }
});

document.addEventListener('input', function(ev) {
  const inp = ev.target && ev.target.closest ? ev.target.closest('.cat-combo-input') : null;
  if (!inp) return;
  inp.classList.remove('filled');
  comboHighlightIdx = 0;
  renderCatComboMenu(inp, inp.value);
});

document.addEventListener('keydown', function(ev) {
  const inp = ev.target && ev.target.closest ? ev.target.closest('.cat-combo-input') : null;
  if (!inp) return;
  const menu = document.getElementById('cat-combo-menu');
  const isOpen = Boolean(menu && menu.style.display === 'block' && comboActiveInput === inp);
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (!isOpen) { renderCatComboMenu(inp, ''); return; }
    if (comboFlatItems.length > 0) {
      comboHighlightIdx = (comboHighlightIdx + 1) % comboFlatItems.length;
      renderCatComboMenu(inp, inp.value);
      const act = menu.querySelector('.cat-combo-opt.active');
      if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!isOpen) { renderCatComboMenu(inp, ''); return; }
    if (comboFlatItems.length > 0) {
      comboHighlightIdx = (comboHighlightIdx - 1 + comboFlatItems.length) % comboFlatItems.length;
      renderCatComboMenu(inp, inp.value);
      const act = menu.querySelector('.cat-combo-opt.active');
      if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (ev.key === 'Enter') {
    if (isOpen && comboFlatItems.length > 0) {
      ev.preventDefault();
      const picked = comboFlatItems[comboHighlightIdx] || comboFlatItems[0];
      if (picked) selectCatComboValue(inp, picked.value);
    }
    return;
  }
  if (ev.key === 'Escape') {
    if (isOpen) {
      ev.preventDefault();
      ev.stopPropagation();
      restoreUnpickedComboInput(inp);
      closeCatComboMenu();
    }
  }
});

document.addEventListener('mousedown', function(ev) {
  const menu = document.getElementById('cat-combo-menu');
  if (!menu) return;
  const opt = ev.target && ev.target.closest ? ev.target.closest('#cat-combo-menu .cat-combo-opt') : null;
  if (opt) {
    ev.preventDefault();
    const val = opt.getAttribute('data-val') || '';
    if (comboActiveInput && val) selectCatComboValue(comboActiveInput, val);
    return;
  }
  if (ev.target && ev.target.closest && (ev.target.closest('#cat-combo-menu') || ev.target.closest('.cat-combo'))) {
    return;
  }
  if (comboActiveInput) {
    restoreUnpickedComboInput(comboActiveInput);
    closeCatComboMenu();
  }
});

document.addEventListener('click', function(ev) {
  const clr = ev.target && ev.target.closest ? ev.target.closest('.cat-combo-clear') : null;
  if (clr) {
    ev.stopPropagation();
    const propId = clr.getAttribute('data-clear-prop-override');
    if (propId) {
      if (state.proposals && state.proposals[propId]) {
        delete state.proposals[propId];
        saveState();
        renderAll();
      }
      closeCatComboMenu();
      return;
    }
    const targetId = clr.getAttribute('data-clear-combo');
    const inp = targetId ? document.getElementById(targetId) : null;
    if (!inp) return;
    inp.value = '';
    inp.setAttribute('data-selected-val', '');
    inp.classList.remove('filled');
    if (targetId === 'batch-cat-select') {
      const ta = document.getElementById('batch-input');
      if (ta && window.__canonicalCatSet && window.__canonicalCatSet.has(ta.value.trim())) {
        ta.value = '';
      }
    }
    inp.focus();
    comboHighlightIdx = 0;
    renderCatComboMenu(inp, '');
    return;
  }
  const comboInp = ev.target && ev.target.closest ? ev.target.closest('.cat-combo-input') : null;
  if (comboInp) {
    const menu = document.getElementById('cat-combo-menu');
    if (!menu || menu.style.display !== 'block' || comboActiveInput !== comboInp) {
      comboHighlightIdx = 0;
      const committed = comboInp.getAttribute('data-selected-val') || '';
      renderCatComboMenu(comboInp, (committed && comboInp.value === committed) ? '' : comboInp.value);
    }
  }
});

window.addEventListener('resize', function() {
  if (comboActiveInput) positionCatComboMenu(comboActiveInput);
});
window.addEventListener('scroll', function(ev) {
  const menu = document.getElementById('cat-combo-menu');
  if (!comboActiveInput || !menu || menu.style.display !== 'block') return;
  if (ev.target === menu || (ev.target && menu.contains && menu.contains(ev.target))) return;
  positionCatComboMenu(comboActiveInput);
}, true);

function buildCatSelectOptions(selectedVal, placeholder) {
  let html = '<option value="">' + esc(placeholder || '請選擇標準分類…') + '</option>' + (window.__catSelectGroupsHtml || '');
  if (selectedVal && window.__canonicalCatSet && window.__canonicalCatSet.has(selectedVal)) {
    const needle = 'value="' + esc(selectedVal) + '"';
    html = html.replace(needle, needle + ' selected');
  }
  return html;
}

function buildCustomCategoryTarget(majorVal, rawMinor) {
  const maj = (majorVal || '新UI').trim() || '新UI';
  let min = (rawMinor || '').trim();
  if (!min) return '';
  min = min.replace(/^(新UI|老UI|系統UI)\\s*[/／]\\s*/, '').trim();
  if (!min) return '';
  return maj + ' / ' + min;
}

function parseDirectCategoryNote(rawText) {
  const s = (rawText || '').trim();
  if (!s || s.length > 48) return null;
  if (/[\\r\\n,，。？?!！;；:：、]/.test(s)) return null;
  const norm = s.replace(/\\s*[/／]\\s*/, ' / ');
  if (norm.indexOf('/') !== norm.lastIndexOf('/') || norm.indexOf('／') !== -1) return null;
  if (window.__canonicalCatSet && window.__canonicalCatSet.has(norm)) {
    const p = parseCanonicalTarget(norm);
    return { major: p.major, minor: p.minor, generation: p.generation, target: norm, isCustom: false };
  }
  const m = /^(新UI|老UI|系統UI) [/] ([^/／\\r\\n]{1,32})$/.exec(norm);
  if (!m) return null;
  const major = m[1];
  const minor = m[2].trim();
  if (!minor) return null;
  const generation = major === '老UI' ? 'old' : (major === '系統UI' ? '' : 'new');
  return { major: major, minor: minor, generation: generation, target: major + ' / ' + minor, isCustom: true };
}

function collectDirectLabelCommits(explicitIds, overrideText) {
  const rawPairs = [];
  if (Array.isArray(explicitIds)) {
    const parsed = parseDirectCategoryNote(overrideText);
    if (!parsed) return { commits: [], sourceItemKeys: [], invalidText: true };
    explicitIds.forEach(function(id) {
      if (id) rawPairs.push({ keyId: id, parsed: parsed });
    });
  } else {
    Object.keys(state.items || {}).forEach(function(id) {
      const parsed = parseDirectCategoryNote(state.items[id]);
      if (parsed && resolveCardForId(id)) rawPairs.push({ keyId: id, parsed: parsed });
    });
  }
  const byNodeId = new Map();
  const sourceItemKeys = [];
  rawPairs.forEach(function(entry) {
    sourceItemKeys.push(entry.keyId);
    const card = resolveCardForId(entry.keyId);
    const targetIds = (card && card.copies > 1 && Array.isArray(card.memberIds) && card.memberIds.length > 0)
      ? card.memberIds
      : [entry.keyId];
    targetIds.forEach(function(nid) {
      byNodeId.set(nid, {
        id: nid,
        major: entry.parsed.major,
        minor: entry.parsed.minor,
        generation: entry.parsed.generation
      });
    });
  });
  return { commits: Array.from(byNodeId.values()), sourceItemKeys: sourceItemKeys, invalidText: false };
}

function countCommentsInCards(cards) {
  const counted = new Set();
  cards.forEach(function(c) {
    const ids = (c.memberIds && c.memberIds.length > 0) ? c.memberIds : [c.id];
    ids.forEach(function(mid) {
      if ((state.items[mid] || '').trim()) counted.add(mid);
    });
  });
  return counted.size;
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

function unrecSig(u) {
  return u ? ((u.category || '').trim() + '||' + (u.note || '').trim()) : '';
}

function isExportedUnchanged(kind, key, val) {
  const bucket = state.exported && state.exported[kind];
  if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, key)) return false;
  return bucket[key] === val;
}

function collectCommentSets(onlyUnsent) {
  const catEntries = Object.keys(state.categories).filter(function(k) {
    const val = (state.categories[k] || '').trim();
    if (!val) return false;
    return !onlyUnsent || !isExportedUnchanged('categories', k, val);
  });
  const famEntries = Object.keys(state.families).filter(function(h) {
    const val = (state.families[h] || '').trim();
    if (!val) return false;
    return !onlyUnsent || !isExportedUnchanged('families', h, val);
  });
  const itemIds = Object.keys(state.items).filter(function(id) {
    const val = (state.items[id] || '').trim();
    if (!val || !resolveCardForId(id)) return false;
    return !onlyUnsent || !isExportedUnchanged('items', id, val);
  });
  const unrecIds = activeUnrecordedIds().filter(function(id) {
    const sig = unrecSig(state.unrecorded[id]);
    return !onlyUnsent || !isExportedUnchanged('unrecorded', id, sig);
  });
  return { catEntries: catEntries, famEntries: famEntries, itemIds: itemIds, unrecIds: unrecIds };
}

function countSets(sets) {
  return sets.catEntries.length + sets.famEntries.length + sets.itemIds.length + sets.unrecIds.length;
}

function countUnsentComments() {
  return countSets(collectCommentSets(true));
}

function markSetsAsExported(sets) {
  if (!state.exported) state.exported = emptyExported();
  sets.catEntries.forEach(function(k) { state.exported.categories[k] = (state.categories[k] || '').trim(); });
  sets.famEntries.forEach(function(h) { state.exported.families[h] = (state.families[h] || '').trim(); });
  sets.itemIds.forEach(function(id) { state.exported.items[id] = (state.items[id] || '').trim(); });
  sets.unrecIds.forEach(function(id) { state.exported.unrecorded[id] = unrecSig(state.unrecorded[id]); });
  saveState();
}

function clearExportedOldComments() {
  let removed = 0;
  Object.keys(state.categories).forEach(function(k) {
    const v = (state.categories[k] || '').trim();
    if (v && isExportedUnchanged('categories', k, v)) { delete state.categories[k]; removed += 1; }
  });
  Object.keys(state.families).forEach(function(h) {
    const v = (state.families[h] || '').trim();
    if (v && isExportedUnchanged('families', h, v)) { delete state.families[h]; removed += 1; }
  });
  Object.keys(state.items).forEach(function(id) {
    const v = (state.items[id] || '').trim();
    if (v && isExportedUnchanged('items', id, v)) { delete state.items[id]; removed += 1; }
  });
  Object.keys(state.unrecorded || {}).forEach(function(id) {
    const sig = unrecSig(state.unrecorded[id]);
    if (sig && isExportedUnchanged('unrecorded', id, sig)) {
      state.unrecorded[id].category = '';
      state.unrecorded[id].note = '';
      removed += 1;
    }
  });
  state.exported = emptyExported();
  saveState();
  renderAll();
  return removed;
}

function updateLookupBadge() {
  const el = document.getElementById('sb-lookup-badge');
  if (!el) return;
  if (lookupBatches.length > 0) {
    el.textContent = lookupBatches.length + ' 批';
  } else {
    el.textContent = String(activeUnrecordedIds().length);
  }
}

function getProposalReadyCount() {
  const list = Array.isArray(DATA.proposals) ? DATA.proposals : [];
  let ready = 0;
  list.forEach(function(it) {
    const dec = (state.proposals && state.proposals[it.id]) || null;
    if (dec && dec.decision === 'accept' && it.suggestedMajor) ready += 1;
    else if (dec && dec.decision === 'override' && dec.target) ready += 1;
  });
  return { total: list.length, ready: ready };
}

function updateCommentCounters() {
  const total = totalCommentCount();
  const unsent = countUnsentComments();
  const exportedCnt = Math.max(0, total - unsent);
  document.getElementById('btn-prompt').textContent =
    (exportedCnt > 0 && unsent > 0)
      ? ('複製為 Agent 提示詞 (' + unsent + ' 新)')
      : ('複製為 Agent 提示詞 (' + total + ')');
  document.getElementById('sb-comment-badge').textContent =
    (exportedCnt > 0 && unsent > 0)
      ? (unsent + '/' + total)
      : String(total);
  const propStat = getProposalReadyCount();
  const pb = document.getElementById('sb-proposals-badge');
  if (pb) {
    pb.textContent = propStat.ready > 0 ? (propStat.ready + '/' + propStat.total) : String(propStat.total);
  }
  const syncBadge = document.getElementById('sb-sync-diff-badge');
  if (syncBadge) {
    const ls = DATA.lastSync;
    const addN = (ls && !ls.isInitialImport && Array.isArray(ls.addedScreens)) ? ls.addedScreens.length : 0;
    const remN = (ls && !ls.isInitialImport && Array.isArray(ls.removedScreens)) ? ls.removedScreens.length : 0;
    if (addN > 0 || remN > 0) {
      const parts = [];
      if (addN > 0) parts.push('+' + addN);
      if (remN > 0) parts.push('-' + remN);
      syncBadge.textContent = parts.join('/');
      syncBadge.className = 'pill ' + (addN > 0 ? 'green' : 'red');
    } else {
      syncBadge.textContent = '0';
      syncBadge.className = 'pill';
    }
  }
  const directBtn = document.getElementById('btn-direct-commit');
  if (directBtn) {
    const directRes = collectDirectLabelCommits();
    directBtn.textContent = '重建頁面 (' + directRes.commits.length + ')';
    directBtn.className = directRes.commits.length > 0 ? 'btn accent' : 'btn';
  }
  updateLookupBadge();
}

function getSelectedPagesSummary() {
  const pages = new Set();
  selected.forEach(function(id) {
    const c = resolveCardForId(id);
    if (c) pages.add(c.page || '(未知頁面)');
  });
  return Array.from(pages);
}

function updateFloatBar() {
  const bar = document.getElementById('float-bar');
  const pages = getSelectedPagesSummary();
  const stat = document.getElementById('sel-stat');
  stat.textContent = '已選 ' + selected.size + ' 筆' + (pages.length > 1 ? '（跨 ' + pages.length + ' 頁）' : (pages.length === 1 ? ' · ' + pages[0] : ''));
  stat.className = pages.length > 1 ? 'pill solid-amber' : 'pill solid-blue';
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
  document.getElementById('seg-pages').classList.toggle('active', sbMode === 'pages');
  document.getElementById('seg-fams').classList.toggle('active', sbMode === 'families');
  const syncDiffBtn = document.getElementById('btn-sync-diff-view');
  if (syncDiffBtn) syncDiffBtn.classList.toggle('active', viewMode === 'sync-diff');
  const propBtn = document.getElementById('btn-proposals-view');
  if (propBtn) propBtn.classList.toggle('active', viewMode === 'proposals');
  document.getElementById('btn-lookup-view').classList.toggle('active', viewMode === 'figma-lookup');
  document.getElementById('btn-commented-view').classList.toggle('active', viewMode === 'commented');

  const srcPickerEl = document.getElementById('sb-source-picker');
  const showSrcPicker = sbMode === 'pages' && DATA.isWorkspace && Array.isArray(DATA.sources) && DATA.sources.length > 1;
  if (srcPickerEl) {
    if (showSrcPicker) {
      if (!activePageSourceId && DATA.sources.length > 0) activePageSourceId = DATA.sources[0].id;
      srcPickerEl.style.display = 'flex';
      srcPickerEl.innerHTML =
        '<div class="sb-src-title"><span>切換 Figma 來源檔</span><span>' + DATA.sources.length + ' 份</span></div>' +
        '<div class="sb-src-list">' +
        DATA.sources.map(function(s) {
          const st = sourceStatsById.get(s.id) || { totalScreens: 0, unlabeledScreens: 0, pageCount: 0 };
          const isActSrc = activePageSourceId === s.id;
          const isLive = isMatchingFigmaForSource(s.fileKey, s.fileName);
          return '<div class="sb-src-item' + (isActSrc ? ' active' : '') + '" data-pick-source="' + esc(s.id) + '" title="' + esc((s.fileName || s.id) + ' · ' + st.pageCount + ' 頁 / ' + st.totalScreens + ' 畫面') + '">' +
            '<span class="sb-src-dot' + (isLive ? ' live' : '') + '" title="' + (isLive ? '此檔案已在 Figma 連線' : '未連線或非當前開啟檔') + '"></span>' +
            '<span class="sb-src-name">' + esc(s.fileName || s.id) + '</span>' +
            (st.unlabeledScreens > 0 ? '<span class="pill amber" title="本檔尚未標註畫面數">?' + st.unlabeledScreens + '</span>' : '') +
            '<span class="pill">' + st.totalScreens + '</span>' +
            '</div>';
        }).join('') +
        '</div>';
    } else {
      srcPickerEl.style.display = 'none';
      srcPickerEl.innerHTML = '';
    }
  }

  const filterInput = document.getElementById('sb-filter');
  if (showSrcPicker) {
    const curSrc = DATA.sources.find(function(s) { return s.id === activePageSourceId; });
    filterInput.placeholder = '篩選「' + (curSrc ? (curSrc.fileName || curSrc.id) : '') + '」的頁面...';
  } else {
    filterInput.placeholder = sbMode === 'categories' ? '搜尋分類（支援簡繁，如：弹窗）...' : (sbMode === 'pages' ? '篩選 Figma 頁面（支援簡繁）...' : '篩選 AST 家族...');
  }
  const q = filterInput.value.trim();
  const container = document.getElementById('sb-list');

  if (sbMode === 'categories') {
    let html = '';
    let matchedCatTotal = 0;
    sortedMajors.forEach(function(mRec) {
      const minors = Array.from(mRec.minors.values()).sort(function(a, b) { return b.totalScreens - a.totalScreens; });
      const filteredMinors = q ? minors.filter(function(r) {
        return matchesSearch(r.major + ' ' + r.minor + ' ' + (r.label || ''), q);
      }) : minors;
      if (q && filteredMinors.length === 0) return;
      matchedCatTotal += filteredMinors.length;

      const isOpen = q ? true : expandedMajors.has(mRec.major);
      html += '<div class="major-group' + (isOpen ? ' open' : '') + '">' +
        '<div class="major-hdr" data-toggle-major="' + esc(mRec.major) + '">' +
        '<span class="major-hdr-left"><span class="major-chev">' + (isOpen ? '▾' : '▸') + '</span><span>' + esc(mRec.major) + '</span></span>' +
        '<span class="pill">' + (q ? (filteredMinors.length + ' 類') : mRec.screens) + '</span>' +
        '</div>';
      if (isOpen) {
        html += '<div class="major-children">';
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
        html += '</div>';
      }
      html += '</div>';
    });
    if (q) {
      const summaryBar = '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px 8px;font-size:11.5px;color:var(--text-muted)">' +
        '<span>找到 <strong>' + matchedCatTotal + '</strong> 個相關分類</span>' +
        '<button type="button" class="btn sm" id="sb-clear-filter" style="padding:2px 8px;font-size:11px">清除</button>' +
        '</div>';
      container.innerHTML = summaryBar + (html || '<div class="muted" style="padding:10px">找不到與「' + esc(q) + '」相關的分類</div>');
    } else {
      container.innerHTML = html || '<div class="muted" style="padding:10px">找不到符合的分類</div>';
    }
    return;
  }

  if (sbMode === 'pages') {
    const scopePages = (DATA.isWorkspace && Array.isArray(DATA.sources) && DATA.sources.length > 1 && activePageSourceId)
      ? sortedFigmaPages.filter(function(p) { return p.sourceId === activePageSourceId; })
      : sortedFigmaPages;
    const filteredPages = q ? scopePages.filter(function(p) {
      const disp = p.rawPageName || p.page;
      return matchesSearch(disp + ' ' + p.page, q);
    }) : scopePages;
    let html = '';
    filteredPages.forEach(function(p) {
      const dispName = p.rawPageName || p.page;
      const noteCnt = countCommentsInCards(p.cards);
      const isAct = viewMode === 'page' && activeKey === p.page;
      html += '<div class="cat-item' + (isAct ? ' active' : '') + '" data-open-page="' + esc(p.page) + '" title="' + esc((p.sourceName ? p.sourceName + ' · ' : '') + dispName + '（' + p.catCount.size + ' 個分類）') + '">' +
        '<span class="cat-name">' + esc(dispName) + '</span>' +
        '<span class="cat-meta">' +
        (noteCnt > 0 ? '<span class="pill green">✎' + noteCnt + '</span>' : '') +
        (p.unlabeledScreens > 0 && !isAct ? '<span class="pill amber" title="未標註數量">?' + p.unlabeledScreens + '</span>' : '') +
        '<span class="pill">' + p.totalScreens + '</span>' +
        '</span></div>';
    });
    container.innerHTML = html || '<div class="muted" style="padding:10px">找不到符合的 Figma 頁面</div>';
    return;
  }

  // AST families mode
  const filteredFams = q ? sortedFamilies.filter(function(f) {
    const rep = f.cards[0];
    return matchesSearch(f.shortHash + ' ' + rep.name + ' ' + rep.headline, q);
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

  const spec = DATA.screenSpec || {};
  const specLabel = Array.isArray(spec.widths) && spec.widths.length > 0
    ? ('寬 ' + (spec.widths.length > 3 ? (Math.min.apply(null, spec.widths) + '–' + Math.max.apply(null, spec.widths)) : spec.widths.join('/')) + ' · 高 ' + (spec.minHeight || 600) + '–' + (spec.maxHeight || 12000) + 'px')
    : '';

  let html = '<div class="hint-bar">' +
    (DATA.isColdStart
      ? '目前為 <strong>純 AST 冷啟動視圖</strong>：機器已依結構自動分出 ' + DATA.familyCount + ' 組家族。點擊下方任一家族或左側清單開始歸類；<strong>沒問題直接留空</strong>，有意見請直接描述並複製為 Agent 提示詞。'
      : '點選任一分類卡片進入詳情頁檢視（已按 Figma 頁面分組）；<strong>沒問題的畫面直接留空</strong>，只需針對有偏差的地方寫意見，完成後點擊右上角「複製為 Agent 提示詞」。') +
    (specLabel ? ' <span class="pill" style="margin-left:6px">畫布規則：' + esc(specLabel) + '</span>' : '') +
    '</div>';

  if (DATA.isWorkspace && Array.isArray(DATA.sources) && DATA.sources.length > 1) {
    html += '<div class="panel" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 16px;margin-bottom:16px">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<strong>來源 Figma 檔案（分檔檢視頁面，全域共用分類）</strong>' +
      DATA.sources.map(function(s) {
        const st = sourceStatsById.get(s.id) || { totalScreens: 0, unlabeledScreens: 0, pageCount: 0 };
        return '<button class="btn sm" type="button" data-jump-source-pages="' + esc(s.id) + '" title="點擊切換左側「頁面」分頁檢視此檔案的獨立頁面">' +
          '<span>📄 ' + esc(s.fileName || s.id) + '</span>' +
          '<span class="pill">' + st.pageCount + ' 頁 / ' + st.totalScreens + '</span>' +
          (st.unlabeledScreens > 0 ? '<span class="pill amber">?' + st.unlabeledScreens + ' 未標</span>' : '') +
          '</button>';
      }).join('') +
      '</div></div>';
  }

  const lsOverview = DATA.lastSync;
  if (lsOverview && !lsOverview.isInitialImport && ((lsOverview.addedScreens && lsOverview.addedScreens.length > 0) || (lsOverview.removedScreens && lsOverview.removedScreens.length > 0))) {
    const addCnt = lsOverview.addedScreens ? lsOverview.addedScreens.length : 0;
    const remCnt = lsOverview.removedScreens ? lsOverview.removedScreens.length : 0;
    const archCnt = lsOverview.labelsArchived || 0;
    const touchedTxt = (lsOverview.touchedPages && lsOverview.touchedPages.length > 0)
      ? lsOverview.touchedPages.slice(0, 3).join('、') + (lsOverview.touchedPages.length > 3 ? ' 等 ' + lsOverview.touchedPages.length + ' 頁' : '')
      : '';
    html += '<div class="panel" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;margin-bottom:16px">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<strong>最近同步變更</strong>' +
      (lsOverview.syncedAt ? '<span class="muted">' + esc(lsOverview.syncedAt.slice(0, 16).replace('T', ' ')) + '</span>' : '') +
      (touchedTxt ? '<span class="pill">' + esc(touchedTxt) + '</span>' : '') +
      (addCnt > 0 ? '<span class="pill green">🟢 新入庫 +' + addCnt + '</span>' : '') +
      (remCnt > 0 ? '<span class="pill red">🔴 已刪除 -' + remCnt + '</span>' : '') +
      (archCnt > 0 ? '<span class="pill amber">歸檔舊標註 ' + archCnt + ' 筆</span>' : '') +
      '</div>' +
      '<button class="btn sm accent" id="btn-open-sync-diff" type="button">檢視新入庫與刪除詳情 →</button>' +
      '</div>';
  }

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
  const directMeta = parseDirectCategoryNote(comment);
  const isSel = selected.has(c.id);
  const isFocused = focusedNodeId === c.id;
  const cls = ['screen-row', comment.trim() ? 'has-note' : '', isFocused ? 'focused-row' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
  const archCls = c.archetype === 'overlay' ? 'purple' : (c.archetype === 'overlay-panel' ? 'accent' : '');
  const genCls = c.generation === 'new' ? 'green' : (c.generation === 'old' ? 'red' : '');

  const isNewlySynced = lastSyncAddedSet.has(c.id) || (Array.isArray(c.memberIds) && c.memberIds.some(function(mid) { return lastSyncAddedSet.has(mid); }));
  const dispId = c.rawId || rawNodeId(c.id);

  return '<div class="' + cls + '" data-id="' + esc(c.id) + '">' +
    '<div style="padding-top:3px"><input type="checkbox" class="row-chk" data-id="' + esc(c.id) + '"' + (isSel ? ' checked' : '') + '></div>' +
    '<div>' +
    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
    '<span class="id-link" data-copy="' + esc(dispId) + '" title="點擊複製 node_id">' + esc(dispId) + '</span>' +
    '<button class="btn sm focus-node-btn" data-focus-id="' + esc(c.id) + '" title="在 Figma 中切換頁面並聚焦到此畫面">定位</button>' +
    (isNewlySynced ? '<span class="pill green" title="最近一次增量同步新匯入的畫面">NEW 新入庫</span>' : '') +
    (isSel ? '<span class="pill solid-blue sel-badge">✓ 已選中</span>' : '') +
    (isFocused ? '<span class="pill solid-amber focus-badge">◉ 當前定位</span>' : '') +
    '</div>' +
    '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">' +
    '<span class="pill ' + archCls + '">' + esc(c.archetype) + '</span>' +
    (c.generation ? '<span class="pill ' + genCls + '">' + esc(c.generation) + '</span>' : '') +
    ((DATA.isWorkspace && c.sourceName) ? '<span class="pill accent" title="來源 Figma 檔案">' + esc(c.sourceName) + '</span>' : '') +
    (c.copies > 1 ? '<span class="pill amber" title="' + esc(c.memberIds.map(rawNodeId).join(', ')) + '">×' + c.copies + '</span>' : '') +
    '</div>' +
    '<div style="margin-top:6px">' + swatchesHtml(c.palette) + '</div>' +
    '</div>' +
    '<div>' +
    '<div class="layer-name">' + esc(c.name || '(無名)') + '</div>' +
    '<div class="headline-txt" title="' + esc(c.headline) + '">' + esc(c.headline || '(無文案)') + '</div>' +
    (c.major ? '<div class="muted" style="margin-top:4px">' + esc(c.major + (c.minor ? ' / ' + c.minor : '')) + ' · #' + esc(c.shortHash) + '</div>' : '<div class="muted" style="margin-top:4px">未標註 · AST #' + esc(c.shortHash) + '</div>') +
    '</div>' +
    '<div>' +
    '<div class="cat-combo quick"><input class="cat-combo-input quick-cat-sel" data-combo-kind="quick" data-quick-cat-id="' + esc(c.id) + '" autocomplete="off" placeholder="搜尋／快選標準分類（如：弹窗）…"></div>' +
    '<textarea class="comment item-comment' + (comment.trim() ? ' filled' : '') + '" data-id="' + esc(c.id) + '" placeholder="沒問題留空；或於上方下拉快選，也可手寫補充說明">' + esc(comment) + '</textarea>' +
    '<div class="direct-hint" data-direct-hint-id="' + esc(c.id) + '">' + (directMeta ? ('✓ 確定分類（' + esc(directMeta.target) + '）· 可直接入庫') : '') + '</div>' +
    '</div>' +
    '</div>';
}

function collectMemberIds(cards, onlyPageId) {
  const seen = new Set();
  const out = [];
  cards.forEach(function(c) {
    if (onlyPageId && c.pageId && c.pageId !== onlyPageId) return;
    const ids = (c.memberIds && c.memberIds.length > 0) ? c.memberIds : [c.id];
    ids.forEach(function(id) {
      if (onlyPageId) {
        const owner = byMemberId[id];
        if (owner && owner.pageId && owner.pageId !== onlyPageId) return;
      }
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    });
  });
  return out;
}

function renderGroupHeaderHtml(opts) {
  const list = opts.cards;
  let selCnt = 0;
  list.forEach(function(c) { if (selected.has(c.id)) selCnt += 1; });
  const allMemberIds = collectMemberIds(list, opts.pageId || '');

  return '<div class="page-group' + (selCnt > 0 ? ' has-sel' : '') + '" id="' + esc(opts.domId || '') + '" data-grp-wrap="' + esc(opts.groupKey) + '">' +
    '<div class="page-group-hdr' + (opts.isOpen ? '' : ' collapsed-hdr') + '" data-toggle-page="' + esc(opts.toggleKey) + '">' +
    '<div class="page-group-title">' +
    '<input type="checkbox" class="grp-chk" data-grp-key="' + esc(opts.groupKey) + '"' + (selCnt > 0 && selCnt === list.length ? ' checked' : '') + ' title="全選／取消全選本組">' +
    '<span>' + (opts.isOpen ? '▾' : '▸') + '</span>' +
    (opts.sourceName ? '<span class="pill accent" title="來源 Figma 檔案">' + esc(opts.sourceName) + '</span>' : '') +
    '<span>' + esc(opts.title) + '</span>' +
    '<span class="pill">' + (list.length === opts.totalScreens ? (opts.totalScreens + ' 畫面') : (list.length + ' 組 / ' + opts.totalScreens + ' 畫面')) + '</span>' +
    (selCnt > 0 ? '<span class="pill solid-blue grp-sel-pill">已選 ' + selCnt + '/' + list.length + '</span>' : '') +
    (opts.noteCnt > 0 ? '<span class="pill green">✎ ' + opts.noteCnt + '</span>' : '') +
    '</div>' +
    '<div style="display:flex;gap:6px;align-items:center">' +
    '<button class="btn sm ' + opts.primaryBtnClass + '" data-grp-key="' + esc(opts.groupKey) + '" data-page-key="' + esc(opts.pageKey || opts.groupKey) + '" data-page-id="' + esc(opts.pageId || '') + '" title="' + esc(opts.primaryBtnTitle || '') + '">' + esc(opts.primaryBtnText) + '</button>' +
    '<div class="menu-wrap">' +
    '<button class="btn sm menu-toggle-btn" type="button" title="更多群組操作">⋯</button>' +
    '<div class="menu-pop">' +
    (opts.focusAllItem ? '<button class="menu-item focus-group-all-figma" type="button" data-grp-key="' + esc(opts.groupKey) + '" data-page-key="' + esc(opts.pageKey || opts.groupKey) + '" data-page-id="' + esc(opts.pageId || '') + '">在 Figma 選中本組全部 (' + allMemberIds.length + ')</button>' : '') +
    (opts.focusAllItem ? '<button class="menu-item stage-group-figma" type="button" data-grp-key="' + esc(opts.groupKey) + '" data-page-key="' + esc(opts.pageKey || opts.groupKey) + '" data-page-id="' + esc(opts.pageId || '') + '">生成本組臨時拼板 (' + allMemberIds.length + ')</button>' : '') +
    '<button class="menu-item copy-group-ids-btn" type="button" data-grp-key="' + esc(opts.groupKey) + '">複製本組 ID (' + list.length + ')</button>' +
    (opts.extraMenuHtml || '') +
    '</div></div>' +
    '</div></div>' +
    '<div class="page-group-body' + (opts.isOpen ? '' : ' hidden') + '">';
}

function syncGroupCheckboxes() {
  if (!window.__currentGroups) return;
  document.querySelectorAll('.grp-chk').forEach(function(chk) {
    const gk = chk.getAttribute('data-grp-key');
    const list = window.__currentGroups.get(gk) || [];
    let cnt = 0;
    list.forEach(function(c) { if (selected.has(c.id)) cnt += 1; });
    chk.checked = list.length > 0 && cnt === list.length;
    chk.indeterminate = cnt > 0 && cnt < list.length;
    const wrap = chk.closest('.page-group');
    if (wrap) {
      wrap.classList.toggle('has-sel', cnt > 0);
      const titleEl = wrap.querySelector('.page-group-title');
      if (titleEl) {
        let badge = titleEl.querySelector('.grp-sel-pill');
        if (cnt > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'pill solid-blue grp-sel-pill';
            titleEl.appendChild(badge);
          }
          badge.textContent = '已選 ' + cnt + '/' + list.length;
        } else if (badge) {
          badge.remove();
        }
      }
    }
  });
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
    '<div class="menu-wrap">' +
    '<button class="btn sm menu-toggle-btn" type="button">⋯ 更多</button>' +
    '<div class="menu-pop">' +
    '<button class="menu-item" id="btn-copy-group-ids" type="button">複製全部 ID (' + cards.length + ')</button>' +
    '<button class="menu-item" id="btn-expand-pages" type="button">展開全部頁面</button>' +
    '<button class="menu-item" id="btn-collapse-pages" type="button">收合全部頁面</button>' +
    '</div></div>' +
    '</div></div>';

  if (groupKind === 'category' || groupKind === 'family') {
    const val = groupKind === 'category' ? (state.categories[groupKey] || '') : (state.families[groupKey] || '');
    const ph = groupKind === 'category'
      ? '對整個「' + title + '」分類有整體意見請寫這裡（沒問題留空；例如：這個分類底下有混入彈窗，請拆出）'
      : '對整個 AST 家族 #' + groupKey.slice(0, 8) + ' 有整體歸類意見請寫這裡（沒問題留空；例如：整組歸為 新UI / 收銀台）';
    html += '<textarea class="cat-note-box' + (val.trim() ? ' filled' : '') + '" id="group-comment-box" data-kind="' + groupKind + '" data-key="' + esc(groupKey) + '" placeholder="' + esc(ph) + '">' + esc(val) + '</textarea>';
  }
  html += '</div>';

  const sourceSelectHtml = (DATA.isWorkspace && Array.isArray(DATA.sources) && DATA.sources.length > 1)
    ? '<select id="dt-source"><option value="">全部來源檔 (' + DATA.sources.length + ')</option>' +
      DATA.sources.map(function(s) {
        return '<option value="' + esc(s.id) + '"' + (detailFilter.source === s.id ? ' selected' : '') + '>' + esc(s.fileName || s.id) + '</option>';
      }).join('') +
      '</select>'
    : '';

  html += '<div class="filter-strip">' +
    '<input id="dt-q" style="width:240px" value="' + esc(detailFilter.q) + '" placeholder="搜尋頁面 / 圖層 / 文案 / ID">' +
    sourceSelectHtml +
    '<select id="dt-arch"><option value="">全部原型</option><option value="page"' + (detailFilter.arch === 'page' ? ' selected' : '') + '>page</option><option value="overlay-panel"' + (detailFilter.arch === 'overlay-panel' ? ' selected' : '') + '>overlay-panel</option><option value="overlay"' + (detailFilter.arch === 'overlay' ? ' selected' : '') + '>overlay</option></select>' +
    '<select id="dt-gen"><option value="">全部世代</option><option value="new"' + (detailFilter.gen === 'new' ? ' selected' : '') + '>new</option><option value="old"' + (detailFilter.gen === 'old' ? ' selected' : '') + '>old</option></select>' +
    '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" id="dt-only-comment"' + (detailFilter.onlyCommented ? ' checked' : '') + '> 只看已填意見</label>' +
    '</div>';

  const filtered = cards.filter(function(c) {
    if (detailFilter.source && c.sourceId !== detailFilter.source) return false;
    if (detailFilter.arch && c.archetype !== detailFilter.arch) return false;
    if (detailFilter.gen && c.generation !== detailFilter.gen) return false;
    if (detailFilter.onlyCommented && !(state.items[c.id] || '').trim()) return false;
    if (detailFilter.q) {
      const hay = (c.rawId || c.id) + ' ' + c.id + ' ' + c.page + ' ' + (c.sourceName || '') + ' ' + c.name + ' ' + c.headline + ' ' + c.shortHash;
      if (!matchesSearch(hay, detailFilter.q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    window.__currentGroupCards = [];
    window.__currentGroups = new Map();
    document.getElementById('content').innerHTML = html + '<div class="panel"><div class="muted">目前篩選條件下沒有畫面。</div></div>';
    return;
  }

  const byPage = new Map();
  filtered.forEach(function(c) {
    const pg = c.page || '(未知頁面)';
    if (!byPage.has(pg)) byPage.set(pg, []);
    byPage.get(pg).push(c);
  });
  const sortedPages = Array.from(byPage.entries()).sort(function(a, b) { return b[1].length - a[1].length; });

  const scopePrefix = groupKind + ':' + groupKey + ':';
  const anyExplicit = sortedPages.some(function(e) { return expandedPages.has(scopePrefix + e[0]) || expandedPages.has('COLLAPSED::' + scopePrefix + e[0]); });
  if (!anyExplicit) {
    sortedPages.slice(0, 3).forEach(function(e) { expandedPages.add(scopePrefix + e[0]); });
  }

  sortedPages.forEach(function(entry) {
    const pg = entry[0];
    const list = entry[1];
    const pKey = scopePrefix + pg;
    const isOpen = (detailFilter.q || detailFilter.onlyCommented) ? !expandedPages.has('COLLAPSED::' + pKey) : expandedPages.has(pKey);
    const totalInPage = list.reduce(function(s, x) { return s + x.copies; }, 0);
    const noteCnt = countCommentsInCards(list);
    const first = list[0];

    const cleanPg = (first && first.rawPageName) || pg;
    html += renderGroupHeaderHtml({
      groupKey: pg,
      toggleKey: pKey,
      isOpen: isOpen,
      title: cleanPg,
      sourceName: (DATA.isWorkspace && first) ? (first.sourceName || '') : '',
      cards: list,
      totalScreens: totalInPage,
      noteCnt: noteCnt,
      pageKey: pg,
      pageId: first ? first.pageId : '',
      primaryBtnClass: 'accent focus-page-figma',
      primaryBtnText: '定位到 Figma',
      primaryBtnTitle: '僅切換 Figma 到此頁面（不一次全選全部節點）',
      focusAllItem: true,
      extraMenuHtml: '<button class="menu-item" type="button" data-open-page="' + esc(pg) + '">切換到整頁視角（' + esc(cleanPg) + '）</button>'
    });
    if (isOpen) {
      list.forEach(function(c) { html += renderScreenRow(c); });
    }
    html += '</div></div>';
  });

  document.getElementById('content').innerHTML = html;
  window.__currentGroupCards = filtered;
  window.__currentGroups = byPage;
  window.__currentScopePrefix = scopePrefix;
  syncGroupCheckboxes();
}

function renderPageView(pageName) {
  const pRec = figmaPageMap.get(pageName);
  if (!pRec) { viewMode = 'overview'; renderOverview(); return; }

  const cleanTitle = pRec.rawPageName || pRec.page;
  const total = pRec.totalScreens;
  const pct = total > 0 ? Math.round((100 * pRec.labeledScreens) / total) : 0;
  const sub = (DATA.isWorkspace && pRec.sourceName ? ('來源：' + pRec.sourceName + ' · ') : '') + '已收錄 ' + total + ' 個畫面（同頁去重 ' + pRec.cards.length + ' 組） · 分佈於 ' + pRec.catCount.size + ' 個分類 · 已標註 ' + pct + '%';

  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> ' +
    (DATA.isWorkspace && pRec.sourceName ? '<span class="pill accent">📄 ' + esc(pRec.sourceName) + '</span> ' : '') +
    '<span>頁面 · ' + esc(cleanTitle) + '</span>';
  document.getElementById('topbar-sub').textContent = sub;

  const sortedCatSummary = Array.from(pRec.catCount.entries()).sort(function(a, b) { return b[1] - a[1]; });
  let stackHtml = '<div class="cat-stack-bar">';
  let chipHtml = '<div class="cat-chip-row">';
  sortedCatSummary.forEach(function(pair, idx) {
    const label = pair[0];
    const cnt = pair[1];
    const w = total > 0 ? ((100 * cnt) / total).toFixed(2) : '0';
    const color = label === '未標註' ? '#d97706' : CAT_COLORS[idx % CAT_COLORS.length];
    stackHtml += '<div style="width:' + w + '%;background:' + color + '" title="' + esc(label) + ': ' + cnt + '"></div>';
    chipHtml += '<button class="cat-chip" type="button" data-jump-cat-group="' + esc(label) + '"><i class="cat-dot" style="background:' + color + '"></i><span>' + esc(label) + '</span><span class="pill">' + cnt + '</span></button>';
  });
  stackHtml += '</div>';
  chipHtml += '</div>';

  let html = '<div class="detail-hero">' +
    '<div class="detail-hero-row">' +
    '<div><div class="detail-title">' + (DATA.isWorkspace && pRec.sourceName ? '<span class="pill accent" style="margin-right:8px;vertical-align:middle">📄 ' + esc(pRec.sourceName) + '</span>' : '') + esc(cleanTitle) + '</div><div class="muted" style="margin-top:2px">' + esc(sub) + '</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<button class="btn sm accent" id="btn-jump-this-page" data-page-key="' + esc(pRec.page) + '" data-page-id="' + esc(pRec.pageId) + '">跳轉到 Figma 頁面</button>' +
    '<div class="menu-wrap">' +
    '<button class="btn sm menu-toggle-btn" type="button">⋯ 更多</button>' +
    '<div class="menu-pop">' +
    '<button class="menu-item" id="btn-focus-page-all-recorded" type="button" data-page-key="' + esc(pRec.page) + '" data-page-id="' + esc(pRec.pageId) + '">在 Figma 選中本頁全部已收錄 (' + total + ')</button>' +
    '<button class="menu-item" id="btn-copy-group-ids" type="button">複製本頁全部 ID (' + total + ')</button>' +
    '<button class="menu-item" id="btn-expand-pages" type="button">展開全部分類</button>' +
    '<button class="menu-item" id="btn-collapse-pages" type="button">收合全部分類</button>' +
    '</div></div>' +
    '</div></div>' +
    stackHtml + chipHtml +
    '</div>';

  html += '<div class="filter-strip">' +
    '<input id="dt-q" style="width:240px" value="' + esc(detailFilter.q) + '" placeholder="搜尋分類 / 圖層 / 文案 / ID">' +
    '<select id="dt-arch"><option value="">全部原型</option><option value="page"' + (detailFilter.arch === 'page' ? ' selected' : '') + '>page</option><option value="overlay-panel"' + (detailFilter.arch === 'overlay-panel' ? ' selected' : '') + '>overlay-panel</option><option value="overlay"' + (detailFilter.arch === 'overlay' ? ' selected' : '') + '>overlay</option></select>' +
    '<select id="dt-gen"><option value="">全部世代</option><option value="new"' + (detailFilter.gen === 'new' ? ' selected' : '') + '>new</option><option value="old"' + (detailFilter.gen === 'old' ? ' selected' : '') + '>old</option></select>' +
    '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" id="dt-only-comment"' + (detailFilter.onlyCommented ? ' checked' : '') + '> 只看已填意見</label>' +
    '</div>';

  const filtered = pRec.cards.filter(function(c) {
    if (detailFilter.source && c.sourceId !== detailFilter.source) return false;
    if (detailFilter.arch && c.archetype !== detailFilter.arch) return false;
    if (detailFilter.gen && c.generation !== detailFilter.gen) return false;
    if (detailFilter.onlyCommented && !(state.items[c.id] || '').trim()) return false;
    if (detailFilter.q) {
      const catStr = c.major ? (c.major + ' ' + c.minor) : '未標註';
      const hay = (c.rawId || c.id) + ' ' + c.id + ' ' + catStr + ' ' + (c.sourceName || '') + ' ' + c.name + ' ' + c.headline + ' ' + c.shortHash;
      if (!matchesSearch(hay, detailFilter.q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    window.__currentGroupCards = [];
    window.__currentGroups = new Map();
    document.getElementById('content').innerHTML = html + '<div class="panel"><div class="muted">目前篩選條件下沒有畫面。</div></div>';
    return;
  }

  const byCat = new Map();
  filtered.forEach(function(c) {
    const catLabel = c.major ? (c.major + (c.minor ? ' / ' + c.minor : '')) : '未標註';
    if (!byCat.has(catLabel)) byCat.set(catLabel, []);
    byCat.get(catLabel).push(c);
  });
  const sortedCats = Array.from(byCat.entries()).sort(function(a, b) {
    const sa = a[1].reduce(function(s, x) { return s + x.copies; }, 0);
    const sb = b[1].reduce(function(s, x) { return s + x.copies; }, 0);
    return sb - sa;
  });

  const scopePrefix = 'page:' + pRec.page + ':';
  const anyExplicit = sortedCats.some(function(e) { return expandedPages.has(scopePrefix + e[0]) || expandedPages.has('COLLAPSED::' + scopePrefix + e[0]); });
  if (!anyExplicit) {
    sortedCats.slice(0, 3).forEach(function(e) { expandedPages.add(scopePrefix + e[0]); });
  }

  sortedCats.forEach(function(entry, idx) {
    const catLabel = entry[0];
    const list = entry[1];
    const pKey = scopePrefix + catLabel;
    const isOpen = (detailFilter.q || detailFilter.onlyCommented) ? !expandedPages.has('COLLAPSED::' + pKey) : expandedPages.has(pKey);
    const totalInCat = list.reduce(function(s, x) { return s + x.copies; }, 0);
    const noteCnt = countCommentsInCards(list);
    const first = list[0];
    const openCatKey = first.major ? (first.major + '::' + (first.minor || '(未細分)')) : '未標註::AST 待歸類';
    const memberCount = collectMemberIds(list).length;

    html += renderGroupHeaderHtml({
      domId: 'pg-cat-grp-' + idx,
      groupKey: catLabel,
      toggleKey: pKey,
      isOpen: isOpen,
      title: catLabel,
      cards: list,
      totalScreens: totalInCat,
      noteCnt: noteCnt,
      pageKey: pRec.page,
      pageId: pRec.pageId,
      primaryBtnClass: 'accent focus-group-all-figma',
      primaryBtnText: '在 Figma 選中 (' + memberCount + ')',
      primaryBtnTitle: '在 Figma 中同時選中本頁屬於此分類的設計稿',
      focusAllItem: false,
      extraMenuHtml: catMap.has(openCatKey) ? '<button class="menu-item" type="button" data-open-cat="' + esc(openCatKey) + '">查看「' + esc(catLabel) + '」全檔分佈</button>' : ''
    });
    if (isOpen) {
      list.forEach(function(c) { html += renderScreenRow(c); });
    }
    html += '</div></div>';
  });

  document.getElementById('content').innerHTML = html;
  window.__currentGroupCards = filtered;
  window.__currentGroups = byCat;
  window.__currentScopePrefix = scopePrefix;
  window.__currentPageRec = pRec;
  syncGroupCheckboxes();
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
    '<input class="unrec-cat' + (catVal.trim() ? ' filled' : '') + '" list="all-cat-options" data-unrec-id="' + esc(u.id) + '" value="' + esc(catVal) + '" placeholder="人工填寫／選擇分類（例：新UI / 交易詳情，留空交由 Agent 判斷）">' +
    '<textarea class="comment unrec-note' + (noteVal.trim() ? ' filled' : '') + '" data-unrec-id="' + esc(u.id) + '" placeholder="備註說明，或直接留給 Agent 歸類意見...">' + esc(noteVal) + '</textarea>' +
    '<div class="unrec-actions">' +
    '<button class="btn sm unrec-ask-agent" data-unrec-id="' + esc(u.id) + '">交給 Agent 分類</button>' +
    '<button class="btn sm ghost unrec-clear" data-unrec-id="' + esc(u.id) + '">清除</button>' +
    '</div>' +
    '</div>' +
    '</div>';
}

function renderLookupView() {
  const activeBatch = getActiveLookupBatch();
  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>Figma 選中查找</span>';
  document.getElementById('topbar-sub').textContent = activeBatch
    ? (activeBatch.name + ' · 來自「' + (activeBatch.pageName || 'Figma') + '」· 共 ' + activeBatch.total + ' 筆（共暫存 ' + lookupBatches.length + ' 批）')
    : '在 Figma 中選中設計稿或整個 Section 區塊後，於插件點擊「查找選中項 → 複審台」';

  if (!activeBatch) {
    window.__currentGroupCards = [];
    window.__currentGroups = new Map();
    document.getElementById('content').innerHTML = '<div class="panel">' +
      '<div class="panel-title"><span>等待接收 Figma 選中項（支援臨時分批）</span></div>' +
      '<div class="muted" style="line-height:1.8">1. 確認已啟動 <code>npm run start:server</code> 並在 Figma Desktop 開啟「Rea-FigmaDesign AST 探針」插件。<br>2. 在 Figma 畫布中選中設計稿（也可直接框選或點選整個 <strong>Section 區塊</strong>，插件會自動展開其中的可見畫面，忽略已隱藏圖層）。<br>3. 點擊插件內的 <strong>「查找選中項 → 複審台」</strong> 按鈕，每次送過來的選區會自動建立獨立臨時批次並支援命名，重整頁面即清空，不會污染任何持久資料。</div>' +
      '</div>';
    return;
  }

  const matched = activeBatch.matched || [];
  const unrecorded = activeBatch.unrecorded || [];
  const matchedCards = matched.map(function(m) { return m.card; });
  const pgKey = activeBatch.pageName || '查找結果';
  window.__currentGroupCards = matchedCards;
  window.__currentGroups = matchedCards.length > 0 ? new Map([[pgKey, matchedCards]]) : new Map();

  let stripHtml = '<div class="temp-batch-strip">' +
    '<div class="temp-batch-hdr">' +
    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<strong>臨時選取批次 (' + lookupBatches.length + ')</strong>' +
    '<span class="pill" title="批次清單僅暫存於本次分頁記憶體，重整頁面後自動清空；你填寫的意見仍會保留">僅本次暫存 · 重整頁面清空</span>' +
    '</div>' +
    '<button class="btn sm ghost" id="btn-clear-lookup-batches" type="button">清空全部臨時批次</button>' +
    '</div>' +
    '<div class="temp-batch-pills">';

  lookupBatches.forEach(function(b) {
    if (renamingBatchId === b.batchId) {
      stripHtml += '<input class="batch-rename-input" id="active-batch-rename-input" data-rename-batch-id="' + esc(b.batchId) + '" value="' + esc(b.name) + '" placeholder="輸入批次名稱，按 Enter 確認">';
    } else {
      const isAct = b.batchId === activeBatch.batchId;
      stripHtml += '<div class="batch-pill' + (isAct ? ' active' : '') + '" data-switch-batch="' + esc(b.batchId) + '" title="' + esc(b.name + ' (' + b.pageName + ' · ' + b.total + ' 筆)') + '">' +
        '<span class="batch-pill-name">' + esc(b.name) + '</span>' +
        '<span class="pill">' + b.total + '</span>' +
        '<button class="batch-pill-act batch-rename-btn" type="button" data-batch-id="' + esc(b.batchId) + '" title="重新命名此臨時批次">✎</button>' +
        '<button class="batch-pill-act batch-del-btn" type="button" data-batch-id="' + esc(b.batchId) + '" title="刪除此臨時批次">×</button>' +
        '</div>';
    }
  });
  stripHtml += '</div></div>';

  const catBreakdown = new Map();
  matchedCards.forEach(function(c) {
    const lbl = c.major ? (c.major + (c.minor ? ' / ' + c.minor : '')) : '未標註';
    catBreakdown.set(lbl, (catBreakdown.get(lbl) || 0) + 1);
  });
  const catSummaryPills = Array.from(catBreakdown.entries())
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(pair) {
      return '<span class="pill" title="目前標註分類">' + esc(pair[0]) + ' ' + pair[1] + '</span>';
    }).join('');

  const secPill = activeBatch.expandedSections && activeBatch.expandedSections.length > 0
    ? '<span class="pill accent">由 Section 展開：' + esc(activeBatch.expandedSections.join(', ')) + '</span>'
    : '';

  let html = stripHtml +
    '<div class="detail-hero">' +
    '<div class="detail-hero-row">' +
    '<div><div class="detail-title">' + esc(activeBatch.name) + ' · ' + esc(pgKey) + '</div>' +
    '<div class="muted" style="margin-top:2px">本批選中 ' + activeBatch.total + ' 個節點 · 已收錄 ' + matched.length + ' 筆（1:1 對應 Figma 畫布） · 未收錄（新畫面）' + unrecorded.length + ' 筆</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    (matched.length > 0 ? '<button class="btn sm primary" id="btn-lookup-batch-matched" type="button">批量標註本批已收錄 (' + matched.length + ')</button>' : '') +
    (activeBatch.allNodeIds && activeBatch.allNodeIds.length > 0 ? '<button class="btn sm accent" id="btn-lookup-refocus-all" type="button" title="即使剛剛取消隱藏並清除了畫布選區，也能一鍵在 Figma 重新選中本批全部節點">在 Figma 重新選中本批全部 (' + activeBatch.allNodeIds.length + ')</button>' : '') +
    '<span class="pill green">已收錄 ' + matched.length + ' 筆</span>' +
    '<span class="pill amber">未收錄（新） ' + unrecorded.length + ' 筆</span>' +
    '</div></div>' +
    ((catSummaryPills || secPill) ? '<div class="cat-chip-row">' + secPill + (catSummaryPills ? '<span class="muted" style="font-size:11.5px;align-self:center">目前標註分佈：</span>' + catSummaryPills : '') + '</div>' : '') +
    '</div>';

  if (unrecorded.length > 0) {
    html += '<div class="panel" style="padding:0;overflow:hidden">' +
      '<div class="panel-title" style="padding:14px 16px 10px;margin:0;flex-wrap:wrap;gap:8px">' +
      '<span>一、未收錄新畫面 <span class="pill amber">' + unrecorded.length + '</span></span>' +
      '<button class="btn sm" id="btn-unrec-all-agent">全部交給 Agent 分類</button>' +
      '</div>';
    if (unrecorded.length > 1) {
      html += '<div class="lookup-batch-bar">' +
        '<input id="unrec-batch-cat" list="all-cat-options" style="min-width:210px;flex:1" placeholder="批量指定分類（選填，例：新UI / 交易詳情）">' +
        '<input id="unrec-batch-note" style="min-width:220px;flex:1" placeholder="批量備註給 Agent（選填）">' +
        '<button class="btn sm accent" id="btn-unrec-batch-apply">套用到本批未收錄 (' + unrecorded.length + ')</button>' +
        '</div>';
    }
    unrecorded.forEach(function(it) { html += renderUnrecordedRow(it); });
    html += '</div>';
  }

  if (matched.length > 0) {
    const first = matchedCards[0];
    const pgId = activeBatch.pageId || (first ? first.pageId : '');
    html += renderGroupHeaderHtml({
      groupKey: pgKey,
      toggleKey: 'lookup::' + activeBatch.batchId + '::' + pgKey,
      isOpen: true,
      title: '二、已收錄畫面 · ' + pgKey,
      cards: matchedCards,
      totalScreens: matchedCards.length,
      noteCnt: countCommentsInCards(matchedCards),
      pageKey: pgKey,
      pageId: pgId,
      primaryBtnClass: 'accent focus-group-all-figma',
      primaryBtnText: '在 Figma 選中 (' + matchedCards.length + ')',
      primaryBtnTitle: '在 Figma 中同時選中本批已收錄的設計稿',
      focusAllItem: false,
      extraMenuHtml: '<button class="menu-item focus-page-figma" type="button" data-page-key="' + esc(pgKey) + '" data-page-id="' + esc(pgId) + '">跳轉到 Figma 頁面</button>'
    });

    matched.forEach(function(m) {
      const c = m.card;
      const catKey = (c.major || '未標註') + '::' + (c.major ? (c.minor || '(未細分)') : 'AST 待歸類');
      if (m.matchVia === 'ancestor') {
        html += '<div class="match-banner">' +
          '<span>由子節點 ' + esc(m.matchedSelectedIds.join(', ')) + ' 匹配到所屬畫面 ' + esc(c.id) + '（' + esc(c.major ? (c.major + (c.minor ? ' / ' + c.minor : '')) : '未標註') + '）</span>' +
          (catMap.has(catKey) ? '<button class="btn sm" data-open-cat="' + esc(catKey) + '">前往分類</button>' : '') +
          '</div>';
      }
      html += renderScreenRow(c);
    });
    html += '</div></div>';
  }

  document.getElementById('content').innerHTML = html;
  syncGroupCheckboxes();
  if (renamingBatchId) {
    const renInp = document.getElementById('active-batch-rename-input');
    if (renInp) { renInp.focus(); renInp.select(); }
  }
}

function renderCommentedView() {
  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>已填寫意見清單</span>';
  document.getElementById('topbar-sub').textContent = '僅列出目前有填寫修改／補充意見的項目';

  const catKeys = Object.keys(state.categories).filter(function(k) { return (state.categories[k] || '').trim(); });
  const famKeys = Object.keys(state.families).filter(function(k) { return (state.families[k] || '').trim(); });
  const itemIds = Object.keys(state.items).filter(function(k) { return (state.items[k] || '').trim() && resolveCardForId(k); });
  const unrecIds = activeUnrecordedIds();

  if (catKeys.length === 0 && famKeys.length === 0 && itemIds.length === 0 && unrecIds.length === 0) {
    document.getElementById('content').innerHTML = '<div class="panel"><div class="muted">目前尚未填寫任何意見。請從左側分類、總覽看板或 Figma 選中查找開始填寫。</div></div>';
    return;
  }

  let html = '';
  const exportedOldCnt = Math.max(0, totalCommentCount() - countUnsentComments());
  if (exportedOldCnt > 0) {
    html += '<div class="hint-bar" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
      '<span>其中 <strong>' + exportedOldCnt + '</strong> 筆意見在上次「複製為 Agent 提示詞」時已經送出（後續新增或修改會自動只複製新內容）。</span>' +
      '<button class="btn sm" id="btn-clear-exported-list" type="button">清空已複製舊意見 (' + exportedOldCnt + ')</button>' +
      '</div>';
  }
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
    itemIds.forEach(function(id) { html += renderScreenRow(resolveCardForId(id)); });
    html += '</div>';
  }

  if (unrecIds.length > 0) {
    html += '<div class="panel" style="padding:0;overflow:hidden"><div class="panel-title" style="padding:14px 16px 6px"><span>四、Figma 未收錄新畫面 (' + unrecIds.length + ')</span></div>';
    unrecIds.forEach(function(id) { html += renderUnrecordedRow(state.unrecorded[id]); });
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function parseCanonicalTarget(targetStr) {
  const s = (targetStr || '').trim();
  if (!s) return { major: '', minor: '', generation: '' };
  const idx = s.indexOf(' / ');
  const major = idx === -1 ? s : s.slice(0, idx).trim();
  const minor = idx === -1 ? '' : s.slice(idx + 3).trim();
  const generation = major === '老UI' ? 'old' : (major === '系統UI' ? '' : 'new');
  return { major: major, minor: minor, generation: generation };
}

function collectReadyProposalCommits() {
  const list = Array.isArray(DATA.proposals) ? DATA.proposals : [];
  const out = [];
  list.forEach(function(it) {
    const dec = (state.proposals && state.proposals[it.id]) || null;
    if (!dec) return;
    if (dec.decision === 'accept' && it.suggestedMajor) {
      out.push({
        id: it.id,
        major: it.suggestedMajor,
        minor: it.suggestedMinor || '',
        generation: it.suggestedGeneration != null ? it.suggestedGeneration : (it.suggestedMajor === '系統UI' ? '' : 'new')
      });
    } else if (dec.decision === 'override' && dec.target) {
      const parsed = parseCanonicalTarget(dec.target);
      if (parsed.major) {
        out.push({
          id: it.id,
          major: parsed.major,
          minor: parsed.minor,
          generation: parsed.generation
        });
      }
    }
  });
  return out;
}

function buildProposalFallbackPrompt(commits) {
  const BT = String.fromCharCode(96);
  const NL = String.fromCharCode(10);
  const targetLabels = DATA.labelsPath || 'labels/screens-v2.json';
  const lines = [];
  lines.push('請將以下我在複審台「Agent 預分類驗收」確認好的 ' + commits.length + ' 筆分類寫入 ' + BT + targetLabels + BT + '（專案：' + (DATA.projectId || 'default') + '）：');
  lines.push('');
  const byTarget = new Map();
  commits.forEach(function(c) {
    const k = c.major + (c.minor ? ' / ' + c.minor : '');
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(c.id);
  });
  Array.from(byTarget.entries()).forEach(function(pair, idx) {
    lines.push((idx + 1) + '. **' + pair[0] + '**（' + pair[1].length + ' 筆）：' + BT + pair[1].join(', ') + BT);
  });
  return lines.join(NL);
}

function renderProposalsView() {
  const all = Array.isArray(DATA.proposals) ? DATA.proposals : [];
  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>Agent 預分類驗收</span>';
  document.getElementById('topbar-sub').textContent = (DATA.proposalsScope || '細分分類建議') + ' · 共 ' + all.length + ' 筆待驗收';

  if (all.length === 0) {
    window.__propGroups = new Map();
    document.getElementById('content').innerHTML = '<div class="panel">' +
      '<div class="panel-title"><span>目前沒有待驗收的 Agent 預分類草稿</span></div>' +
      '<div class="muted" style="line-height:1.8">所有項目都已完成分類並落盤，或尚未產生草稿。<br>你可以在終端機執行 <code>npm run review:propose</code> 針對「新UI / (未細分)」生成最新一批建議草稿。</div>' +
      '</div>';
    return;
  }

  let highCnt = 0, medCnt = 0, lowCnt = 0, acceptCnt = 0, overCnt = 0, skipCnt = 0;
  all.forEach(function(it) {
    if (it.confidence === 'high') highCnt += 1;
    else if (it.confidence === 'medium') medCnt += 1;
    else lowCnt += 1;
    const dec = (state.proposals && state.proposals[it.id]) || null;
    if (dec) {
      if (dec.decision === 'accept' && it.suggestedMajor) acceptCnt += 1;
      else if (dec.decision === 'override' && dec.target) overCnt += 1;
      else if (dec.decision === 'skip') skipCnt += 1;
    }
  });
  const readyCnt = acceptCnt + overCnt;

  let html = '<div class="detail-hero">' +
    '<div class="detail-hero-row">' +
    '<div><div class="detail-title">Agent 預分類驗收 · ' + esc(DATA.proposalsScope || '未細分整理') + '</div>' +
    '<div class="muted" style="margin-top:2px">待驗收 ' + all.length + ' 筆 · 已準備落盤 <strong>' + readyCnt + '</strong> 筆（採納 ' + acceptCnt + ' · 改選 ' + overCnt + '） · 略過 ' + skipCnt + ' 筆</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    (highCnt > 0 ? '<button class="btn sm" id="btn-accept-all-high" type="button">一鍵採納高把握 (' + highCnt + ')</button>' : '') +
    '<button class="btn sm primary" id="btn-open-commit-proposals" type="button">確認並落盤已驗收 (' + readyCnt + ')</button>' +
    '</div></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
    '<div class="seg" style="margin:0">' +
    '<button type="button" class="' + (propGroupBy === 'target' ? 'active' : '') + '" data-prop-group="target">按建議分類</button>' +
    '<button type="button" class="' + (propGroupBy === 'page' ? 'active' : '') + '" data-prop-group="page">按 Figma 頁面</button>' +
    '</div>' +
    '<span class="muted">先抽查／整組採納、改選標準分類或自訂新分類，最後點「確認並落盤」才會真正寫入 ' + esc(DATA.labelsPath || 'labels/screens-v2.json') + '</span>' +
    '</div></div>';

  html += '<div class="prop-tabs">' +
    '<button type="button" class="prop-tab' + (propFilter === 'all' ? ' active' : '') + '" data-prop-filter="all"><div class="prop-tab-title">全部待驗收</div><div class="prop-tab-num">' + all.length + '</div></button>' +
    '<button type="button" class="prop-tab' + (propFilter === 'high' ? ' active' : '') + '" data-prop-filter="high"><div class="prop-tab-title">🟢 高把握 · AST 同構</div><div class="prop-tab-num" style="color:var(--green)">' + highCnt + '</div></button>' +
    '<button type="button" class="prop-tab' + (propFilter === 'medium' ? ' active' : '') + '" data-prop-filter="medium"><div class="prop-tab-title">🟡 中把握 · 語意推斷</div><div class="prop-tab-num" style="color:var(--amber)">' + medCnt + '</div></button>' +
    '<button type="button" class="prop-tab' + (propFilter === 'low' ? ' active' : '') + '" data-prop-filter="low"><div class="prop-tab-title">🔴 需人工拍板</div><div class="prop-tab-num" style="color:var(--red)">' + lowCnt + '</div></button>' +
    '</div>';

  const visible = all.filter(function(it) {
    return propFilter === 'all' || it.confidence === propFilter;
  });
  const groups = new Map();
  visible.forEach(function(it) {
    const card = resolveCardForId(it.id);
    const gk = propGroupBy === 'page'
      ? ((card && card.page) || '(未知頁面)')
      : (it.suggestedMajor ? (it.suggestedMajor + (it.suggestedMinor ? ' / ' + it.suggestedMinor : '')) : '🔴 待人工從下拉拍板');
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({ prop: it, card: card });
  });
  window.__propGroups = groups;

  const sortedGroups = Array.from(groups.entries()).sort(function(a, b) { return b[1].length - a[1].length; });
  sortedGroups.forEach(function(entry, idx) {
    const gk = entry[0];
    const pairs = entry[1];
    const hasSuggest = pairs.some(function(x) { return Boolean(x.prop.suggestedMajor); });
    let decidedCnt = 0;
    pairs.forEach(function(x) {
      const dec = state.proposals && state.proposals[x.prop.id];
      if (dec && (dec.decision === 'accept' || dec.decision === 'override')) decidedCnt += 1;
    });
    const firstCard = pairs[0] && pairs[0].card;
    const pgId = (propGroupBy === 'page' && firstCard) ? (firstCard.pageId || '') : '';

    html += '<div class="page-group">' +
      '<div class="page-group-hdr" style="cursor:default">' +
      '<div class="page-group-title">' +
      '<span>' + esc(gk) + '</span>' +
      '<span class="pill">' + pairs.length + ' 筆</span>' +
      (decidedCnt > 0 ? '<span class="pill green">已確認 ' + decidedCnt + '/' + pairs.length + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      (propGroupBy === 'page' ? '<button class="btn sm accent prop-focus-group" type="button" data-prop-gk="' + esc(gk) + '" data-page-id="' + esc(pgId) + '">在 Figma 選中本頁 (' + pairs.length + ')</button>' : '') +
      (hasSuggest ? '<button class="btn sm primary prop-accept-group" type="button" data-prop-gk="' + esc(gk) + '">✓ 整組採納</button>' : '') +
      '<button class="btn sm prop-override-group" type="button" data-prop-gk="' + esc(gk) + '">✎ 整組改分類</button>' +
      '<button class="btn sm ghost prop-skip-group" type="button" data-prop-gk="' + esc(gk) + '">✕ 整組略過</button>' +
      '</div></div>' +
      '<div class="page-group-body">';

    pairs.forEach(function(x) {
      const it = x.prop;
      const c = x.card;
      const dec = (state.proposals && state.proposals[it.id]) || null;
      const decType = dec ? dec.decision : '';
      const rowCls = ['prop-row', decType === 'accept' ? 'dec-accept' : (decType === 'override' ? 'dec-override' : (decType === 'skip' ? 'dec-skip' : ''))].filter(Boolean).join(' ');
      const confBadge = it.confidence === 'high'
        ? '<span class="pill green">🟢 高把握</span>'
        : (it.confidence === 'medium' ? '<span class="pill amber">🟡 中把握</span>' : '<span class="pill red">🔴 待拍板</span>');
      const suggestTxt = it.suggestedMajor ? (it.suggestedMajor + (it.suggestedMinor ? ' / ' + it.suggestedMinor : '')) : '（無預設建議，請從右側改選）';
      const overrideVal = decType === 'override' ? (dec.target || '') : '';
      const isCanonicalOverride = Boolean(overrideVal && window.__canonicalCatSet && window.__canonicalCatSet.has(overrideVal));
      const isCustomOverride = Boolean(overrideVal && !isCanonicalOverride);
      const customParsed = isCustomOverride ? parseCanonicalTarget(overrideVal) : { major: '新UI', minor: '' };
      const customMajor = (customParsed.major === '新UI' || customParsed.major === '老UI' || customParsed.major === '系統UI') ? customParsed.major : '新UI';

      html += '<div class="' + rowCls + '" data-prop-id="' + esc(it.id) + '">' +
        '<div>' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span class="id-link" data-copy="' + esc(rawNodeId(it.id)) + '" title="點擊複製 node_id">' + esc(rawNodeId(it.id)) + '</span>' +
        '<button class="btn sm focus-node-btn" data-focus-id="' + esc(it.id) + '" data-focus-page="' + esc((c && c.page) || '') + '" title="在 Figma 中切換頁面並聚焦到此畫面">定位</button>' +
        '</div>' +
        '<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">' +
        confBadge +
        (c && c.archetype ? '<span class="pill">' + esc(c.archetype) + '</span>' : '') +
        '</div>' +
        '<div class="muted" style="margin-top:5px">' + esc((c && c.page) || '-') + '</div>' +
        '</div>' +
        '<div>' +
        '<div class="layer-name">' + esc((c && c.name) || '(無名)') + '</div>' +
        '<div class="headline-txt" title="' + esc((c && c.headline) || '') + '">' + esc((c && c.headline) || '(無文案)') + '</div>' +
        '<div class="prop-suggest-box"><strong>Agent 建議：</strong>' + esc(suggestTxt) + '<div class="muted" style="margin-top:2px">' + esc(it.reason || '') + '</div></div>' +
        '</div>' +
        '<div>' +
        '<div class="prop-actions">' +
        (it.suggestedMajor ? '<button class="btn sm' + (decType === 'accept' ? ' primary' : '') + ' prop-btn-accept" type="button" data-prop-id="' + esc(it.id) + '">' + (decType === 'accept' ? '✓ 已採納' : '✓ 採納建議') + '</button>' : '') +
        '<button class="btn sm' + (decType === 'skip' ? ' accent' : ' ghost') + ' prop-btn-skip" type="button" data-prop-id="' + esc(it.id) + '">' + (decType === 'skip' ? '已略過（點此復原）' : '✕ 略過') + '</button>' +
        (isCustomOverride ? '<span class="pill solid-blue">★ 新分類：' + esc(overrideVal) + '</span>' : '') +
        '</div>' +
        '<div class="cat-combo">' +
        '<input class="cat-combo-input prop-override-sel' + (isCanonicalOverride ? ' filled' : '') + '" data-combo-kind="prop-override" data-prop-override-id="' + esc(it.id) + '" data-selected-val="' + esc(isCanonicalOverride ? overrideVal : '') + '" value="' + esc(isCanonicalOverride ? overrideVal : '') + '" autocomplete="off" placeholder="搜尋改選現有標準分類（如：弹窗）…">' +
        (isCanonicalOverride ? '<button type="button" class="cat-combo-clear" data-clear-prop-override="' + esc(it.id) + '" title="清除改選">✕</button>' : '') +
        '</div>' +
        '<div class="prop-custom-row">' +
        '<select class="cat-select prop-custom-major" data-prop-id="' + esc(it.id) + '" title="選擇自訂新分類的大類">' +
        '<option value="新UI"' + (customMajor === '新UI' ? ' selected' : '') + '>新UI</option>' +
        '<option value="老UI"' + (customMajor === '老UI' ? ' selected' : '') + '>老UI</option>' +
        '<option value="系統UI"' + (customMajor === '系統UI' ? ' selected' : '') + '>系統UI</option>' +
        '</select>' +
        '<input class="prop-custom-minor' + (isCustomOverride ? ' filled' : '') + '" data-prop-id="' + esc(it.id) + '" value="' + esc(isCustomOverride ? customParsed.minor : '') + '" placeholder="或輸入自訂新分類名（例：錢包頁）">' +
        '<button class="btn sm prop-custom-apply" type="button" data-prop-id="' + esc(it.id) + '">套用</button>' +
        '</div>' +
        '</div>' +
        '</div>';
    });

    html += '</div></div>';
  });

  document.getElementById('content').innerHTML = html;
}

function renderSyncDiffView() {
  const ls = DATA.lastSync || null;
  document.getElementById('topbar-title').innerHTML = '<button class="btn sm" id="btn-back">← 返回總覽</button> <span>最近同步變更</span>';
  document.getElementById('topbar-sub').textContent = (ls && ls.syncedAt)
    ? ('同步時間：' + ls.syncedAt.slice(0, 16).replace('T', ' '))
    : '尚未有增量同步變更紀錄';

  if (!ls || ls.isInitialImport || ((!ls.addedScreens || ls.addedScreens.length === 0) && (!ls.removedScreens || ls.removedScreens.length === 0))) {
    window.__currentGroups = new Map();
    window.__currentGroupCards = [];
    document.getElementById('content').innerHTML = '<div class="panel">' +
      '<div class="panel-title"><span>最近同步沒有新增或刪除畫面</span></div>' +
      '<div class="muted" style="line-height:1.8">' +
      (ls && ls.isInitialImport
        ? '最近一次屬於初始建立圖譜匯入（非增量同步），後續當你在 Figma 新增／刪除畫面並執行單頁增量或全檔匯出時，這裡會自動列出所有<strong>新入庫畫面</strong>與<strong>已刪除畫面</strong>。'
        : '當你在 Figma 對某一頁（如 Split Bill）新增或刪除設計稿並用插件重新匯出後，這裡會自動列出本次新入庫的畫面，方便你直接打標與直接入庫。') +
      '</div></div>';
    return;
  }

  const addedRaw = Array.isArray(ls.addedScreens) ? ls.addedScreens : [];
  const removedRaw = Array.isArray(ls.removedScreens) ? ls.removedScreens : [];
  const touchedTxt = (ls.touchedPages && ls.touchedPages.length > 0) ? ls.touchedPages.join('、') : '-';
  const prunedTxt = (ls.prunedPages && ls.prunedPages.length > 0) ? ls.prunedPages.join('、') : '';

  let html = '<div class="detail-hero">' +
    '<div class="detail-hero-row">' +
    '<div><div class="detail-title">最近同步變更 · ' + esc(ls.syncedAt ? ls.syncedAt.slice(0, 16).replace('T', ' ') : '') + '</div>' +
    '<div class="muted" style="margin-top:2px">本次同步頁面：' + esc(touchedTxt) + (prunedTxt ? ' · 已移除整頁：' + esc(prunedTxt) : '') + '</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<span class="pill green">🟢 新入庫 +' + addedRaw.length + ' 畫面</span>' +
    '<span class="pill red">🔴 已刪除 -' + removedRaw.length + ' 畫面</span>' +
    (ls.labelsArchived > 0 ? '<span class="pill amber">歸檔舊標註 ' + ls.labelsArchived + ' 筆</span>' : '') +
    '</div></div>' +
    '<div class="muted">下方新入庫畫面可直接勾選、在 Figma 選中或生成臨時拼板，並用右側下拉分類後點頂部「重建頁面」統一寫入。</div>' +
    '</div>';

  const addedCards = [];
  addedRaw.forEach(function(s) {
    const c = resolveCardForId(s.id);
    if (c) addedCards.push(c);
  });

  const groups = new Map();
  addedCards.forEach(function(c) {
    const pg = c.page || '(未知頁面)';
    if (!groups.has(pg)) groups.set(pg, []);
    groups.get(pg).push(c);
  });
  window.__currentScopePrefix = 'sync-diff::';
  window.__currentGroups = groups;
  window.__currentGroupCards = addedCards;

  if (addedCards.length > 0) {
    html += '<div class="section-hdr" style="cursor:default;margin-top:8px"><h3>🟢 新入庫畫面（' + addedCards.length + '）</h3></div>';
    groups.forEach(function(list, pg) {
      const k = 'sync-diff::' + pg;
      const isOpen = !expandedPages.has('COLLAPSED::' + k);
      const first = list[0];
      const pgId = first ? first.pageId : '';
      html += renderGroupHeaderHtml({
        groupKey: pg,
        toggleKey: k,
        isOpen: isOpen,
        title: (first && first.rawPageName) || pg,
        sourceName: (DATA.isWorkspace && first) ? (first.sourceName || '') : '',
        cards: list,
        totalScreens: list.length,
        noteCnt: countCommentsInCards(list),
        pageKey: pg,
        pageId: pgId,
        primaryBtnClass: 'accent focus-group-all-figma',
        primaryBtnText: '在 Figma 選中 (' + list.length + ')',
        primaryBtnTitle: '在 Figma 中選中此頁所有新入庫畫面',
        focusAllItem: false,
        extraMenuHtml: '<button class="menu-item stage-group-figma" type="button" data-grp-key="' + esc(pg) + '" data-page-key="' + esc(pg) + '" data-page-id="' + esc(pgId) + '">生成本組臨時拼板 (' + list.length + ')</button>'
      });
      list.forEach(function(c) { html += renderScreenRow(c); });
      html += '</div></div>';
    });
  }

  if (removedRaw.length > 0) {
    html += '<div class="section-hdr" style="cursor:default"><h3>🔴 本次同步已從 Figma 刪除（' + removedRaw.length + '）</h3><span class="muted">已從 SQLite 移除，原有分類標註已自動備份到 archivedDeleted</span></div>';
    html += '<div class="panel" style="padding:0;overflow:hidden">';
    removedRaw.forEach(function(s) {
      const prevCat = s.major ? (s.major + (s.minor ? ' / ' + s.minor : '')) : '未標註';
      html += '<div class="screen-row" style="grid-template-columns:210px minmax(220px,1fr) 220px">' +
        '<div>' +
        '<span class="id-link" data-copy="' + esc(rawNodeId(s.id)) + '" title="點擊複製 node_id">' + esc(rawNodeId(s.id)) + '</span>' +
        '<div style="margin-top:4px"><span class="pill red">已刪除</span></div>' +
        '</div>' +
        '<div>' +
        '<div class="layer-name">' + esc(s.name || '(無名)') + '</div>' +
        '<div class="muted" style="margin-top:3px">頁面：' + esc(s.pageName || '-') + '</div>' +
        '</div>' +
        '<div>' +
        '<span class="pill' + (s.major ? ' amber' : '') + '">原分類：' + esc(prevCat) + '</span>' +
        (s.major ? '<div class="muted" style="margin-top:4px">已自動歸檔</div>' : '') +
        '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function renderMain() {
  closeCatComboMenu();
  if (viewMode === 'overview') {
    renderOverview();
  } else if (viewMode === 'sync-diff') {
    renderSyncDiffView();
  } else if (viewMode === 'proposals') {
    renderProposalsView();
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
  } else if (viewMode === 'page') {
    renderPageView(activeKey);
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
    workCards.forEach(function(c) {
      total += c.copies;
      c.memberPages.forEach(function(p) { pages.add(p); });
      (c.palette || []).forEach(function(hx) { pal.set(hx, (pal.get(hx) || 0) + 1); });
    });
    renderDetailView({
      title: DATA.modeLabel,
      sub: '共 ' + total + ' 個畫面（分 ' + workCards.length + ' 組） · ' + pages.size + ' 個 Figma 頁面',
      cards: workCards,
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
  detailFilter = { q: '', arch: '', gen: '', source: '', onlyCommented: false };
  renderAll();
  window.scrollTo(0, 0);
}

function openPage(pageName) {
  viewMode = 'page';
  activeKey = pageName;
  const pRec = figmaPageMap.get(pageName);
  if (pRec && pRec.sourceId) activePageSourceId = pRec.sourceId;
  detailFilter = { q: '', arch: '', gen: '', source: '', onlyCommented: false };
  renderAll();
  window.scrollTo(0, 0);
}

function openFamily(hash) {
  viewMode = 'family';
  activeKey = hash;
  detailFilter = { q: '', arch: '', gen: '', source: '', onlyCommented: false };
  renderAll();
  window.scrollTo(0, 0);
}

function closeAllMenus() {
  document.querySelectorAll('.menu-pop.show').forEach(function(m) { m.classList.remove('show'); });
  document.querySelectorAll('.info-pop.show').forEach(function(p) { p.classList.remove('show'); });
  document.querySelectorAll('.info-btn.active').forEach(function(b) { b.classList.remove('active'); });
}

function updateFocusHighlightInDom() {
  document.querySelectorAll('#content .screen-row').forEach(function(row) {
    const id = row.getAttribute('data-id');
    const on = Boolean(focusedNodeId && id === focusedNodeId);
    row.classList.toggle('focused-row', on);
    const idRow = row.querySelector('.id-link') ? row.querySelector('.id-link').parentNode : null;
    if (!idRow) return;
    let badge = idRow.querySelector('.focus-badge');
    if (on && !badge) {
      badge = document.createElement('span');
      badge.className = 'pill solid-amber focus-badge';
      badge.textContent = '◉ 當前定位';
      idRow.appendChild(badge);
    } else if (!on && badge) {
      badge.remove();
    }
  });
}

function toggleRowSelDom(id, isChecked) {
  document.querySelectorAll('#content .screen-row[data-id="' + CSS.escape(id) + '"]').forEach(function(row) {
    row.classList.toggle('selected', isChecked);
    const chk = row.querySelector('.row-chk');
    if (chk) chk.checked = isChecked;
    const idRow = row.querySelector('.id-link') ? row.querySelector('.id-link').parentNode : null;
    if (!idRow) return;
    let badge = idRow.querySelector('.sel-badge');
    if (isChecked && !badge) {
      badge = document.createElement('span');
      badge.className = 'pill solid-blue sel-badge';
      badge.textContent = '✓ 已選中';
      const focusBadge = idRow.querySelector('.focus-badge');
      if (focusBadge) idRow.insertBefore(badge, focusBadge);
      else idRow.appendChild(badge);
    } else if (!isChecked && badge) {
      badge.remove();
    }
  });
}

// Global menu dismiss
document.addEventListener('click', function(ev) {
  if (!ev.target.closest('.menu-wrap') && !ev.target.closest('.info-wrap')) closeAllMenus();
});
document.addEventListener('keydown', function(ev) {
  if (ev.key === 'Escape') closeAllMenus();
});

// Sidebar events
document.getElementById('btn-home').addEventListener('click', function() {
  viewMode = 'overview';
  activeKey = '';
  renderAll();
  window.scrollTo(0, 0);
});
document.getElementById('seg-cats').addEventListener('click', function() { sbMode = 'categories'; renderSidebar(); });
document.getElementById('seg-pages').addEventListener('click', function() { sbMode = 'pages'; renderSidebar(); });
document.getElementById('seg-fams').addEventListener('click', function() { sbMode = 'families'; renderSidebar(); });
document.getElementById('sb-filter').addEventListener('input', renderSidebar);
document.getElementById('btn-sync-diff-view').addEventListener('click', function() {
  viewMode = 'sync-diff';
  renderAll();
  window.scrollTo(0, 0);
});
document.getElementById('btn-proposals-view').addEventListener('click', function() {
  viewMode = 'proposals';
  renderAll();
  window.scrollTo(0, 0);
});
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

const sbSourcePicker = document.getElementById('sb-source-picker');
if (sbSourcePicker) {
  sbSourcePicker.addEventListener('click', function(ev) {
    const btn = ev.target.closest('[data-pick-source]');
    if (!btn) return;
    activePageSourceId = btn.getAttribute('data-pick-source') || '';
    renderSidebar();
  });
}

document.getElementById('sb-list').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'sb-clear-filter') {
    const inp = document.getElementById('sb-filter');
    if (inp) { inp.value = ''; inp.focus(); }
    renderSidebar();
    return;
  }
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
  const pgEl = ev.target.closest('[data-open-page]');
  if (pgEl) { openPage(pgEl.getAttribute('data-open-page')); return; }
  const famEl = ev.target.closest('[data-open-fam]');
  if (famEl) { openFamily(famEl.getAttribute('data-open-fam')); return; }
});

// Content delegation
document.getElementById('content').addEventListener('click', function(ev) {
  const t = ev.target;
  if (t.classList.contains('menu-toggle-btn')) {
    ev.stopPropagation();
    const wrap = t.closest('.menu-wrap');
    const pop = wrap ? wrap.querySelector('.menu-pop') : null;
    const wasOpen = pop && pop.classList.contains('show');
    closeAllMenus();
    if (pop && !wasOpen) pop.classList.add('show');
    return;
  }

  if (t.id === 'btn-back') { viewMode = 'overview'; activeKey = ''; renderAll(); return; }
  const jumpSrcEl = t.closest('[data-jump-source-pages]');
  if (jumpSrcEl) {
    activePageSourceId = jumpSrcEl.getAttribute('data-jump-source-pages') || '';
    sbMode = 'pages';
    renderSidebar();
    const sbFilterEl = document.getElementById('sb-filter');
    if (sbFilterEl) sbFilterEl.focus();
    return;
  }
  if (t.id === 'btn-open-sync-diff') { viewMode = 'sync-diff'; renderAll(); window.scrollTo(0, 0); return; }
  if (t.id === 'kpi-comments' || t.closest('#kpi-comments')) { viewMode = 'commented'; renderAll(); return; }

  const propFilterBtn = t.closest('[data-prop-filter]');
  if (propFilterBtn) {
    propFilter = propFilterBtn.getAttribute('data-prop-filter') || 'all';
    renderMain();
    return;
  }
  const propGroupBtn = t.closest('[data-prop-group]');
  if (propGroupBtn) {
    propGroupBy = propGroupBtn.getAttribute('data-prop-group') || 'target';
    renderMain();
    return;
  }
  if (t.id === 'btn-accept-all-high') {
    const list = Array.isArray(DATA.proposals) ? DATA.proposals : [];
    let cnt = 0;
    if (!state.proposals) state.proposals = {};
    list.forEach(function(it) {
      if (it.confidence === 'high' && it.suggestedMajor) {
        state.proposals[it.id] = { decision: 'accept' };
        cnt += 1;
      }
    });
    saveState();
    renderAll();
    toast('已採納全部 ' + cnt + ' 筆高把握建議');
    return;
  }
  if (t.classList.contains('prop-accept-group') && window.__propGroups) {
    const gk = t.getAttribute('data-prop-gk') || '';
    const pairs = window.__propGroups.get(gk) || [];
    let cnt = 0;
    if (!state.proposals) state.proposals = {};
    pairs.forEach(function(x) {
      if (x.prop && x.prop.suggestedMajor) {
        state.proposals[x.prop.id] = { decision: 'accept' };
        cnt += 1;
      }
    });
    saveState();
    renderAll();
    toast('已整組採納「' + gk + '」共 ' + cnt + ' 筆');
    return;
  }
  if (t.classList.contains('prop-override-group') && window.__propGroups) {
    const gk = t.getAttribute('data-prop-gk') || '';
    const pairs = window.__propGroups.get(gk) || [];
    if (pairs.length === 0) return;
    pendingPropGroupKey = gk;
    document.getElementById('prop-grp-title').textContent = '整組改分類 · ' + gk;
    document.getElementById('prop-grp-count').textContent = pairs.length + ' 筆';
    const propGrpSel = document.getElementById('prop-grp-sel');
    propGrpSel.value = '';
    propGrpSel.setAttribute('data-selected-val', '');
    propGrpSel.classList.remove('filled');
    document.getElementById('prop-grp-custom-major').value = '新UI';
    const minInp = document.getElementById('prop-grp-custom-minor');
    minInp.value = '';
    document.getElementById('prop-group-modal').classList.add('show');
    setTimeout(function() { propGrpSel.focus(); }, 0);
    return;
  }
  if (t.classList.contains('prop-custom-apply')) {
    const id = t.getAttribute('data-prop-id');
    applyRowCustomCategory(id, t.closest('.prop-row'));
    return;
  }
  if (t.classList.contains('prop-skip-group') && window.__propGroups) {
    const gk = t.getAttribute('data-prop-gk') || '';
    const pairs = window.__propGroups.get(gk) || [];
    if (!state.proposals) state.proposals = {};
    pairs.forEach(function(x) {
      if (x.prop) state.proposals[x.prop.id] = { decision: 'skip' };
    });
    saveState();
    renderAll();
    toast('已整組略過「' + gk + '」共 ' + pairs.length + ' 筆');
    return;
  }
  if (t.classList.contains('prop-focus-group') && window.__propGroups) {
    const gk = t.getAttribute('data-prop-gk') || '';
    const pgId = t.getAttribute('data-page-id') || '';
    const pairs = window.__propGroups.get(gk) || [];
    const ids = pairs.map(function(x) { return x.prop.id; });
    if (ids.length > 0) requestFigmaFocus(ids, gk, { pageId: pgId });
    return;
  }
  if (t.classList.contains('prop-btn-accept')) {
    const id = t.getAttribute('data-prop-id');
    if (id) {
      if (!state.proposals) state.proposals = {};
      const cur = state.proposals[id];
      if (cur && cur.decision === 'accept') delete state.proposals[id];
      else state.proposals[id] = { decision: 'accept' };
      saveState();
      renderAll();
    }
    return;
  }
  if (t.classList.contains('prop-btn-skip')) {
    const id = t.getAttribute('data-prop-id');
    if (id) {
      if (!state.proposals) state.proposals = {};
      const cur = state.proposals[id];
      if (cur && cur.decision === 'skip') delete state.proposals[id];
      else state.proposals[id] = { decision: 'skip' };
      saveState();
      renderAll();
    }
    return;
  }
  if (t.id === 'btn-open-commit-proposals') {
    const commits = collectReadyProposalCommits();
    if (commits.length === 0) {
      toast('請先至少「採納」或「改選」1 筆分類後再落盤');
      return;
    }
    openCommitModal(commits, { mode: 'proposals' });
    return;
  }

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
  if (catEl) { closeAllMenus(); openCategory(catEl.getAttribute('data-open-cat')); return; }
  const pgLinkEl = t.closest('[data-open-page]');
  if (pgLinkEl) { closeAllMenus(); openPage(pgLinkEl.getAttribute('data-open-page')); return; }
  const famEl = t.closest('[data-open-fam]');
  if (famEl) { closeAllMenus(); openFamily(famEl.getAttribute('data-open-fam')); return; }

  const jumpCatChip = t.closest('[data-jump-cat-group]');
  if (jumpCatChip && window.__currentGroups) {
    const label = jumpCatChip.getAttribute('data-jump-cat-group');
    const k = window.__currentScopePrefix + label;
    expandedPages.add(k);
    expandedPages.delete('COLLAPSED::' + k);
    renderMain();
    const wraps = Array.from(document.querySelectorAll('[data-grp-wrap]'));
    const targetWrap = wraps.find(function(w) { return w.getAttribute('data-grp-wrap') === label; });
    if (targetWrap) targetWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (t.classList.contains('id-link')) {
    const id = t.getAttribute('data-copy');
    copyText(id, '已複製 ID: ' + id);
    return;
  }

  if (t.classList.contains('focus-node-btn')) {
    ev.stopPropagation();
    const id = t.getAttribute('data-focus-id');
    focusedNodeId = id;
    updateFocusHighlightInDom();
    const c = resolveCardForId(id);
    const u = state.unrecorded && state.unrecorded[id];
    const label = (c && c.page) || t.getAttribute('data-focus-page') || (u && u.pageName) || rawNodeId(id);
    requestFigmaFocus([rawNodeId(id)], label, c ? { fileKey: c.sourceFileKey, fileName: c.sourceName, pageId: c.rawPageId || rawNodeId(c.pageId || '') } : {});
    return;
  }

  if (t.classList.contains('batch-rename-btn')) {
    ev.stopPropagation();
    renamingBatchId = t.getAttribute('data-batch-id') || '';
    renderMain();
    return;
  }

  if (t.classList.contains('batch-del-btn')) {
    ev.stopPropagation();
    const bid = t.getAttribute('data-batch-id') || '';
    lookupBatches = lookupBatches.filter(function(b) { return b.batchId !== bid; });
    if (activeBatchId === bid) {
      const nextB = lookupBatches[lookupBatches.length - 1] || null;
      activeBatchId = nextB ? nextB.batchId : '';
      selected.clear();
      if (nextB) nextB.matched.forEach(function(m) { selected.add(m.card.id); });
    }
    if (renamingBatchId === bid) renamingBatchId = '';
    renderAll();
    return;
  }

  const switchBatchEl = t.closest('[data-switch-batch]');
  if (switchBatchEl) {
    const bid = switchBatchEl.getAttribute('data-switch-batch') || '';
    const b = lookupBatches.find(function(x) { return x.batchId === bid; });
    if (b) {
      activeBatchId = b.batchId;
      renamingBatchId = '';
      selected.clear();
      b.matched.forEach(function(m) { selected.add(m.card.id); });
      renderAll();
    }
    return;
  }

  if (t.id === 'btn-clear-lookup-batches') {
    lookupBatches = [];
    activeBatchId = '';
    renamingBatchId = '';
    selected.clear();
    renderAll();
    toast('已清空全部臨時批次（已填寫意見不受影響）');
    return;
  }

  if (t.id === 'btn-clear-exported-list') {
    const removed = clearExportedOldComments();
    toast(removed > 0 ? ('已清空 ' + removed + ' 筆已複製的舊意見') : '沒有可清空的已複製舊意見');
    return;
  }

  if (t.id === 'btn-lookup-refocus-all') {
    const curB = getActiveLookupBatch();
    if (!curB || !curB.allNodeIds || curB.allNodeIds.length === 0) return;
    requestFigmaFocus(curB.allNodeIds, curB.name, { pageId: curB.pageId });
    return;
  }

  if (t.id === 'btn-lookup-batch-matched') {
    const curB = getActiveLookupBatch();
    const matched = (curB && curB.matched) || [];
    if (matched.length === 0) return;
    const pg = (curB && curB.pageName) || 'Figma 選中項';
    pendingBatch = { page: pg, ids: matched.map(function(m) { return m.card.id; }) };
    document.getElementById('batch-title').textContent = '批量標註 · ' + pg;
    document.getElementById('batch-count').textContent = '已選中 ' + matched.length + ' 筆';
    const inp = document.getElementById('batch-input');
    inp.value = '';
    const bSel = document.getElementById('batch-cat-select');
    if (bSel) {
      bSel.value = '';
      bSel.setAttribute('data-selected-val', '');
      bSel.classList.remove('filled');
    }
    document.getElementById('batch-modal').classList.add('show');
    setTimeout(function() { (bSel || inp).focus(); }, 0);
    return;
  }

  if (t.classList.contains('unrec-ask-agent')) {
    ev.stopPropagation();
    const id = t.getAttribute('data-unrec-id');
    const curB = getActiveLookupBatch();
    if (!state.unrecorded[id] && curB && curB.unrecorded) {
      const found = curB.unrecorded.find(function(x) { return x.id === id; });
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
    const curB = getActiveLookupBatch();
    const list = (curB && curB.unrecorded) || [];
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
    const curB = getActiveLookupBatch();
    const list = (curB && curB.unrecorded) || [];
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

  if (t.classList.contains('grp-chk')) {
    ev.stopPropagation();
    const gk = t.getAttribute('data-grp-key');
    const list = (window.__currentGroups && window.__currentGroups.get(gk)) || [];
    const want = t.checked;
    list.forEach(function(c) {
      if (want) selected.add(c.id);
      else selected.delete(c.id);
      toggleRowSelDom(c.id, want);
    });
    syncGroupCheckboxes();
    updateFloatBar();
    toast((want ? '已選中「' : '已取消「') + gk + '」共 ' + list.length + ' 筆');
    return;
  }

  if (t.classList.contains('focus-page-figma') || t.id === 'btn-jump-this-page') {
    ev.stopPropagation();
    const pg = t.getAttribute('data-page-key');
    const list = (window.__currentGroups && window.__currentGroups.get(pg)) || window.__currentGroupCards || [];
    const first = list[0];
    const pgId = t.getAttribute('data-page-id') || (first ? first.pageId : '');
    const tgt = list.length > 0 ? collectBridgeTarget(list, pgId) : { rawIds: [], rawPageId: rawNodeId(pgId), fileKey: DATA.fileKey, fileName: DATA.fileName };
    if (tgt.error) { toast(tgt.error); return; }
    requestFigmaFocus(first ? [rawNodeId(first.id)] : [], pg, { pageOnly: true, pageId: tgt.rawPageId, fileKey: tgt.fileKey, fileName: tgt.fileName });
    return;
  }

  if (t.classList.contains('focus-group-all-figma')) {
    ev.stopPropagation();
    closeAllMenus();
    const gk = t.getAttribute('data-grp-key');
    const pg = t.getAttribute('data-page-key') || gk;
    const pgId = t.getAttribute('data-page-id') || '';
    const list = (window.__currentGroups && window.__currentGroups.get(gk)) || [];
    const tgt = collectBridgeTarget(list, pgId);
    if (tgt.error) { toast(tgt.error); return; }
    if (tgt.rawIds.length > 200 && !confirm('這組共有 ' + tgt.rawIds.length + ' 個 Figma 節點，確定要一次全部在 Figma 中選中嗎？')) return;
    requestFigmaFocus(tgt.rawIds, pg + ' · ' + gk, { pageId: tgt.rawPageId, fileKey: tgt.fileKey, fileName: tgt.fileName });
    return;
  }

  if (t.classList.contains('stage-group-figma')) {
    ev.stopPropagation();
    closeAllMenus();
    const gk = t.getAttribute('data-grp-key');
    const pg = t.getAttribute('data-page-key') || gk;
    const pgId = t.getAttribute('data-page-id') || '';
    const list = (window.__currentGroups && window.__currentGroups.get(gk)) || [];
    const tgt = collectBridgeTarget(list, pgId);
    if (tgt.error) { toast(tgt.error); return; }
    requestFigmaStageBoard(tgt.rawIds, pg + ' · ' + gk, { targetPageId: tgt.rawPageId, fileKey: tgt.fileKey, fileName: tgt.fileName });
    return;
  }

  if (t.id === 'btn-focus-page-all-recorded') {
    ev.stopPropagation();
    closeAllMenus();
    const pg = t.getAttribute('data-page-key');
    const pgId = t.getAttribute('data-page-id') || '';
    const pRec = figmaPageMap.get(pg);
    const tgt = pRec
      ? collectBridgeTarget(pRec.cards, pRec.pageId || pgId)
      : collectBridgeTarget(window.__currentGroupCards || [], pgId);
    if (tgt.error) { toast(tgt.error); return; }
    if (tgt.rawIds.length === 0) { toast('本頁目前沒有已收錄的設計稿'); return; }
    if (tgt.rawIds.length > 200 && !confirm('本頁共有 ' + tgt.rawIds.length + ' 個已收錄畫面，一次在 Figma 全選可能會短暫卡頓，確定要全部選中用來對照畫布查漏嗎？')) return;
    requestFigmaFocus(tgt.rawIds, pg + '（全部已收錄）', { pageId: tgt.rawPageId, fileKey: tgt.fileKey, fileName: tgt.fileName });
    return;
  }

  if (t.classList.contains('copy-group-ids-btn')) {
    ev.stopPropagation();
    closeAllMenus();
    const gk = t.getAttribute('data-grp-key');
    const list = (window.__currentGroups && window.__currentGroups.get(gk)) || [];
    copyText(list.map(function(c) { return c.rawId || rawNodeId(c.id); }).join(String.fromCharCode(10)), '已複製「' + gk + '」' + list.length + ' 個 ID');
    return;
  }

  if (t.id === 'btn-expand-pages' && window.__currentGroups) {
    closeAllMenus();
    window.__currentGroups.forEach(function(_, k) {
      const key = window.__currentScopePrefix + k;
      expandedPages.add(key);
      expandedPages.delete('COLLAPSED::' + key);
    });
    renderMain();
    return;
  }
  if (t.id === 'btn-collapse-pages' && window.__currentGroups) {
    closeAllMenus();
    window.__currentGroups.forEach(function(_, k) {
      const key = window.__currentScopePrefix + k;
      expandedPages.delete(key);
      expandedPages.add('COLLAPSED::' + key);
    });
    renderMain();
    return;
  }
  if (t.id === 'btn-copy-group-ids') {
    closeAllMenus();
    const list = window.__currentGroupCards || [];
    copyText(list.map(function(c) { return c.rawId || rawNodeId(c.id); }).join(String.fromCharCode(10)), '已複製 ' + list.length + ' 個 ID');
    return;
  }

  const pgHdr = t.closest('[data-toggle-page]');
  if (pgHdr) {
    const k = pgHdr.getAttribute('data-toggle-page');
    const wasOpen = !pgHdr.classList.contains('collapsed-hdr');
    if (wasOpen) {
      expandedPages.delete(k);
      expandedPages.add('COLLAPSED::' + k);
    } else {
      expandedPages.add(k);
      expandedPages.delete('COLLAPSED::' + k);
    }
    renderMain();
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
          toggleRowSelDom(ids[i], t.checked);
        }
      }
    } else {
      if (t.checked) selected.add(id);
      else selected.delete(id);
      toggleRowSelDom(id, t.checked);
    }
    lastClickedId = id;
    syncGroupCheckboxes();
    updateFloatBar();
    return;
  }

  // Clicking non-interactive area of a screen row marks it as the active focus bookmark
  const rowEl = t.closest('.screen-row');
  if (rowEl && !t.closest('input, select, textarea, button, a, .id-link')) {
    focusedNodeId = rowEl.getAttribute('data-id') || '';
    updateFocusHighlightInDom();
  }
});

function updateRowDirectHint(row, text) {
  if (!row) return;
  const hint = row.querySelector('.direct-hint');
  if (!hint) return;
  const meta = parseDirectCategoryNote(text);
  hint.textContent = meta ? ('✓ 確定分類（' + meta.target + '）· 可直接入庫') : '';
}

function applyQuickCat(inp) {
  if (!inp) return;
  const id = inp.getAttribute('data-quick-cat-id');
  const val = (inp.value || '').trim();
  if (!id || !val) return;
  state.items[id] = val;
  const row = inp.closest('.screen-row');
  if (row) {
    row.classList.add('has-note');
    const ta = row.querySelector('.item-comment');
    if (ta) {
      ta.value = val;
      ta.classList.add('filled');
    }
    updateRowDirectHint(row, val);
  }
  inp.value = '';
  saveState();
  renderSidebar();
  toast('已套用標準分類：' + val);
}

function applyRowCustomCategory(propId, rowEl) {
  if (!propId || !rowEl) return;
  const majSel = rowEl.querySelector('.prop-custom-major');
  const minInp = rowEl.querySelector('.prop-custom-minor');
  const maj = majSel ? majSel.value : '新UI';
  const rawMin = minInp ? minInp.value : '';
  const target = buildCustomCategoryTarget(maj, rawMin);
  if (!target) {
    toast('請先輸入新分類名稱（例如：錢包頁）');
    if (minInp) minInp.focus();
    return;
  }
  if (!state.proposals) state.proposals = {};
  state.proposals[propId] = { decision: 'override', target: target, isCustom: true };
  saveState();
  renderAll();
  toast('已套用自訂新分類：' + target);
}

document.getElementById('content').addEventListener('input', function(ev) {
  const t = ev.target;
  if (t.id === 'dt-q') { detailFilter.q = t.value; renderMain(); document.getElementById('dt-q').focus(); return; }
  if (t.classList.contains('item-comment')) {
    const id = t.getAttribute('data-id');
    state.items[id] = t.value;
    t.classList.toggle('filled', t.value.trim().length > 0);
    const row = t.closest('.screen-row');
    if (row) {
      row.classList.toggle('has-note', t.value.trim().length > 0);
      updateRowDirectHint(row, t.value);
    }
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
  if (t.id === 'dt-source') { detailFilter.source = t.value; renderMain(); }
  else if (t.id === 'dt-arch') { detailFilter.arch = t.value; renderMain(); }
  else if (t.id === 'dt-gen') { detailFilter.gen = t.value; renderMain(); }
  else if (t.id === 'dt-only-comment') { detailFilter.onlyCommented = t.checked; renderMain(); }
});

function commitBatchRename(inp) {
  if (!inp || !renamingBatchId) return;
  const bid = inp.getAttribute('data-rename-batch-id');
  if (bid !== renamingBatchId) return;
  const b = lookupBatches.find(function(x) { return x.batchId === bid; });
  const nextName = (inp.value || '').trim();
  if (b && nextName) b.name = nextName;
  renamingBatchId = '';
  renderAll();
}

document.getElementById('content').addEventListener('keydown', function(ev) {
  const t = ev.target;
  if (!t || !t.classList) return;
  if (t.classList.contains('prop-custom-minor') && ev.key === 'Enter') {
    ev.preventDefault();
    applyRowCustomCategory(t.getAttribute('data-prop-id'), t.closest('.prop-row'));
    return;
  }
  if (!t.classList.contains('batch-rename-input')) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    commitBatchRename(t);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    renamingBatchId = '';
    renderAll();
  }
});

document.getElementById('content').addEventListener('focusout', function(ev) {
  const t = ev.target;
  if (t && t.classList && t.classList.contains('batch-rename-input')) {
    commitBatchRename(t);
  }
});

// Topbar & float bar actions
document.getElementById('topbar-title').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'btn-back') {
    viewMode = 'overview';
    activeKey = '';
    renderAll();
  }
});

document.getElementById('btn-top-menu').addEventListener('click', function(ev) {
  ev.stopPropagation();
  const pop = document.getElementById('top-menu-pop');
  const was = pop.classList.contains('show');
  closeAllMenus();
  if (!was) pop.classList.add('show');
});
document.getElementById('menu-show-spec').addEventListener('click', function() {
  closeAllMenus();
  const s = DATA.screenSpec || {};
  toast('畫布識別規則：寬 ' + (s.widths || []).join('/') + ' (±' + (s.widthTolerance || 6) + 'px)，高 ' + (s.minHeight || 600) + '–' + (s.maxHeight || 12000) + 'px，最小節點 ' + (s.minNodes || 40));
});
document.getElementById('menu-clear-all').addEventListener('click', function() {
  closeAllMenus();
  if (!confirm('確定要清空本專案所有已填寫的意見嗎？此操作無法復原。')) return;
  state.categories = {};
  state.families = {};
  state.items = {};
  state.unrecorded = {};
  state.proposals = {};
  state.exported = emptyExported();
  saveState();
  renderAll();
  toast('已清空所有意見');
});

document.getElementById('btn-copy-ids').addEventListener('click', function() {
  const ids = Array.from(selected).map(rawNodeId);
  copyText(ids.join(String.fromCharCode(10)), '已複製 ' + ids.length + ' 個 ID');
});
document.getElementById('btn-batch-selected').addEventListener('click', function() {
  const list = Array.from(selected).map(function(id) { return resolveCardForId(id); }).filter(Boolean);
  if (list.length === 0) return;
  const pages = Array.from(new Set(list.map(function(c) { return c.page || '(未知頁面)'; })));
  if (pages.length > 1) {
    toast('不支援跨頁批量標註，請先取消其他頁面的勾選後再操作（目前跨 ' + pages.length + ' 頁）');
    return;
  }
  const pg = (list[0] && list[0].rawPageName) || pages[0];
  pendingBatch = { page: pg, ids: list.map(function(c) { return c.id; }) };
  document.getElementById('batch-title').textContent = '批量標註 · ' + pg;
  document.getElementById('batch-count').textContent = '已選中 ' + list.length + ' 筆';
  const inp = document.getElementById('batch-input');
  inp.value = '';
  const bSel = document.getElementById('batch-cat-select');
  if (bSel) {
    bSel.value = '';
    bSel.setAttribute('data-selected-val', '');
    bSel.classList.remove('filled');
  }
  document.getElementById('batch-modal').classList.add('show');
  setTimeout(function() { (bSel || inp).focus(); }, 0);
});
document.getElementById('btn-focus-selected').addEventListener('click', function() {
  const list = Array.from(selected).map(function(id) { return resolveCardForId(id); }).filter(Boolean);
  if (list.length === 0) return;
  const pages = Array.from(new Set(list.map(function(c) { return c.pageId || c.page || '?'; })));
  if (pages.length > 1) {
    toast('已選項目跨 ' + pages.length + ' 個頁面，Figma 不支援跨頁同時選中，請單頁勾選後再定位');
    return;
  }
  const pgId = list[0].pageId || '';
  const tgt = collectBridgeTarget(list, pgId);
  if (tgt.error) { toast(tgt.error); return; }
  requestFigmaFocus(tgt.rawIds, list[0].page || rawNodeId(list[0].id), { pageId: tgt.rawPageId, fileKey: tgt.fileKey, fileName: tgt.fileName });
});
document.getElementById('btn-stage-selected').addEventListener('click', function() {
  const list = Array.from(selected).map(function(id) { return resolveCardForId(id); }).filter(Boolean);
  if (list.length === 0) return;
  const pages = Array.from(new Set(list.map(function(c) { return c.pageId || c.page || '?'; })));
  const singlePageId = pages.length === 1 ? (list[0].pageId || '') : '';
  const titleTxt = pages.length === 1
    ? ((list[0].page || '選中畫面'))
    : ('跨 ' + pages.length + ' 頁選中 (' + list.length + ' 組)');
  const tgt = collectBridgeTarget(list, singlePageId);
  if (tgt.error) { toast(tgt.error); return; }
  requestFigmaStageBoard(tgt.rawIds, titleTxt, { targetPageId: tgt.rawPageId || undefined, fileKey: tgt.fileKey, fileName: tgt.fileName });
});
document.getElementById('btn-stage-info').addEventListener('click', function(ev) {
  ev.stopPropagation();
  const pop = document.getElementById('stage-info-pop');
  const was = pop.classList.contains('show');
  closeAllMenus();
  if (!was) {
    pop.classList.add('show');
    this.classList.add('active');
  }
});
document.getElementById('btn-sel-clear').addEventListener('click', function() {
  selected.clear();
  renderMain();
  updateFloatBar();
});

let activeModalSnap = null;

function buildAgentPrompt(setsOverride) {
  const BT = String.fromCharCode(96);
  const NL = String.fromCharCode(10);
  const onlyUnsentEl = document.getElementById('only-unsent');
  const onlyUnsent = Boolean(onlyUnsentEl && onlyUnsentEl.checked);
  const sets = setsOverride || collectCommentSets(onlyUnsent);
  const catEntries = sets.catEntries;
  const famEntries = sets.famEntries;
  const itemIds = sets.itemIds;
  const unrecIds = sets.unrecIds;

  const targetLabels = DATA.labelsPath || 'labels/screens-v2.json';
  const lines = [];
  lines.push('請根據以下我在 Rea-FigmaDesign 複審工作台填寫的人工核對意見，協助核查並整理要寫入 ' + BT + targetLabels + BT + '（專案：' + (DATA.projectId || 'default') + '）的修改方案：');
  lines.push('');

  if (document.getElementById('include-scope').checked) {
    lines.push('## 核對範圍');
    lines.push('- 專案：' + BT + (DATA.projectId || 'default') + BT + '（' + (DATA.fileName || '') + '）');
    lines.push('- 圖譜：' + BT + DATA.db + BT);
    lines.push('- 標註檔：' + BT + targetLabels + BT);
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
      const c = resolveCardForId(id);
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
  lines.push('1. 請只針對上述有填寫意見的分類、家族或 ID 核對 SQLite 與 ' + BT + targetLabels + BT + '，不要改動未提及的標註。');
  lines.push('2. 若單筆有同構複本（copies > 1）或屬於 AST 家族，請先用 ' + BT + 'apply_labels(project: "' + (DATA.projectId || '') + '", dryRun: true)' + BT + ' 列出受影響的所有 node_id 與修改前後對照表。');
  lines.push('3. 等我確認對照表後再正式寫入 ' + BT + targetLabels + BT + '。');
  if (unrecIds.length > 0) {
    lines.push('4. 針對「四、Figma 未收錄新畫面」，請先檢查 SQLite 是否已匯入對應 node_id；若尚未匯入請提醒我先在插件重新匯出該頁面，再協助歸類並列出要寫入 ' + BT + targetLabels + BT + ' 的新增方案供確認（必要時可用 ' + BT + 'configure_project' + BT + ' 調整本專案畫布識別規則）。');
  }
  return lines.join(NL);
}

function refreshModalPreview() {
  const onlyUnsent = document.getElementById('only-unsent').checked;
  const sets = activeModalSnap
    ? (onlyUnsent ? activeModalSnap.unsentSets : activeModalSnap.allSets)
    : collectCommentSets(onlyUnsent);
  document.getElementById('modal-text').value = buildAgentPrompt(sets);
}

function showPromptModal() {
  const unsentSets = collectCommentSets(true);
  const allSets = collectCommentSets(false);
  const unsentCnt = countSets(unsentSets);
  const allCnt = countSets(allSets);
  const exportedCnt = Math.max(0, allCnt - unsentCnt);
  const defaultOnlyUnsent = exportedCnt > 0 && unsentCnt > 0;

  document.getElementById('only-unsent').checked = defaultOnlyUnsent;
  activeModalSnap = { unsentSets: unsentSets, allSets: allSets };
  const chosenSets = defaultOnlyUnsent ? unsentSets : allSets;
  const prompt = buildAgentPrompt(chosenSets);
  document.getElementById('modal-text').value = prompt;

  const clrBtn = document.getElementById('modal-clear-exported');
  if (allCnt > 0) {
    clrBtn.style.display = '';
    clrBtn.textContent = '清空已複製舊意見 (' + allCnt + ')';
  } else {
    clrBtn.style.display = 'none';
  }

  document.getElementById('modal').classList.add('show');
  if (countSets(chosenSets) > 0) markSetsAsExported(chosenSets);
  copyText(prompt, defaultOnlyUnsent ? ('已僅複製本次新增／修改的 ' + unsentCnt + ' 筆意見') : '已複製 Agent 提示詞到剪貼簿');
}

document.getElementById('btn-prompt').addEventListener('click', showPromptModal);
document.getElementById('only-unsent').addEventListener('change', refreshModalPreview);
document.getElementById('include-scope').addEventListener('change', refreshModalPreview);
document.getElementById('modal-clear-exported').addEventListener('click', function() {
  const removed = clearExportedOldComments();
  document.getElementById('modal').classList.remove('show');
  activeModalSnap = null;
  toast(removed > 0 ? ('已清空 ' + removed + ' 筆已複製的舊意見') : '沒有可清空的舊意見');
});
document.getElementById('modal-copy').addEventListener('click', function() {
  copyText(document.getElementById('modal-text').value, '已重新複製到剪貼簿');
});
document.getElementById('modal-close').addEventListener('click', function() {
  document.getElementById('modal').classList.remove('show');
  activeModalSnap = null;
});
document.getElementById('modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'modal') {
    this.classList.remove('show');
    activeModalSnap = null;
  }
});

function closeBatchModal() {
  closeCatComboMenu();
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
  toast('已標註「' + pageName + '」共 ' + count + ' 筆（可繼續標註，全部完成後點頂部「重建頁面」統一寫入）');
}
function openCommitModal(commits, opts) {
  pendingCommitItems = commits;
  pendingCommitContext = {
    mode: (opts && opts.mode) || 'proposals',
    sourceItemKeys: (opts && opts.sourceItemKeys) || []
  };
  document.getElementById('commit-count').textContent = commits.length + ' 筆';
  const byTarget = new Map();
  commits.forEach(function(c) {
    const k = c.major + (c.minor ? ' / ' + c.minor : '');
    byTarget.set(k, (byTarget.get(k) || 0) + 1);
  });
  const sumHtml = Array.from(byTarget.entries())
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(pair) {
      const isNew = !(window.__canonicalCatSet && window.__canonicalCatSet.has(pair[0]));
      return '<div>• <strong>' + esc(pair[0]) + '</strong>：' + pair[1] + ' 筆' + (isNew ? ' <span class="pill accent">自訂新分類</span>' : '') + '</div>';
    }).join('');
  document.getElementById('commit-summary').innerHTML = sumHtml;
  const directBtn = document.getElementById('commit-confirm-direct');
  directBtn.disabled = false;
  directBtn.textContent = bridgeWsOpen ? '確定直接落盤並刷新' : '嘗試連線直寫落盤（離線會改複製指令）';
  document.getElementById('commit-modal').classList.add('show');
}

document.getElementById('btn-direct-commit').addEventListener('click', function() {
  const direct = collectDirectLabelCommits();
  if (direct.commits.length === 0) {
    toast('目前沒有待寫入的確定分類（先在下方標註標準分類後即可點此寫入並重建頁面）');
    return;
  }
  openCommitModal(direct.commits, { mode: 'direct', sourceItemKeys: direct.sourceItemKeys });
});

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

document.getElementById('commit-cancel').addEventListener('click', function() {
  document.getElementById('commit-modal').classList.remove('show');
});
document.getElementById('commit-modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'commit-modal') this.classList.remove('show');
});
document.getElementById('commit-copy-fallback').addEventListener('click', function() {
  if (!pendingCommitItems || pendingCommitItems.length === 0) return;
  const prompt = buildProposalFallbackPrompt(pendingCommitItems);
  document.getElementById('commit-modal').classList.remove('show');
  copyText(prompt, '已複製 ' + pendingCommitItems.length + ' 筆落盤指令到剪貼簿，可直接貼給 Agent');
});
document.getElementById('commit-confirm-direct').addEventListener('click', function() {
  if (!pendingCommitItems || pendingCommitItems.length === 0) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = '正在寫入並重建看板…';
  fetch('http://127.0.0.1:8765/api/apply-proposals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: DATA.projectId,
      confirm: true,
      items: pendingCommitItems
    })
  }).then(function(r) { return r.json(); }).then(function(res) {
    if (!res || !res.ok) {
      btn.disabled = false;
      btn.textContent = '確定直接落盤並刷新';
      toast('落盤失敗：' + ((res && res.error) || '未知錯誤'));
      return;
    }
    if (!state.proposals) state.proposals = {};
    pendingCommitItems.forEach(function(it) { delete state.proposals[it.id]; });
    if (pendingCommitContext && pendingCommitContext.mode === 'direct') {
      (pendingCommitContext.sourceItemKeys || []).forEach(function(k) {
        delete state.items[k];
        if (state.exported && state.exported.items) delete state.exported.items[k];
      });
    }
    saveState();
    document.getElementById('commit-modal').classList.remove('show');
    toast('已成功落盤 ' + res.applied + ' 筆並重建看板，即將刷新…');
    setTimeout(function() { location.reload(); }, 700);
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = '確定直接落盤並刷新';
    const prompt = buildProposalFallbackPrompt(pendingCommitItems);
    copyText(prompt, '本地服務未連線，已改為複製落盤指令到剪貼簿');
  });
});

function closePropGroupModal() {
  closeCatComboMenu();
  document.getElementById('prop-group-modal').classList.remove('show');
  pendingPropGroupKey = '';
}
function applyPropGroupModal() {
  if (!pendingPropGroupKey || !window.__propGroups) {
    closePropGroupModal();
    return;
  }
  const pgSel = document.getElementById('prop-grp-sel');
  const selVal = ((pgSel && (pgSel.getAttribute('data-selected-val') || pgSel.value)) || '').trim();
  const majVal = (document.getElementById('prop-grp-custom-major').value || '新UI').trim();
  const minVal = (document.getElementById('prop-grp-custom-minor').value || '').trim();
  const customTarget = buildCustomCategoryTarget(majVal, minVal);
  const target = selVal || customTarget;
  const isCustom = !selVal && Boolean(customTarget);
  if (!target) {
    toast('請搜尋／選擇現有標準分類，或輸入自訂新分類名稱');
    return;
  }
  const pairs = window.__propGroups.get(pendingPropGroupKey) || [];
  if (!state.proposals) state.proposals = {};
  let cnt = 0;
  pairs.forEach(function(x) {
    if (!x.prop) return;
    state.proposals[x.prop.id] = isCustom
      ? { decision: 'override', target: target, isCustom: true }
      : { decision: 'override', target: target };
    cnt += 1;
  });
  saveState();
  closePropGroupModal();
  renderAll();
  toast('已將本組 ' + cnt + ' 筆改為' + (isCustom ? '自訂新分類' : '標準分類') + '：' + target);
}
document.getElementById('prop-grp-custom-minor').addEventListener('input', function() {
  if ((this.value || '').trim()) {
    const pgSel = document.getElementById('prop-grp-sel');
    if (pgSel) {
      pgSel.value = '';
      pgSel.setAttribute('data-selected-val', '');
      pgSel.classList.remove('filled');
    }
  }
});
document.getElementById('prop-grp-custom-minor').addEventListener('keydown', function(ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    applyPropGroupModal();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closePropGroupModal();
  }
});
document.getElementById('prop-grp-cancel').addEventListener('click', closePropGroupModal);
document.getElementById('prop-group-modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'prop-group-modal') closePropGroupModal();
});
document.getElementById('prop-grp-apply').addEventListener('click', applyPropGroupModal);

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
    projectId: boardId,
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
  let projectId = '';
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
    if (a === '--project') projectId = args[++i] ?? '';
    else if (a === '--db') dbFlag = args[++i] ?? '';
    else if (a === '--category') category = args[++i] ?? '';
    else if (a === '--page') page = args[++i] ?? '';
    else if (a === '--unlabeled') unlabeled = true;
    else if (a === '--sample') sample = Math.max(1, Number(args[++i] ?? 10) || 10);
    else if (a === '--ids') ids = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') outPath = args[++i] ?? '';
    else if (a === '--open') open = true;
    else if (!a.startsWith('--') && !dbFlag) dbFlag = a;
  }

  try {
    if (projectId || dbFlag || outPath || category || page || unlabeled || sample > 0 || ids.length > 0) {
      const res = generateReviewBoard({
        projectId: projectId || undefined,
        dbPath: dbFlag || undefined,
        category,
        page,
        unlabeled,
        sample,
        ids,
        outPath,
        open,
      });
      console.log('project board written · project=' + res.projectId + ' unique=' + res.unique + ' screens=' + res.screens + ' path=' + res.html);
      if (!outPath) {
        const hub = generateProjectHub(ROOT);
        console.log('review.html (Project Hub) written · projects=' + hub.projects + ' path=' + hub.html);
      }
    } else {
      const projects = listProjects(ROOT);
      if (projects.length === 0) throw new Error('no database found; run the Figma extraction first');
      for (const p of projects) {
        const res = generateReviewBoard({ projectId: p.id, dbPath: p.dbPath, open: false });
        console.log('project board written · project=' + res.projectId + ' unique=' + res.unique + ' screens=' + res.screens + ' path=' + res.html);
      }
      for (const ws of listWorkspaces(ROOT)) {
        if (ws.sourceProjects.length === 0) continue;
        const res = generateReviewBoard({ projectId: ws.id, open: false });
        console.log('workspace board written · workspace=' + res.projectId + ' unique=' + res.unique + ' screens=' + res.screens + ' path=' + res.html);
      }
      const hub = generateProjectHub(ROOT);
      console.log('review.html (Project Hub) written · projects=' + hub.projects + ' path=' + hub.html);
      if (open && process.platform === 'darwin') {
        spawn('/usr/bin/open', [hub.html], { detached: true, stdio: 'ignore' }).unref();
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
