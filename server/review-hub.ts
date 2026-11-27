/// <reference lib="es2022" />
/**
 * Project Hub Generator — renders the multi-project landing page (.scratch/review.html)
 * listing every isolated Figma project under data/<projectId>/graph.sqlite.
 *
 * Designers land here first (Figma-file-browser style, simplified), see each project's
 * isolated storage, canvas rules, labeling progress and live Figma connection state,
 * then click into ./review-<projectId>.html.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_SCREEN_SPEC,
  listProjects,
  listWorkspaces,
  PC_WEB_SCREEN_SPEC,
  type ProjectInfo,
  type ScreenSpec,
} from './core/projects';
import { buildInlineSearchZhJs } from './core/search-zh';

const ROOT = resolve(__dirname, '..');
const SCRATCH = resolve(ROOT, '.scratch');

export interface ProjectHubResult {
  html: string;
  projects: number;
  workspaces: number;
}

function summarizeSpec(s: Pick<ScreenSpec, 'widths' | 'minHeight' | 'maxHeight'>): string {
  const w = s.widths.length > 3 ? (Math.min(...s.widths) + '–' + Math.max(...s.widths)) : s.widths.join('/');
  return '寬 ' + w + ' · 高 ' + s.minHeight + '–' + s.maxHeight;
}

export function generateProjectHub(root: string = ROOT, outPath?: string): ProjectHubResult {
  const absOut = outPath ? resolve(root, outPath) : join(root, '.scratch', 'review.html');
  const projects = listProjects(root);
  const workspaces = listWorkspaces(root);

  const cards = projects.map((p) => ({
    id: p.id,
    name: p.name,
    fileKey: p.fileKey,
    fileName: p.fileName || p.name,
    dbRelPath: relative(root, p.dbPath).replace(/\\/g, '/'),
    labelsRelPath: p.labelsRelPath,
    reviewHref: './' + p.reviewHtmlName,
    specLabel: summarizeSpec(p.config.screenSpec),
    pagesTotal: p.pagesTotal,
    pagesDone: p.pagesDone,
    nodesCount: p.nodesCount,
    labeledCount: p.labeledCount,
    majorCounts: p.majorCounts,
    updatedAt: p.updatedAt ? p.updatedAt.slice(0, 16).replace('T', ' ') : '-',
    updatedMs: p.updatedMs,
    palette: p.id === 'file-1d40063501'
      ? ['#388bfd', '#161b22', '#3fb950', '#e6edf3', '#bc8cff']
      : ['#10b981', '#141a24', '#f59e0b', '#e6edf3', '#06b6d4'],
  }));

  const wsCards = workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    isWorkspace: true,
    sourceIds: ws.sources,
    sources: ws.sourceProjects.map((s) => ({
      id: s.id,
      fileKey: s.fileKey,
      fileName: s.fileName || s.name,
    })),
    screenSpec: ws.config.screenSpec,
    labelsRelPath: ws.labelsRelPath,
    reviewHref: './' + ws.reviewHtmlName,
    specLabel: summarizeSpec(ws.config.screenSpec),
    pagesTotal: ws.pagesTotal,
    pagesDone: ws.pagesDone,
    nodesCount: ws.nodesCount,
    labeledCount: ws.labeledCount,
    majorCounts: ws.majorCounts,
    updatedAt: ws.updatedAt ? ws.updatedAt.slice(0, 16).replace('T', ' ') : '-',
    updatedMs: ws.updatedMs,
    palette: ['#8250df', '#0969da', '#10b981', '#e6edf3', '#f59e0b'],
  }));

  const payload = JSON.stringify({
    projects: cards,
    workspaces: wsCards,
    mobileSpec: DEFAULT_SCREEN_SPEC,
    pcWebSpec: PC_WEB_SCREEN_SPEC,
  }).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rea-FigmaDesign · 專案空間（Project Hub）</title>
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
    --accent: #0969da;
    --accent-bg: #e8f1ff;
    --green: #1a7f37;
    --green-bg: #dafbe1;
    --amber: #9a6700;
    --amber-bg: #fff8c5;
    --purple: #8250df;
    --shadow: 0 10px 26px rgba(31, 35, 40, 0.08);
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.5 -apple-system, "PingFang TC", "Microsoft YaHei", system-ui, sans-serif;
    min-height: 100vh;
  }
  .topbar {
    position: sticky; top: 0; z-index: 30;
    background: var(--bg-elev); border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
  .logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), var(--purple)); }
  .sub-tag { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .spacer { flex: 1; }
  input, select {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 7px 11px; font-size: 12.5px; font-family: inherit;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .btn {
    background: var(--bg-soft); border: 1px solid var(--border); color: var(--text);
    padding: 7px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
    cursor: pointer; display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
  }
  .btn:hover { background: var(--bg-hover); }
  .btn.accent { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.accent:hover { filter: brightness(1.08); }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600;
    background: var(--bg-soft); color: var(--text-muted); white-space: nowrap;
  }
  .pill.green { background: var(--green-bg); color: var(--green); }
  .pill.amber { background: var(--amber-bg); color: var(--amber); }
  .pill.accent { background: var(--accent-bg); color: var(--accent); }

  .wrap { max-width: 1240px; margin: 0 auto; padding: 24px 24px 72px; }
  .banner {
    background: var(--accent-bg); border: 1px solid rgba(56, 139, 253, 0.3);
    border-radius: var(--radius); padding: 13px 16px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin-bottom: 18px;
  }
  .banner .muted { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

  .toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin-bottom: 18px;
  }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    background: var(--bg-elev); border: 1px solid var(--border); color: var(--text-muted);
    padding: 5px 12px; border-radius: 99px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .chip.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }
  .tools-right { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .seg {
    display: inline-flex; background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: 8px; padding: 2px;
  }
  .seg button {
    border: 0; background: transparent; color: var(--text-muted);
    padding: 4px 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; cursor: pointer;
  }
  .seg button.active { background: var(--accent); color: #fff; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; }
  .grid.list-mode { grid-template-columns: 1fr; }
  .pcard {
    background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden; display: flex; flex-direction: column; cursor: pointer;
    text-decoration: none; color: inherit;
    transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
  }
  .pcard:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow); }
  .grid.list-mode .pcard { flex-direction: row; align-items: stretch; }
  .cover {
    height: 112px; padding: 12px 14px; border-bottom: 1px solid var(--border-soft);
    display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;
  }
  .grid.list-mode .cover { width: 230px; flex: 0 0 230px; height: auto; border-bottom: 0; border-right: 1px solid var(--border-soft); }
  .cover-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .mini-screens { display: flex; gap: 8px; align-items: flex-end; margin-top: 8px; }
  .ms {
    width: 42px; height: 54px; border-radius: 7px; border: 1px solid rgba(31,35,40,0.12);
    background: #ffffff;
    padding: 5px; display: flex; flex-direction: column; gap: 4px;
    box-shadow: 0 3px 8px rgba(31,35,40,0.08);
  }
  .ms-bar { height: 6px; border-radius: 3px; width: 70%; }
  .ms-card { flex: 1; border-radius: 4px; opacity: 0.88; }

  .pbody { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .ptitle-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .ptitle { font-size: 16px; font-weight: 700; line-height: 1.3; }
  .stats-line { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .stats-line b { color: var(--text); }
  .iso-meta {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
    padding-top: 8px; border-top: 1px solid var(--border-soft); font-size: 11px; color: var(--text-muted);
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    background: var(--bg-soft); border: 1px solid var(--border); padding: 1px 6px; border-radius: 5px; color: var(--text);
  }
  .add-card {
    border: 1.5px dashed var(--border); border-radius: var(--radius); background: transparent; min-height: 240px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    padding: 20px; text-align: center; color: var(--text-muted); cursor: pointer;
    transition: border-color 0.14s, background 0.14s;
  }
  .add-card:hover { border-color: var(--accent); background: var(--accent-bg); color: var(--text); }
  .add-plus {
    width: 40px; height: 40px; border-radius: 99px; background: var(--bg-soft); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 600; color: var(--accent);
  }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.62);
    display: none; align-items: center; justify-content: center; z-index: 60; padding: 18px;
  }
  .modal-backdrop.show { display: flex; }
  .modal {
    width: min(520px, 100%); background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 20px; box-shadow: var(--shadow);
  }
  .step-list { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 16px; }
  .step-card { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 12.5px; }
  .sec-hdr {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin: 22px 0 10px; flex-wrap: wrap;
  }
  .sec-hdr h3 { margin: 0; font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .ws-pcard { cursor: pointer; }
  .ws-src-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .form-field { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; }
  .form-field label { font-size: 12px; font-weight: 600; color: var(--text); }
  .form-field input[type="text"], .form-field input[type="number"], .form-field select {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px;
    font: inherit; background: var(--bg-elev); color: var(--text);
  }
  .ws-src-list {
    max-height: 190px; overflow: auto; border: 1px solid var(--border-soft);
    border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 4px;
    background: var(--bg);
  }
  .ws-src-opt {
    display: flex; align-items: center; gap: 8px; padding: 7px 9px;
    border-radius: 8px; background: var(--bg-elev); border: 1px solid var(--border-soft);
    cursor: pointer; font-size: 12.5px;
  }
  .ws-src-opt:hover { border-color: var(--accent); }
  .ws-spec-grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
    background: var(--bg-soft); padding: 10px; border-radius: 10px; margin-top: 8px;
  }
  .toast {
    position: fixed; bottom: 18px; right: 20px; background: var(--accent); color: #fff;
    padding: 9px 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
    opacity: 0; transition: opacity 0.18s; z-index: 70;
  }
  .toast.show { opacity: 1; }

  @media (max-width: 820px) {
    .grid.list-mode .pcard { flex-direction: column; }
    .grid.list-mode .cover { width: auto; border-right: 0; border-bottom: 1px solid var(--border-soft); }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="logo"></div>
    <span>Rea-FigmaDesign</span>
    <span class="sub-tag">專案空間（Project Hub）</span>
  </div>
  <input id="search-box" placeholder="搜尋專案／應用名稱、ID 或來源檔名..." style="width:260px">
  <span class="pill" id="bridge-pill">○ 離線模式</span>
  <span class="spacer"></span>
  <button class="btn primary" id="btn-new-ws" type="button">+ 合併多檔應用</button>
  <button class="btn accent" id="btn-new-proj" type="button">+ 匯入新專案</button>
</header>

<main class="wrap" id="app"></main>

<div class="modal-backdrop" id="ws-modal">
  <div class="modal" style="width:min(620px,95vw)">
    <h3 style="margin:0 0 6px" id="ws-modal-title">建立多檔應用組合</h3>
    <div style="font-size:12.5px;color:var(--text-muted)">勾選同一應用的多個 Figma 匯出檔（如 A1 + A2），共用同一組畫布篩選規則與分類標註；各檔案底層 SQLite 仍完全隔離。</div>
    <input type="hidden" id="ws-edit-id" value="">
    <div class="form-field">
      <label for="ws-name-input">應用名稱</label>
      <input type="text" id="ws-name-input" placeholder="例如：手機應用 A、網頁 PC 端">
    </div>
    <div class="form-field">
      <label>選擇包含的 Figma 來源檔（依 Figma 檔名識別）</label>
      <div class="ws-src-list" id="ws-src-list"></div>
    </div>
    <div class="form-field">
      <label for="ws-spec-preset">共用畫布識別規則</label>
      <select id="ws-spec-preset">
        <option value="mobile">手機端預設（寬 360/375/390/414/428/430 · 高 600–12000）</option>
        <option value="pc">網頁 PC 端（寬 1280/1366/1440/1536/1680/1920 · 高 600–16000）</option>
        <option value="custom">自訂寬度與高度範圍</option>
      </select>
      <div class="ws-spec-grid" id="ws-spec-custom" style="display:none">
        <div>
          <label style="font-size:11px;color:var(--text-muted)">畫布寬度（逗號分隔）</label>
          <input type="text" id="ws-widths" value="360,375,390,414,428,430" style="width:100%">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted)">容差 (±px) / 最小節點數</label>
          <div style="display:flex;gap:6px">
            <input type="number" id="ws-wtol" value="6" style="width:50%">
            <input type="number" id="ws-minnodes" value="40" style="width:50%">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted)">最小高度 (px)</label>
          <input type="number" id="ws-minh" value="600" style="width:100%">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted)">最大高度 (px)</label>
          <input type="number" id="ws-maxh" value="12000" style="width:100%">
        </div>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:16px">
      <button class="btn" id="ws-delete-btn" type="button" style="display:none;color:#cf222e;border-color:#f5c2c7">刪除此應用組合</button>
      <span class="spacer"></span>
      <button class="btn" id="close-ws-modal" type="button">取消</button>
      <button class="btn primary" id="ws-save-btn" type="button">儲存並生成工作台</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="import-modal">
  <div class="modal">
    <h3 style="margin:0 0 8px">如何匯入新的獨立 Figma 專案？</h3>
    <div style="font-size:12.5px;color:var(--text-muted)">不同專案的 SQLite 圖譜、畫布規格與分類標註完全隔離，不會互相覆蓋。</div>
    <div class="step-list">
      <div class="step-card"><strong>1. 在 Figma Desktop 開啟新專案並執行插件匯出</strong><br>系統會自動在 <code>data/&lt;file-key&gt;/graph.sqlite</code> 建立獨立圖譜，且「清空資料庫」僅清除該檔案本身。</div>
      <div class="step-card"><strong>2. 重新生成專案工作台</strong><br>執行 <code>npm run review:board</code>，即可在此頁面看到新專案卡片（0 標註時自動進入 AST 結構家族冷啟動）。</div>
      <div class="step-card"><strong>3. 若需自訂畫布寬度或長頁高度範圍</strong><br>透過 Agent 呼叫 <code>configure_project</code>（或編輯 <code>labels/projects/&lt;id&gt;/project.json</code>）即可套用專屬規格。</div>
    </div>
    <div style="display:flex;justify-content:flex-end"><button class="btn" id="close-import" type="button">關閉</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const HUB = ${payload};
${buildInlineSearchZhJs()}
let filterKind = 'all';
let sortBy = 'recent';
let viewLayout = 'grid';
let query = '';
let bridgeWs = null;
let bridgeOpen = false;
let bridgeStatus = { figma_connected: false, figma_file_name: '', figma_file_key: '', figma_clients: [] };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
  });
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 2600);
}

function matchFigmaClient(p) {
  const clients = Array.isArray(bridgeStatus.figma_clients) && bridgeStatus.figma_clients.length > 0
    ? bridgeStatus.figma_clients
    : (bridgeStatus.figma_connected ? [{ file_key: bridgeStatus.figma_file_key, file_name: bridgeStatus.figma_file_name }] : []);
  if (Array.isArray(p.sources) && p.sources.length > 0) {
    return p.sources.some(function(s) {
      return clients.some(function(c) {
        if (!c) return false;
        if (c.file_key && c.file_key !== '0:0' && s.fileKey && s.fileKey !== '0:0' && c.file_key === s.fileKey) return true;
        if (c.file_name && s.fileName && c.file_name === s.fileName) return true;
        return false;
      });
    });
  }
  return clients.some(function(c) {
    if (!c) return false;
    if (c.file_key && c.file_key !== '0:0' && p.fileKey && p.fileKey !== '0:0' && c.file_key === p.fileKey) return true;
    if (c.file_name && (c.file_name === p.name || c.file_name === p.fileName)) return true;
    return false;
  });
}

function findProjectForPayload(payload) {
  const wsHit = (HUB.workspaces || []).find(function(w) {
    return (w.sources || []).some(function(s) {
      if (payload.file_key && payload.file_key !== '0:0' && s.fileKey && s.fileKey !== '0:0' && payload.file_key === s.fileKey) return true;
      if (payload.file_name && s.fileName && payload.file_name === s.fileName) return true;
      return false;
    });
  });
  if (wsHit) return wsHit;
  return HUB.projects.find(function(p) {
    if (payload.file_key && payload.file_key !== '0:0' && p.fileKey && p.fileKey !== '0:0' && payload.file_key === p.fileKey) return true;
    if (payload.file_name && (payload.file_name === p.name || payload.file_name === p.fileName)) return true;
    return false;
  }) || null;
}

function updateBridgePill() {
  const el = document.getElementById('bridge-pill');
  if (!el) return;
  if (!bridgeOpen) { el.className = 'pill'; el.textContent = '○ 離線模式'; return; }
  if (bridgeStatus.figma_connected) {
    el.className = 'pill green';
    el.textContent = '● Figma 已連線' + (bridgeStatus.figma_file_name ? ' · ' + bridgeStatus.figma_file_name : '');
  } else {
    el.className = 'pill amber';
    el.textContent = '○ 等待 Figma 插件';
  }
}

function connectBridge() {
  try { bridgeWs = new WebSocket('ws://127.0.0.1:8765'); } catch (e) { bridgeOpen = false; updateBridgePill(); return; }
  bridgeWs.onopen = function() {
    bridgeOpen = true;
    updateBridgePill();
    try { bridgeWs.send(JSON.stringify({ type: 'BRIDGE_HELLO', payload: { role: 'review-ui' } })); } catch (e) {}
  };
  bridgeWs.onclose = function() {
    bridgeOpen = false;
    bridgeStatus.figma_connected = false;
    bridgeStatus.figma_clients = [];
    updateBridgePill();
    setTimeout(connectBridge, 3000);
  };
  bridgeWs.onmessage = function(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'BRIDGE_STATUS' && msg.payload) {
      bridgeStatus = msg.payload;
      updateBridgePill();
      render();
      return;
    }
    if (msg.type === 'BRIDGE_LOOKUP_SELECTION' && msg.payload) {
      const target = findProjectForPayload(msg.payload);
      try {
        bridgeWs.send(JSON.stringify({
          type: 'BRIDGE_LOOKUP_RESULT',
          payload: {
            request_id: msg.payload.request_id,
            ok: false,
            error: target ? ('請先點擊專案「' + target.name + '」進入專屬工作台後再查找') : '尚未進入任何專案工作台，請先選擇專案'
          }
        }));
      } catch (e) {}
      if (target) toast('收到來自「' + target.name + '」的查找請求，請點進該專案卡片');
    }
  };
}

function renderCover(p) {
  const pal = p.palette;
  const bg = 'linear-gradient(135deg, ' + pal[0] + '1f 0%, ' + pal[2] + '18 100%)';
  const live = matchFigmaClient(p);
  return '<div class="cover" style="background:' + bg + '">' +
    '<div class="cover-top">' +
    '<span class="pill ' + (p.labeledCount > 0 ? 'green' : 'amber') + '">' + (p.labeledCount > 0 ? '已建分類' : '冷啟動 AST') + '</span>' +
    (live ? '<span class="pill green">● Figma 連線中</span>' : '<span class="pill">' + esc(p.specLabel) + '</span>') +
    '</div>' +
    '<div class="mini-screens">' +
    '<div class="ms"><div class="ms-bar" style="background:' + pal[0] + '"></div><div class="ms-card" style="background:' + pal[0] + '1a"></div></div>' +
    '<div class="ms" style="height:62px"><div class="ms-bar" style="background:' + pal[2] + '"></div><div class="ms-card" style="background:' + pal[2] + '22"></div></div>' +
    '<div class="ms"><div class="ms-bar" style="background:' + pal[4] + '"></div><div class="ms-card" style="background:' + pal[4] + '1f"></div></div>' +
    '</div></div>';
}

function filterAndSortItems(items, isWs) {
  let list = (items || []).slice();
  if (query.trim()) {
    list = list.filter(function(p) {
      const srcStr = isWs ? (p.sources || []).map(function(s) { return s.fileName + ' ' + s.id; }).join(' ') : (p.fileName || '');
      return matchesSearch(p.name + ' ' + p.id + ' ' + srcStr + ' ' + p.specLabel + ' ' + p.labelsRelPath, query);
    });
  }
  if (filterKind === 'labeled') list = list.filter(function(p) { return p.labeledCount > 0; });
  else if (filterKind === 'cold') list = list.filter(function(p) { return p.labeledCount === 0; });

  if (sortBy === 'nodes') list.sort(function(a, b) { return b.nodesCount - a.nodesCount; });
  else if (sortBy === 'labels') list.sort(function(a, b) { return b.labeledCount - a.labeledCount; });
  else list.sort(function(a, b) { return b.updatedMs - a.updatedMs; });
  return list;
}

function render() {
  const wsAll = HUB.workspaces || [];
  const wsList = filterAndSortItems(wsAll, true);
  const list = filterAndSortItems(HUB.projects, false);

  let html = '<div class="banner">' +
    '<div><strong>多檔應用組合 × 獨立來源隔離</strong>' +
    '<div class="muted">先按 Figma 檔名識別各匯出檔，再自由勾選合併為同一個應用工作台共用篩選規則與分類標註；底層 SQLite 仍各自隔離。</div></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<span class="pill accent">' + wsAll.length + ' 個應用組合</span>' +
    '<span class="pill">' + HUB.projects.length + ' 個 Figma 來源檔</span>' +
    '</div></div>';

  html += '<div class="toolbar">' +
    '<div class="chips">' +
    '<button class="chip' + (filterKind === 'all' ? ' active' : '') + '" data-filter="all">全部 (' + (wsAll.length + HUB.projects.length) + ')</button>' +
    '<button class="chip' + (filterKind === 'labeled' ? ' active' : '') + '" data-filter="labeled">已建立分類</button>' +
    '<button class="chip' + (filterKind === 'cold' ? ' active' : '') + '" data-filter="cold">冷啟動 AST</button>' +
    '</div>' +
    '<div class="tools-right">' +
    '<select id="sort-sel"><option value="recent"' + (sortBy === 'recent' ? ' selected' : '') + '>最近同步</option><option value="nodes"' + (sortBy === 'nodes' ? ' selected' : '') + '>節點數優先</option><option value="labels"' + (sortBy === 'labels' ? ' selected' : '') + '>標註數優先</option></select>' +
    '<div class="seg">' +
    '<button type="button" data-layout="grid" class="' + (viewLayout === 'grid' ? 'active' : '') + '">卡片</button>' +
    '<button type="button" data-layout="list" class="' + (viewLayout === 'list' ? 'active' : '') + '">清單</button>' +
    '</div></div></div>';

  html += '<div class="sec-hdr"><h3>應用組合（多檔合併共用規則） <span class="pill">' + wsList.length + '</span></h3>' +
    '<button class="btn sm" id="sec-new-ws" type="button">+ 新增應用組合</button></div>';

  if (wsAll.length === 0) {
    html += '<div class="banner" style="background:var(--bg-soft);margin-bottom:16px">' +
      '<div class="muted">尚未建立多檔應用組合。若同一個產品拆分在多個 Figma 檔案（如 A1、A2 或 PC 端多檔），點右上角「+ 合併多檔應用」勾選即可共用規則與標註。</div>' +
      '<button class="btn sm primary" id="empty-new-ws" type="button">立即組合</button></div>';
  } else {
    html += '<div class="grid' + (viewLayout === 'list' ? ' list-mode' : '') + '" style="margin-bottom:18px">';
    wsList.forEach(function(w) {
      const majorsSummary = Object.keys(w.majorCounts || {}).slice(0, 4).map(function(k) {
        return k + ' ' + w.majorCounts[k];
      }).join(' · ');
      const srcChips = (w.sources || []).map(function(s) {
        return '<span class="pill accent">📄 ' + esc(s.fileName || s.id) + '</span>';
      }).join('');
      html += '<div class="pcard ws-pcard" data-ws-href="' + esc(w.reviewHref) + '">' +
        renderCover(w) +
        '<div class="pbody">' +
        '<div class="ptitle-row"><div class="ptitle">' + esc(w.name) + '</div><span class="pill">' + (w.sources || []).length + ' 檔合併</span></div>' +
        '<div class="ws-src-chips">' + srcChips + '</div>' +
        '<div class="stats-line">' +
        '<span><b>' + w.pagesDone + '/' + w.pagesTotal + '</b> 頁面</span>' +
        '<span><b>' + w.nodesCount.toLocaleString() + '</b> 節點</span>' +
        '<span><b>' + w.labeledCount.toLocaleString() + '</b> 已標註畫面</span>' +
        '</div>' +
        '<div style="font-size:11.5px;color:var(--text-muted)">' + esc(majorsSummary || '尚未填寫分類，進入後將依 AST 結構家族整理') + '</div>' +
        '<div class="iso-meta">' +
        '<span>標註：<code>' + esc(w.labelsRelPath) + '</code></span>' +
        '<span style="display:flex;gap:6px;align-items:center"><button class="btn sm ws-edit-btn" type="button" data-edit-ws="' + esc(w.id) + '">編輯組合</button><strong>進入工作台 →</strong></span>' +
        '</div></div></div>';
    });
    html += '</div>';
  }

  html += '<div class="sec-hdr"><h3>獨立 Figma 來源檔 <span class="pill">' + list.length + '</span></h3>' +
    '<span style="font-size:12px;color:var(--text-muted)">每個卡片對應一份真實 Figma 檔案（依 Figma 檔名區分）</span></div>';

  html += '<div class="grid' + (viewLayout === 'list' ? ' list-mode' : '') + '">';
  list.forEach(function(p) {
    const majorsSummary = Object.keys(p.majorCounts || {}).slice(0, 4).map(function(k) {
      return k + ' ' + p.majorCounts[k];
    }).join(' · ');

    html += '<a class="pcard" href="' + esc(p.reviewHref) + '">' +
      renderCover(p) +
      '<div class="pbody">' +
      '<div class="ptitle-row"><div class="ptitle">' + esc(p.fileName || p.name) + '</div><span class="pill">' + esc(p.id) + '</span></div>' +
      '<div class="stats-line">' +
      '<span><b>' + p.pagesDone + '/' + p.pagesTotal + '</b> 頁面</span>' +
      '<span><b>' + p.nodesCount.toLocaleString() + '</b> 節點</span>' +
      '<span><b>' + p.labeledCount.toLocaleString() + '</b> 已標註畫面</span>' +
      '</div>' +
      '<div style="font-size:11.5px;color:var(--text-muted)">' + esc(majorsSummary || '尚未填寫分類，進入後將依 AST 結構家族整理') + '</div>' +
      '<div class="iso-meta">' +
      '<span>標註：<code>' + esc(p.labelsRelPath) + '</code></span>' +
      '<span>' + esc(p.updatedAt) + ' · <strong>進入工作台 →</strong></span>' +
      '</div></div></a>';
  });

  html += '<div class="add-card" id="card-add-proj">' +
    '<div class="add-plus">+</div>' +
    '<strong>匯入新的獨立 Figma 專案</strong>' +
    '<span style="font-size:12px">自動隔離 SQLite 圖譜、畫布規格與標註檔案</span>' +
    '</div></div>';

  document.getElementById('app').innerHTML = html;
}

function fillSpecInputs(spec) {
  const s = spec || HUB.mobileSpec;
  document.getElementById('ws-widths').value = (s.widths || []).join(',');
  document.getElementById('ws-wtol').value = String(s.widthTolerance || 6);
  document.getElementById('ws-minnodes').value = String(s.minNodes || 40);
  document.getElementById('ws-minh').value = String(s.minHeight || 600);
  document.getElementById('ws-maxh').value = String(s.maxHeight || 12000);
}

function detectSpecPreset(spec) {
  if (!spec || !Array.isArray(spec.widths)) return 'mobile';
  const wStr = spec.widths.join(',');
  if (wStr === (HUB.mobileSpec.widths || []).join(',') && spec.maxHeight === HUB.mobileSpec.maxHeight) return 'mobile';
  if (wStr === (HUB.pcWebSpec.widths || []).join(',') && spec.maxHeight === HUB.pcWebSpec.maxHeight) return 'pc';
  return 'custom';
}

function openWorkspaceModal(editWsId) {
  const ws = editWsId ? (HUB.workspaces || []).find(function(w) { return w.id === editWsId; }) : null;
  document.getElementById('ws-modal-title').textContent = ws ? ('編輯應用組合 · ' + ws.name) : '建立多檔應用組合';
  document.getElementById('ws-edit-id').value = ws ? ws.id : '';
  document.getElementById('ws-name-input').value = ws ? ws.name : '';
  document.getElementById('ws-delete-btn').style.display = ws ? 'inline-flex' : 'none';

  const checkedSet = new Set(ws ? (ws.sourceIds || []) : []);
  const srcListEl = document.getElementById('ws-src-list');
  if (!HUB.projects || HUB.projects.length === 0) {
    srcListEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px">尚未匯入任何 Figma 來源檔</div>';
  } else {
    srcListEl.innerHTML = HUB.projects.map(function(p) {
      const checked = checkedSet.has(p.id) ? ' checked' : '';
      return '<label class="ws-src-opt">' +
        '<input type="checkbox" class="ws-src-chk" value="' + esc(p.id) + '"' + checked + '>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(p.fileName || p.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">' + esc(p.id) + ' · ' + p.pagesTotal + ' 頁 · ' + p.nodesCount.toLocaleString() + ' 節點</div>' +
        '</div>' +
        '</label>';
    }).join('');
  }

  const preset = ws ? detectSpecPreset(ws.screenSpec) : 'mobile';
  document.getElementById('ws-spec-preset').value = preset;
  fillSpecInputs(ws ? ws.screenSpec : HUB.mobileSpec);
  document.getElementById('ws-spec-custom').style.display = preset === 'custom' ? 'grid' : 'none';
  document.getElementById('ws-modal').classList.add('show');
}

document.getElementById('search-box').addEventListener('input', function() { query = this.value; render(); });
document.getElementById('app').addEventListener('click', function(ev) {
  const editBtn = ev.target.closest('[data-edit-ws]');
  if (editBtn) {
    ev.stopPropagation();
    openWorkspaceModal(editBtn.getAttribute('data-edit-ws'));
    return;
  }
  if (ev.target.closest('#sec-new-ws') || ev.target.closest('#empty-new-ws')) {
    openWorkspaceModal('');
    return;
  }
  const wsCard = ev.target.closest('[data-ws-href]');
  if (wsCard) {
    window.location.href = wsCard.getAttribute('data-ws-href');
    return;
  }
  const f = ev.target.closest('[data-filter]');
  if (f) { filterKind = f.getAttribute('data-filter'); render(); return; }
  const l = ev.target.closest('[data-layout]');
  if (l) { viewLayout = l.getAttribute('data-layout'); render(); return; }
  if (ev.target.closest('#card-add-proj')) { document.getElementById('import-modal').classList.add('show'); }
});
document.getElementById('app').addEventListener('change', function(ev) {
  if (ev.target && ev.target.id === 'sort-sel') { sortBy = ev.target.value; render(); }
});
document.getElementById('btn-new-ws').addEventListener('click', function() { openWorkspaceModal(''); });
document.getElementById('close-ws-modal').addEventListener('click', function() { document.getElementById('ws-modal').classList.remove('show'); });
document.getElementById('ws-modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'ws-modal') this.classList.remove('show');
});
document.getElementById('ws-spec-preset').addEventListener('change', function() {
  if (this.value === 'pc') fillSpecInputs(HUB.pcWebSpec);
  else if (this.value === 'mobile') fillSpecInputs(HUB.mobileSpec);
  document.getElementById('ws-spec-custom').style.display = this.value === 'custom' ? 'grid' : 'none';
});
document.getElementById('ws-save-btn').addEventListener('click', function() {
  const btn = this;
  const id = (document.getElementById('ws-edit-id').value || '').trim();
  const name = (document.getElementById('ws-name-input').value || '').trim();
  const sourceIds = Array.from(document.querySelectorAll('.ws-src-chk:checked')).map(function(el) { return el.value; });
  if (!name) { toast('請輸入應用名稱'); return; }
  if (sourceIds.length === 0) { toast('請至少勾選 1 個 Figma 來源檔'); return; }
  const preset = document.getElementById('ws-spec-preset').value;
  let screenSpec;
  if (preset === 'pc') {
    screenSpec = HUB.pcWebSpec;
  } else if (preset === 'mobile') {
    screenSpec = HUB.mobileSpec;
  } else {
    const widths = (document.getElementById('ws-widths').value || '')
      .split(',')
      .map(function(x) { return Number(x.trim()); })
      .filter(function(n) { return Number.isFinite(n) && n > 0; });
    screenSpec = {
      widths: widths.length > 0 ? widths : HUB.mobileSpec.widths,
      widthTolerance: Math.max(0, Number(document.getElementById('ws-wtol').value) || 6),
      minHeight: Math.max(100, Number(document.getElementById('ws-minh').value) || 600),
      maxHeight: Math.max(500, Number(document.getElementById('ws-maxh').value) || 12000),
      minNodes: Math.max(1, Number(document.getElementById('ws-minnodes').value) || 40)
    };
  }
  btn.disabled = true;
  btn.textContent = '儲存中...';
  fetch('http://127.0.0.1:8765/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', id: id || undefined, name: name, sourceIds: sourceIds, screenSpec: screenSpec })
  }).then(function(r) { return r.json(); }).then(function(res) {
    if (!res || !res.ok) {
      toast('儲存失敗：' + ((res && res.error) || '請確認已啟動 npm run start:server'));
      btn.disabled = false;
      btn.textContent = '儲存並生成工作台';
      return;
    }
    toast('已儲存應用組合「' + name + '」');
    document.getElementById('ws-modal').classList.remove('show');
    window.location.reload();
  }).catch(function() {
    toast('無法連線 http://127.0.0.1:8765，請先啟動 npm run start:server');
    btn.disabled = false;
    btn.textContent = '儲存並生成工作台';
  });
});
document.getElementById('ws-delete-btn').addEventListener('click', function() {
  const id = (document.getElementById('ws-edit-id').value || '').trim();
  if (!id || !confirm('確定刪除這個多檔應用組合？底層來源檔 SQLite 資料不會受影響。')) return;
  fetch('http://127.0.0.1:8765/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: id })
  }).then(function(r) { return r.json(); }).then(function(res) {
    if (!res || !res.ok) { toast('刪除失敗：' + ((res && res.error) || '未知錯誤')); return; }
    document.getElementById('ws-modal').classList.remove('show');
    window.location.reload();
  }).catch(function() {
    toast('無法連線 http://127.0.0.1:8765，請先啟動 npm run start:server');
  });
});
document.getElementById('btn-new-proj').addEventListener('click', function() {
  document.getElementById('import-modal').classList.add('show');
});
document.getElementById('close-import').addEventListener('click', function() {
  document.getElementById('import-modal').classList.remove('show');
});
document.getElementById('import-modal').addEventListener('click', function(ev) {
  if (ev.target && ev.target.id === 'import-modal') this.classList.remove('show');
});

render();
connectBridge();
</script>
</body>
</html>`;

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(absOut, html, 'utf8');
  return { html: absOut, projects: projects.length, workspaces: workspaces.length };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const res = generateProjectHub(ROOT);
  console.log('project-hub written · workspaces=' + res.workspaces + ' projects=' + res.projects + ' path=' + res.html);
}
