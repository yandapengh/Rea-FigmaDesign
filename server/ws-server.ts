/// <reference lib="es2022" />
/**
 * Local ingestion + Live Bridge server (stage 2 + Live Bridge):
 *  - one folder per Figma file: data/<safeKey>/graph.sqlite + manifest.json + batches/
 *  - SYNC_START only upserts metadata; PAGE_START stages; PAGE_COMPLETE swaps atomically
 *  - empty pages arrive as PAGE_SKIP and are recorded as SKIPPED
 *  - RESET_DATABASE(confirm:true) is the only destructive path
 *  - Live Bridge relays BRIDGE_FOCUS_NODES / BRIDGE_FOCUS_RESULT between review-ui and figma-plugin
 *  - HTTP GET / or /review serves .scratch/review.html when present
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import Database = require('better-sqlite3');
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { AstGraphDB } from './db';
import { loadProposals, resolveProject, saveProposals } from './core/projects';
import { recomputeV2Counts, tryLoadScreenLabelsV2, type ScreenLabelV2 } from './core/semantics';
import { generateReviewBoard } from './review-board';
import { generateProjectHub } from './review-hub';
import type {
  BridgeClientRole, BridgeFocusRequestPayload, BridgeFocusResultPayload, BridgeLookupRequestPayload,
  BridgeLookupResultPayload, BridgeSelectionItem, BridgeStageRequestPayload, BridgeStageResultPayload,
  BridgeStatusPayload, ComponentRow, FileMetaPayload, NodeRow, PageCensusRow, PageCompletePayload,
  PageSkipPayload, PageStartPayload, VariableRow, WsMessage,
} from '../shared/protocol';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const WS_OPEN = 1;
const HEARTBEAT_MS = 30000;
const FOCUS_TIMEOUT_MS = 15000;
const STAGE_TIMEOUT_MS = 30000;

export interface IngestServerOptions { host?: string; port?: number; dbPath?: string; quiet?: boolean }

export interface RunningIngestServer {
  wss: WebSocketServer;
  db: AstGraphDB | null;
  host: string;
  port: number;
  close(): Promise<void>;
}

interface AckOk { status: 'OK'; receivedType: WsMessage['type']; count: number; committed?: number; pages?: unknown[]; batchId?: number; pageId?: string; latestBatch?: unknown }
interface AckError { status: 'ERROR'; receivedType: string | null; error: string; batchId?: number }
interface BatchRecord { batch_id: number; file_key: string; started_at: string; finished_at: string | null; requested: Array<{ page_id: string; page_name: string; page_index: number }>; pages: Record<string, string> }
interface SocketState {
  projectId: string | null;
  fileKey: string | null;
  fileName: string | null;
  role: BridgeClientRole | null;
  page: { fileKey: string; pageId: string; pageName: string; pageIndex: number } | null;
  db: AstGraphDB | null;
  folder: string | null;
  batch: BatchRecord | null;
  batchId: number | null;
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function asString(value: unknown): string { return typeof value === 'string' ? value : ''; }
function finiteNumber(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function nowIso(): string { return new Date().toISOString(); }

function safeFolder(fileKey: string, fileName: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(fileKey)) return fileKey;
  return 'file-' + createHash('sha1').update(fileKey + '|' + fileName).digest('hex').slice(0, 10);
}

function atomicJson(path: string, value: unknown): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WS_OPEN) return;
  try { socket.send(JSON.stringify(value)); } catch (error) { console.error('[ws] ack send failed: ' + describeError(error)); }
}
function sendError(socket: WebSocket, receivedType: string | null, error: string, batchId?: number): void {
  const ack: AckError = { status: 'ERROR', receivedType, error };
  if (typeof batchId === 'number') ack.batchId = batchId;
  sendJson(socket, ack);
}

export async function startIngestServer(options: IngestServerOptions = {}): Promise<RunningIngestServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const root = resolve(__dirname, '..');
  const dataRoot = join(root, 'data');
  const reviewHtmlPath = join(root, '.scratch', 'review.html');
  const configured = options.dbPath ?? process.env.REA_DB_PATH;
  const fixedDb = configured ? new AstGraphDB(resolve(root, configured)) : null;
  const quiet = options.quiet ?? false;
  const openDbs = new Map<string, AstGraphDB>();
  const states = new Map<WebSocket, SocketState>();
  const alive = new Map<WebSocket, boolean>();
  const pendingFocus = new Map<string, { requester: WebSocket; timer: ReturnType<typeof setTimeout> }>();
  const pendingLookup = new Map<string, { requester: WebSocket; timer: ReturnType<typeof setTimeout> }>();
  const pendingStage = new Map<string, { requester: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  function activeFigmaPlugin(): WebSocket | null {
    let found: WebSocket | null = null;
    for (const [sock, st] of states) {
      if (st.role === 'figma-plugin' && sock.readyState === WS_OPEN) found = sock;
    }
    return found;
  }

  function allFigmaPlugins(): Array<{ sock: WebSocket; st: SocketState }> {
    const out: Array<{ sock: WebSocket; st: SocketState }> = [];
    for (const [sock, st] of states) {
      if (st.role === 'figma-plugin' && sock.readyState === WS_OPEN) out.push({ sock, st });
    }
    return out;
  }

  function matchesTarget(st: { fileKey: string | null; fileName: string | null }, fileKey?: string, fileName?: string): boolean {
    const wantKey = (fileKey || '').trim();
    const wantName = (fileName || '').trim();
    const haveKey = (st.fileKey || '').trim();
    const haveName = (st.fileName || '').trim();
    if (wantKey && wantKey !== '0:0' && haveKey && haveKey !== '0:0' && wantKey === haveKey) return true;
    if (wantName && haveName && wantName === haveName) return true;
    return false;
  }

  function findMatchingFigmaPlugin(fileKey?: string, fileName?: string): { sock: WebSocket | null; mismatchNames: string[] } {
    const plugins = allFigmaPlugins();
    if (plugins.length === 0) return { sock: null, mismatchNames: [] };
    const hasTarget = Boolean((fileKey && fileKey !== '0:0') || fileName);
    if (!hasTarget) return { sock: plugins[plugins.length - 1].sock, mismatchNames: [] };
    let matched: WebSocket | null = null;
    for (const p of plugins) {
      if (matchesTarget(p.st, fileKey, fileName)) matched = p.sock;
    }
    if (matched) return { sock: matched, mismatchNames: [] };
    return {
      sock: null,
      mismatchNames: plugins.map((p) => p.st.fileName || p.st.fileKey || '(未命名 Figma 檔)'),
    };
  }

  function activeReviewClients(): WebSocket[] {
    const clients: WebSocket[] = [];
    for (const [sock, st] of states) {
      if (st.role === 'review-ui' && sock.readyState === WS_OPEN) clients.push(sock);
    }
    return clients;
  }

  function findMatchingReviewClients(fileKey?: string, fileName?: string): { clients: WebSocket[]; hasOtherProjectOnly: boolean } {
    const all = activeReviewClients();
    if (all.length === 0) return { clients: [], hasOtherProjectOnly: false };
    const hasTarget = Boolean((fileKey && fileKey !== '0:0') || fileName);
    if (!hasTarget) return { clients: all, hasOtherProjectOnly: false };
    const matched = all.filter((sock) => {
      const st = states.get(sock);
      return st ? matchesTarget(st, fileKey, fileName) : false;
    });
    if (matched.length > 0) return { clients: matched, hasOtherProjectOnly: false };
    const untargeted = all.filter((sock) => {
      const st = states.get(sock);
      return st && !st.fileName && (!st.fileKey || st.fileKey === '0:0') && !st.projectId;
    });
    if (untargeted.length > 0) return { clients: untargeted, hasOtherProjectOnly: false };
    return { clients: [], hasOtherProjectOnly: true };
  }

  function currentBridgeStatus(): BridgeStatusPayload {
    const plugins = allFigmaPlugins();
    const pluginSock = plugins.length > 0 ? plugins[plugins.length - 1].sock : null;
    const pluginState = pluginSock ? states.get(pluginSock) : undefined;
    const reviewClients = activeReviewClients().length;
    return {
      figma_connected: pluginSock !== null,
      figma_file_name: pluginState?.fileName ?? undefined,
      figma_file_key: pluginState?.fileKey ?? undefined,
      figma_clients: plugins.map((p) => ({
        file_key: p.st.fileKey ?? undefined,
        file_name: p.st.fileName ?? undefined,
      })),
      review_clients: reviewClients,
    };
  }

  function broadcastBridgeStatus(): void {
    const status = currentBridgeStatus();
    const msg = { type: 'BRIDGE_STATUS', payload: status };
    for (const [sock, st] of states) {
      if ((st.role === 'review-ui' || st.role === 'figma-plugin') && sock.readyState === WS_OPEN) sendJson(sock, msg);
    }
  }

  function dbFor(fileKey: string, fileName: string, state: SocketState): AstGraphDB {
    if (fixedDb) { state.folder = null; return fixedDb; }
    let folder = join(dataRoot, safeFolder(fileKey, fileName));
    {
      try {
        for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const manifestPath = join(dataRoot, entry.name, 'manifest.json');
          if (!existsSync(manifestPath)) continue;
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { file_key?: string; file_name?: string };
          const sameKey = manifest.file_key === fileKey;
          const sameLocalDraft = fileKey === '0:0' && Boolean(fileName) && manifest.file_name === fileName;
          if ((fileKey !== '0:0' && sameKey) || sameLocalDraft || (fileKey === '0:0' && !fileName && sameKey)) {
            folder = join(dataRoot, entry.name);
            break;
          }
        }
      } catch { /* fall back to the hashed folder */ }
    }
    state.folder = folder;
    const existing = openDbs.get(folder);
    if (existing) return existing;
    mkdirSync(join(folder, 'batches'), { recursive: true });
    const db = new AstGraphDB(join(folder, 'graph.sqlite'));
    openDbs.set(folder, db);
    return db;
  }

  function updateManifest(state: SocketState, page: { page_id: string; page_name: string; page_index: number }, status: string, nodeCount?: number): void {
    if (!state.folder) return;
    const path = join(state.folder, 'manifest.json');
    let manifest: Record<string, unknown> = { file_key: state.fileKey, updated_at: nowIso(), pages: [] };
    try { manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { /* first write */ }
    const pages = Array.isArray(manifest.pages) ? (manifest.pages as Array<Record<string, unknown>>) : [];
    const next = pages.filter((p) => p.page_id !== page.page_id);
    next.push({ page_id: page.page_id, page_name: page.page_name, page_index: page.page_index, status, node_count: nodeCount ?? 0, updated_at: nowIso() });
    next.sort((a, b) => Number(a.page_index) - Number(b.page_index));
    manifest.pages = next;
    manifest.updated_at = nowIso();
    atomicJson(path, manifest);
  }

  function saveBatch(state: SocketState): void {
    if (!state.folder || !state.batch) return;
    atomicJson(join(state.folder, 'batches', String(state.batch.batch_id).padStart(3, '0') + '_batch.json'), state.batch);
  }

  function handleRawMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { sendError(socket, null, 'INVALID_JSON'); return; }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') { sendError(socket, null, 'INVALID_ENVELOPE'); return; }

    const receivedType = parsed.type;
    const payload = parsed.payload;
    const batchId = typeof parsed.batch_id === 'number' ? parsed.batch_id : undefined;
    let state = states.get(socket);
    if (!state) { state = { projectId: null, fileKey: null, fileName: null, role: null, page: null, db: null, folder: null, batch: null, batchId: null }; states.set(socket, state); }

    // Live Bridge control plane (does not write DB or emit ingestion AckOk)
    if (receivedType === 'BRIDGE_HELLO') {
      if (!isRecord(payload) || (payload.role !== 'figma-plugin' && payload.role !== 'review-ui')) {
        sendError(socket, receivedType, 'INVALID_BRIDGE_ROLE', batchId);
        return;
      }
      state.role = payload.role;
      if (typeof payload.project_id === 'string' && payload.project_id) state.projectId = payload.project_id;
      if (typeof payload.file_key === 'string' && payload.file_key) state.fileKey = payload.file_key;
      if (typeof payload.file_name === 'string' && payload.file_name) state.fileName = payload.file_name;
      sendJson(socket, { type: 'BRIDGE_STATUS', payload: currentBridgeStatus() });
      broadcastBridgeStatus();
      if (!quiet) console.log('[bridge] hello role=' + state.role + (state.fileName ? ' file="' + state.fileName + '"' : ''));
      return;
    }

    if (receivedType === 'BRIDGE_FOCUS_NODES') {
      if (!isRecord(payload) || typeof payload.request_id !== 'string' || !payload.request_id) {
        sendError(socket, receivedType, 'BRIDGE_FOCUS_NODES requires request_id', batchId);
        return;
      }
      const reqId = payload.request_id;
      const pageOnly = payload.page_only === true;
      const pageIdIn = typeof payload.page_id === 'string' ? payload.page_id.trim() : '';
      const pageNameIn = typeof payload.page_name === 'string' ? payload.page_name.trim() : '';
      const targetFileKey = typeof payload.file_key === 'string' && payload.file_key.trim() ? payload.file_key.trim() : (state.fileKey || undefined);
      const targetFileName = typeof payload.file_name === 'string' && payload.file_name.trim() ? payload.file_name.trim() : (state.fileName || undefined);
      const rawIds = Array.isArray(payload.node_ids) ? payload.node_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
      const nodeIds = [...new Set(rawIds.map((x) => x.trim()))].slice(0, 1500);
      if (nodeIds.length === 0 && !(pageOnly && (pageIdIn || pageNameIn))) {
        sendJson(socket, { type: 'BRIDGE_FOCUS_RESULT', payload: { request_id: reqId, ok: false, error: '沒有可定位的 node_id' } });
        return;
      }
      const { sock: pluginSock, mismatchNames } = findMatchingFigmaPlugin(targetFileKey, targetFileName);
      if (!pluginSock) {
        const errText = mismatchNames.length > 0
          ? ('目前 Figma 開啟的是「' + mismatchNames.join(' / ') + '」，與目前工作台專案「' + (targetFileName || targetFileKey || '') + '」不符，請切換 Figma 檔案後再定位')
          : 'Figma 插件未連線：請先在 Figma Desktop 開啟「Rea-FigmaDesign AST 探針」插件';
        sendJson(socket, {
          type: 'BRIDGE_FOCUS_RESULT',
          payload: {
            request_id: reqId,
            ok: false,
            error: errText,
          },
        });
        return;
      }
      const prev = pendingFocus.get(reqId);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        pendingFocus.delete(reqId);
        sendJson(socket, {
          type: 'BRIDGE_FOCUS_RESULT',
          payload: { request_id: reqId, ok: false, error: 'Figma 插件定位超時（15 秒），請確認插件視窗仍處於開啟狀態' },
        });
      }, FOCUS_TIMEOUT_MS);
      pendingFocus.set(reqId, { requester: socket, timer });

      const forward: BridgeFocusRequestPayload = {
        request_id: reqId,
        node_ids: nodeIds,
        page_id: pageIdIn || undefined,
        page_name: pageNameIn || undefined,
        page_only: pageOnly ? true : undefined,
      };
      sendJson(pluginSock, { type: 'BRIDGE_FOCUS_NODES', payload: forward });
      if (!quiet) console.log('[bridge] focus -> figma (' + nodeIds.length + ' ids, req=' + reqId + ')');
      return;
    }

    if (receivedType === 'BRIDGE_FOCUS_RESULT') {
      if (!isRecord(payload) || typeof payload.request_id !== 'string') return;
      const pending = pendingFocus.get(payload.request_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingFocus.delete(payload.request_id);
      const resPayload = payload as unknown as BridgeFocusResultPayload;
      sendJson(pending.requester, { type: 'BRIDGE_FOCUS_RESULT', payload: resPayload });
      if (!quiet) console.log('[bridge] result -> review (' + (resPayload.ok ? 'OK ' + (resPayload.selected_count ?? 0) : 'ERR ' + (resPayload.error ?? '')) + ')');
      return;
    }

    if (receivedType === 'BRIDGE_LOOKUP_SELECTION') {
      if (!isRecord(payload) || typeof payload.request_id !== 'string' || !payload.request_id) {
        sendError(socket, receivedType, 'BRIDGE_LOOKUP_SELECTION requires request_id', batchId);
        return;
      }
      const reqId = payload.request_id;
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const seenIds = new Set<string>();
      const items: BridgeSelectionItem[] = [];
      for (const rawItem of rawItems) {
        if (!isRecord(rawItem) || typeof rawItem.id !== 'string') continue;
        const id = rawItem.id.trim();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const item: BridgeSelectionItem = {
          id,
          name: asString(rawItem.name),
          type: asString(rawItem.type),
          page_id: asString(rawItem.page_id),
          page_name: asString(rawItem.page_name),
        };
        if (typeof rawItem.width === 'number' && Number.isFinite(rawItem.width)) item.width = rawItem.width;
        if (typeof rawItem.height === 'number' && Number.isFinite(rawItem.height)) item.height = rawItem.height;
        if (typeof rawItem.text_preview === 'string' && rawItem.text_preview) item.text_preview = rawItem.text_preview.slice(0, 200);
        if (Array.isArray(rawItem.ancestor_ids)) {
          const ancestors = rawItem.ancestor_ids
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .map((x) => x.trim())
            .slice(0, 30);
          if (ancestors.length > 0) item.ancestor_ids = ancestors;
        }
        items.push(item);
        if (items.length >= 1000) break;
      }
      if (items.length === 0) {
        sendJson(socket, { type: 'BRIDGE_LOOKUP_RESULT', payload: { request_id: reqId, ok: false, error: '請先在 Figma 中選中至少 1 個設計稿節點' } });
        return;
      }
      const lookupFileKey = asString(payload.file_key) || state.fileKey || undefined;
      const lookupFileName = asString(payload.file_name) || state.fileName || undefined;
      const { clients: reviewClients, hasOtherProjectOnly } = findMatchingReviewClients(lookupFileKey, lookupFileName);
      if (reviewClients.length === 0) {
        sendJson(socket, {
          type: 'BRIDGE_LOOKUP_RESULT',
          payload: {
            request_id: reqId,
            ok: false,
            error: hasOtherProjectOnly
              ? ('目前開啟的複審工作台屬於其他專案，請先在專案空間切換至「' + (lookupFileName || lookupFileKey || '對應專案') + '」')
              : '複審工作台未連線：請先開啟 review.html（http://127.0.0.1:8765/review）',
          },
        });
        return;
      }
      const prev = pendingLookup.get(reqId);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        pendingLookup.delete(reqId);
        sendJson(socket, {
          type: 'BRIDGE_LOOKUP_RESULT',
          payload: { request_id: reqId, ok: false, error: '複審工作台回應超時（15 秒），請確認瀏覽器分頁處於開啟狀態' },
        });
      }, FOCUS_TIMEOUT_MS);
      pendingLookup.set(reqId, { requester: socket, timer });

      const expandedFromSections = Array.isArray(payload.expanded_from_sections)
        ? payload.expanded_from_sections.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 20)
        : [];
      const forward: BridgeLookupRequestPayload = {
        request_id: reqId,
        file_key: asString(payload.file_key) || undefined,
        file_name: asString(payload.file_name) || undefined,
        page_id: asString(payload.page_id),
        page_name: asString(payload.page_name),
        items,
        expanded_from_sections: expandedFromSections.length > 0 ? expandedFromSections : undefined,
      };
      for (const client of reviewClients) sendJson(client, { type: 'BRIDGE_LOOKUP_SELECTION', payload: forward });
      if (!quiet) console.log('[bridge] lookup -> review (' + items.length + ' items, req=' + reqId + ')');
      return;
    }

    if (receivedType === 'BRIDGE_LOOKUP_RESULT') {
      if (!isRecord(payload) || typeof payload.request_id !== 'string') return;
      const pending = pendingLookup.get(payload.request_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingLookup.delete(payload.request_id);
      const resPayload = payload as unknown as BridgeLookupResultPayload;
      sendJson(pending.requester, { type: 'BRIDGE_LOOKUP_RESULT', payload: resPayload });
      if (!quiet) console.log('[bridge] lookup result -> plugin (' + (resPayload.ok ? 'OK matched=' + (resPayload.matched_count ?? 0) + ' new=' + (resPayload.unrecorded_count ?? 0) : 'ERR ' + (resPayload.error ?? '')) + ')');
      return;
    }

    if (receivedType === 'BRIDGE_STAGE_BOARD') {
      if (!isRecord(payload) || typeof payload.request_id !== 'string' || !payload.request_id) {
        sendError(socket, receivedType, 'BRIDGE_STAGE_BOARD requires request_id', batchId);
        return;
      }
      const reqId = payload.request_id;
      const rawIds = Array.isArray(payload.node_ids) ? payload.node_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
      const nodeIds = [...new Set(rawIds.map((x) => x.trim()))].slice(0, 120);
      if (nodeIds.length === 0) {
        sendJson(socket, { type: 'BRIDGE_STAGE_RESULT', payload: { request_id: reqId, ok: false, error: '沒有可加入臨時拼板的畫面節點' } });
        return;
      }
      const targetFileKey = typeof payload.file_key === 'string' && payload.file_key.trim() ? payload.file_key.trim() : (state.fileKey || undefined);
      const targetFileName = typeof payload.file_name === 'string' && payload.file_name.trim() ? payload.file_name.trim() : (state.fileName || undefined);
      const { sock: pluginSock, mismatchNames } = findMatchingFigmaPlugin(targetFileKey, targetFileName);
      if (!pluginSock) {
        const errText = mismatchNames.length > 0
          ? ('目前 Figma 開啟的是「' + mismatchNames.join(' / ') + '」，與目前工作台專案「' + (targetFileName || targetFileKey || '') + '」不符，請切換 Figma 檔案後再生成拼板')
          : 'Figma 插件未連線：請先在 Figma Desktop 開啟「Rea-FigmaDesign AST 探針」插件';
        sendJson(socket, {
          type: 'BRIDGE_STAGE_RESULT',
          payload: { request_id: reqId, ok: false, error: errText },
        });
        return;
      }
      const prev = pendingStage.get(reqId);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        pendingStage.delete(reqId);
        sendJson(socket, {
          type: 'BRIDGE_STAGE_RESULT',
          payload: { request_id: reqId, ok: false, error: 'Figma 插件生成臨時拼板超時（30 秒），請減少選取數量後重試' },
        });
      }, STAGE_TIMEOUT_MS);
      pendingStage.set(reqId, { requester: socket, timer });

      const forward: BridgeStageRequestPayload = {
        request_id: reqId,
        node_ids: nodeIds,
        title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 80) : undefined,
        target_page_id: typeof payload.target_page_id === 'string' && payload.target_page_id.trim() ? payload.target_page_id.trim() : undefined,
      };
      sendJson(pluginSock, { type: 'BRIDGE_STAGE_BOARD', payload: forward });
      if (!quiet) console.log('[bridge] stage -> figma (' + nodeIds.length + ' ids, req=' + reqId + ')');
      return;
    }

    if (receivedType === 'BRIDGE_STAGE_RESULT') {
      if (!isRecord(payload) || typeof payload.request_id !== 'string') return;
      const pending = pendingStage.get(payload.request_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingStage.delete(payload.request_id);
      const resPayload = payload as unknown as BridgeStageResultPayload;
      sendJson(pending.requester, { type: 'BRIDGE_STAGE_RESULT', payload: resPayload });
      if (!quiet) console.log('[bridge] stage result -> review (' + (resPayload.ok ? 'OK staged=' + (resPayload.staged_count ?? 0) : 'ERR ' + (resPayload.error ?? '')) + ')');
      return;
    }

    const stage = state.page ? 'page=' + state.page.pageName + ' (' + state.page.pageId + ')' : 'file=' + (state.fileKey ?? 'none');

    try {
      let count = 0;
      let committed: number | undefined;
      let pages: unknown[] | undefined;
      let pageId: string | undefined;

      switch (receivedType) {
        case 'SYNC_START': {
          if (!isRecord(payload)) throw new Error('SYNC_START payload must be an object');
          const meta = payload as unknown as FileMetaPayload;
          if (!asString(meta.file_key)) throw new Error('SYNC_START payload.file_key is required');
          state.fileKey = asString(meta.file_key);
          state.fileName = asString(meta.file_name) || state.fileName;
          state.page = null;
          state.db = dbFor(state.fileKey, asString(meta.file_name), state);
          state.db.upsertFileMeta(meta);
          const requested = Array.isArray(meta.pages) ? meta.pages : [];
          state.batchId = state.db.beginBatch(state.fileKey, requested.map((p) => ({ page_id: String(p.page_id), page_name: String(p.page_name) })));
          if (state.folder) {
            const manifestPath = join(state.folder, 'manifest.json');
            let manifest: Record<string, unknown> = { file_key: meta.file_key, file_name: meta.file_name, created_at: nowIso(), updated_at: nowIso(), pages: [] };
            try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>; } catch { /* first write */ }
            manifest.file_key = meta.file_key;
            manifest.file_name = meta.file_name;
            manifest.updated_at = nowIso();
            atomicJson(manifestPath, manifest);
          }
          count = 1;
          break;
        }
        case 'PAGE_START': {
          if (!state.db) throw new Error('PAGE_START requires SYNC_START');
          if (!isRecord(payload)) throw new Error('PAGE_START payload must be an object');
          const page = payload as unknown as PageStartPayload;
          if (!asString(page.page_id)) throw new Error('PAGE_START payload.page_id is required');
          const fileKey = asString(page.file_key) || state.fileKey || '';
          const canonical = state.db.resolvePageId(fileKey, page);
          state.db.beginPage(fileKey, { ...page, page_id: canonical });
          state.page = { fileKey, pageId: canonical, pageName: asString(page.page_name), pageIndex: finiteNumber(page.page_index, 0) };
          if (state.batchId !== null) state.db.setBatchPage(state.batchId, page.page_id, page.page_name, 'SYNCING', 0);
          count = 1;
          break;
        }
        case 'PAGE_SKIP': {
          if (!state.db) throw new Error('PAGE_SKIP requires SYNC_START');
          const page = payload as unknown as PageSkipPayload;
          if (!asString(page.page_id)) throw new Error('PAGE_SKIP payload.page_id is required');
          state.db.skipPage(state.fileKey ?? '', { ...page, page_id: state.db.resolvePageId(state.fileKey ?? '', page) });
          if (state.batch) state.batch.pages[page.page_id] = 'SKIPPED';
          pageId = page.page_id;
          saveBatch(state);
          updateManifest(state, page, 'SKIPPED', 0);
          count = 1;
          break;
        }
        case 'CHUNK_NODES': {
          if (!state.db) throw new Error('CHUNK_NODES requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('CHUNK_NODES payload must be an array');
          if (state.page) count = state.db.stageNodes(state.page.fileKey, state.page.pageId, payload as NodeRow[]);
          else count = state.db.insertNodesBatch(state.fileKey ?? '', payload as NodeRow[]);
          break;
        }
        case 'PAGE_COMPLETE': {
          if (!state.db) throw new Error('PAGE_COMPLETE requires SYNC_START');
          if (!state.page) throw new Error('PAGE_COMPLETE without an open PAGE_START');
          const done = payload as unknown as PageCompletePayload;
          if (asString(done.page_id) && asString(done.page_id) !== state.page.pageId) throw new Error('PAGE_COMPLETE page_id mismatch');
          const expected = typeof done.total_nodes === 'number' ? done.total_nodes : undefined;
          committed = state.db.completePage(state.page.fileKey, state.page.pageId, expected);
          pageId = state.page.pageId;
          state.db.checkpoint();
          if (state.batchId !== null) state.db.setBatchPage(state.batchId, state.page.pageId, state.page.pageName, 'DONE', committed);
          updateManifest(state, { page_id: state.page.pageId, page_name: state.page.pageName, page_index: state.page.pageIndex }, 'DONE', committed);
          state.page = null;
          count = committed;
          break;
        }
        case 'PAGE_STATUS': {
          const wantedKey = isRecord(payload) && typeof payload.file_key === 'string' ? payload.file_key : state.fileKey;
          if (!state.db) {
            if (!wantedKey) throw new Error('PAGE_STATUS requires file_key');
            state.fileKey = wantedKey;
            state.db = dbFor(wantedKey, state.fileName || '', state);
          }
          const wanted = isRecord(payload) && typeof payload.file_key === 'string' ? payload.file_key : state.fileKey ?? undefined;
          pages = state.db.listPages(wanted);
          count = pages.length;
          break;
        }
        case 'PAGE_CENSUS': {
          if (!state.db) throw new Error('PAGE_CENSUS requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('PAGE_CENSUS payload must be an array');
          count = state.db.replacePageCensus(state.fileKey ?? '', payload as PageCensusRow[]);
          break;
        }
        case 'RESET_DATABASE': {
          if (!isRecord(payload) || payload.confirm !== true) throw new Error('RESET_DATABASE requires confirm:true');
          const reqKey = typeof payload.file_key === 'string' && payload.file_key.trim() ? payload.file_key.trim() : state.fileKey;
          if (!state.db && reqKey) {
            state.fileKey = reqKey;
            state.db = dbFor(reqKey, state.fileName || '', state);
          }
          if (state.db) state.db.resetAll();
          else if (fixedDb) fixedDb.resetAll();
          else throw new Error('RESET_DATABASE requires an active project database');
          state.page = null;
          count = 1;
          break;
        }
        case 'CHUNK_VARIABLES': {
          if (!state.db) throw new Error('CHUNK_VARIABLES requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('CHUNK_VARIABLES payload must be an array');
          count = state.db.insertVariablesBatch(state.fileKey ?? '', payload as VariableRow[]);
          break;
        }
        case 'CHUNK_COMPONENTS': {
          if (!state.db) throw new Error('CHUNK_COMPONENTS requires SYNC_START');
          if (!Array.isArray(payload)) throw new Error('CHUNK_COMPONENTS payload must be an array');
          count = state.db.insertComponentsBatch(state.fileKey ?? '', payload as ComponentRow[]);
          break;
        }
        case 'SYNC_COMPLETE': {
          if (!state.db) throw new Error('SYNC_COMPLETE requires SYNC_START');
          if (!isRecord(payload)) throw new Error('SYNC_COMPLETE payload must be an object');
          const totalNodes = payload.total_nodes;
          if (typeof totalNodes !== 'number' || !Number.isFinite(totalNodes)) throw new Error('SYNC_COMPLETE total_nodes must be finite');
          state.db.finalizeSync(state.fileKey ?? '', totalNodes);
          if (state.batchId !== null) state.db.finishBatch(state.batchId, 'DONE');
          count = 1;
          break;
        }
        default:
          sendError(socket, receivedType, 'UNKNOWN_MESSAGE_TYPE: ' + receivedType, batchId);
          return;
      }

      const ack: AckOk = { status: 'OK', receivedType: receivedType as WsMessage['type'], count };
      if (committed !== undefined) ack.committed = committed;
      if (pages !== undefined) ack.pages = pages;
      if (pages !== undefined && state.db && state.fileKey) ack.latestBatch = state.db.latestBatch(state.fileKey);
      if (pageId !== undefined) ack.pageId = pageId;
      if (batchId !== undefined) ack.batchId = batchId;
      sendJson(socket, ack);
      if (!quiet) {
        if (receivedType === 'SYNC_COMPLETE') {
          const stats = state.db ? state.db.getStats(state.fileKey ?? undefined) : null;
          console.log('[ws] SYNC_COMPLETE — nodes=' + (stats ? stats.nodes : 0) + ' file="' + (stats && stats.file ? stats.file.file_name : 'n/a') + '"');
        } else console.log('[ws] ' + receivedType + ' +' + count + ' [' + stage + ']');
      }
    } catch (error) {
      sendError(socket, receivedType, describeError(error), batchId);
      if (!quiet) console.error('[ws] ' + receivedType + ' failed [' + stage + ']: ' + describeError(error));
    }
  }

  const httpServer = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    if (req.method === 'OPTIONS' && urlPath === '/api/apply-proposals') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/apply-proposals') {
      const sendJsonRes = (code: number, body: unknown): void => {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(body));
      };
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= 4 * 1024 * 1024) chunks.push(chunk);
      });
      req.on('end', () => {
        if (totalBytes > 4 * 1024 * 1024) {
          sendJsonRes(413, { ok: false, error: 'request body too large' });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            projectId?: string;
            confirm?: boolean;
            items?: Array<{ id?: string; major?: string; minor?: string; generation?: string }>;
          };
          if (parsed?.confirm !== true) {
            sendJsonRes(400, { ok: false, error: 'apply-proposals requires confirm: true' });
            return;
          }
          const rows = Array.isArray(parsed.items) ? parsed.items : [];
          if (rows.length === 0) {
            sendJsonRes(400, { ok: false, error: 'items must be a non-empty array' });
            return;
          }
          const proj = resolveProject(root, { project: typeof parsed.projectId === 'string' ? parsed.projectId : undefined });
          if (!existsSync(proj.dbPath)) {
            sendJsonRes(404, { ok: false, error: 'project SQLite database not found' });
            return;
          }
          const cleanRows: Array<{ id: string; major: string; minor: string; generation: string }> = [];
          for (const raw of rows) {
            const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
            const major = typeof raw?.major === 'string' ? raw.major.trim() : '';
            const minor = typeof raw?.minor === 'string' ? raw.minor.trim() : '';
            if (!id || !major) continue;
            const generation = typeof raw?.generation === 'string'
              ? raw.generation.trim()
              : (major === '老UI' ? 'old' : (major === '系統UI' ? '' : 'new'));
            cleanRows.push({ id, major, minor, generation });
          }
          if (cleanRows.length === 0) {
            sendJsonRes(400, { ok: false, error: 'no valid label rows provided' });
            return;
          }

          const nodeIds = [...new Set(cleanRows.map((r) => r.id))];
          const db = new Database(proj.dbPath, { readonly: true, fileMustExist: true });
          const foundIds = new Set<string>();
          try {
            for (let i = 0; i < nodeIds.length; i += 500) {
              const part = nodeIds.slice(i, i + 500);
              const q = db.prepare('SELECT id FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')').all(...part) as Array<{ id: string }>;
              for (const r of q) foundIds.add(r.id);
            }
          } finally {
            db.close();
          }
          const missing = nodeIds.filter((id) => !foundIds.has(id));
          if (missing.length > 0) {
            sendJsonRes(400, { ok: false, error: 'node_id not found in SQLite: ' + missing.slice(0, 5).join(', ') });
            return;
          }

          const existingDoc = tryLoadScreenLabelsV2(proj.labelsPath);
          const screens: ScreenLabelV2[] = existingDoc ? existingDoc.screens.map((s) => ({ ...s })) : [];
          const byId = new Map(screens.map((s) => [s.id, s]));
          const committedIds = new Set<string>();

          for (const row of cleanRows) {
            const label = row.major === '系統UI'
              ? (row.minor ? '系統UI - ' + row.minor : '系統UI')
              : (row.minor ? (row.major === '老UI' ? '老UI - ' + row.minor : row.minor) : row.major);
            const cur = byId.get(row.id);
            if (cur) {
              cur.label = label;
              cur.major = row.major;
              cur.minor = row.minor;
              cur.generation = row.generation;
            } else {
              const rec: ScreenLabelV2 = {
                id: row.id,
                label,
                major: row.major,
                minor: row.minor,
                generation: row.generation,
              };
              screens.push(rec);
              byId.set(row.id, rec);
            }
            committedIds.add(row.id);
          }

          const counts = recomputeV2Counts(screens);
          const nextDoc = {
            version: 2,
            sample: existingDoc?.sample ?? proj.id,
            note: existingDoc?.note ?? ('updated via workbench proposals (' + new Date().toISOString().slice(0, 10) + ')'),
            counts,
            screens,
          };
          mkdirSync(dirname(proj.labelsPath), { recursive: true });
          atomicJson(proj.labelsPath, nextDoc);

          const propDoc = loadProposals(root, proj.id);
          let remainingProposals = 0;
          if (propDoc) {
            propDoc.items = propDoc.items.filter((it) => !committedIds.has(it.id));
            remainingProposals = propDoc.items.length;
            saveProposals(root, proj.id, propDoc);
          }

          generateReviewBoard({ projectId: proj.id, dbPath: proj.dbPath, open: false });
          generateProjectHub(root);
          if (!quiet) console.log('[bridge] apply-proposals project=' + proj.id + ' applied=' + committedIds.size + ' remaining=' + remainingProposals);
          sendJsonRes(200, { ok: true, applied: committedIds.size, remainingProposals, counts });
        } catch (err) {
          sendJsonRes(500, { ok: false, error: describeError(err) });
        }
      });
      return;
    }
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/review' || urlPath === '/review.html')) {
      if (existsSync(reviewHtmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(reviewHtmlPath, 'utf8'));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('review.html not found. Run: npm run review:board');
      }
      return;
    }
    const projMatch = req.method === 'GET'
      ? (/^\/review-([A-Za-z0-9_-]{1,80})\.html$/.exec(urlPath) ?? /^\/review\/([A-Za-z0-9_-]{1,80})$/.exec(urlPath))
      : null;
    if (projMatch) {
      const targetHtml = join(root, '.scratch', 'review-' + projMatch[1] + '.html');
      if (existsSync(targetHtml)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(targetHtml, 'utf8'));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('project workbench not found. Run: npm run review:board -- --project ' + projMatch[1]);
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });

  wss.on('connection', (socket, request) => {
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!quiet) console.log('[ws] client connected (' + remote + ')');
    states.set(socket, { projectId: null, fileKey: null, fileName: null, role: null, page: null, db: null, folder: null, batch: null, batchId: null });
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('message', (data, isBinary) => {
      if (isBinary) { sendError(socket, null, 'BINARY_FRAMES_NOT_SUPPORTED'); return; }
      handleRawMessage(socket, data.toString());
    });
    socket.on('error', (error) => { if (!quiet) console.error('[ws] socket error: ' + describeError(error)); });
    socket.on('close', (code, reason) => {
      const state = states.get(socket);
      const closedRole = state?.role ?? null;
      if (state?.page && state.db) {
        state.db.abortPage(state.page.fileKey, state.page.pageId);
        if (state.batchId !== null) { state.db.setBatchPage(state.batchId, state.page.pageId, state.page.pageName, 'INCOMPLETE', 0); state.db.finishBatch(state.batchId, 'PARTIAL'); }
        if (!quiet) console.log('[ws] page aborted on disconnect: ' + state.page.pageName);
      }
      states.delete(socket);
      alive.delete(socket);

      if (closedRole === 'figma-plugin') {
        for (const [reqId, pending] of pendingFocus.entries()) {
          clearTimeout(pending.timer);
          pendingFocus.delete(reqId);
          sendJson(pending.requester, {
            type: 'BRIDGE_FOCUS_RESULT',
            payload: { request_id: reqId, ok: false, error: 'Figma 插件已斷線' },
          });
        }
        for (const [reqId, pending] of pendingStage.entries()) {
          clearTimeout(pending.timer);
          pendingStage.delete(reqId);
          sendJson(pending.requester, {
            type: 'BRIDGE_STAGE_RESULT',
            payload: { request_id: reqId, ok: false, error: 'Figma 插件已斷線' },
          });
        }
        for (const [reqId, pending] of pendingLookup.entries()) {
          if (pending.requester === socket) {
            clearTimeout(pending.timer);
            pendingLookup.delete(reqId);
          }
        }
        broadcastBridgeStatus();
      } else if (closedRole === 'review-ui') {
        for (const [reqId, pending] of pendingFocus.entries()) {
          if (pending.requester === socket) {
            clearTimeout(pending.timer);
            pendingFocus.delete(reqId);
          }
        }
        for (const [reqId, pending] of pendingStage.entries()) {
          if (pending.requester === socket) {
            clearTimeout(pending.timer);
            pendingStage.delete(reqId);
          }
        }
        if (activeReviewClients().length === 0) {
          for (const [reqId, pending] of pendingLookup.entries()) {
            clearTimeout(pending.timer);
            pendingLookup.delete(reqId);
            sendJson(pending.requester, {
              type: 'BRIDGE_LOOKUP_RESULT',
              payload: { request_id: reqId, ok: false, error: '複審工作台已斷線' },
            });
          }
        }
        broadcastBridgeStatus();
      }

      if (!quiet) console.log('[ws] client disconnected code=' + code + (reason.length ? ' (' + reason.toString() + ')' : ''));
    });
  });

  wss.on('error', (error) => { if (!quiet) console.error('[ws] server error: ' + describeError(error)); });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) { socket.terminate(); continue; }
      alive.set(socket, false);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, HEARTBEAT_MS);

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const onListening = (): void => { httpServer.off('error', onStartupError); resolveReady(); };
      const onStartupError = (error: Error): void => { httpServer.off('listening', onListening); rejectReady(error); };
      httpServer.once('listening', onListening);
      httpServer.once('error', onStartupError);
      httpServer.listen(port, host);
    });
  } catch (error) {
    clearInterval(heartbeat);
    fixedDb?.close();
    for (const db of openDbs.values()) db.close();
    try { wss.close(); } catch { /* never bound */ }
    try { httpServer.close(); } catch { /* never bound */ }
    throw error;
  }

  if (!quiet) {
    console.log('[ws] listening on ws://' + host + ':' + port + '  (review UI: http://' + host + ':' + port + '/review)');
    console.log('[ws] sqlite sink: ' + (fixedDb ? 'fixed' : join(dataRoot, '<file-key>/graph.sqlite')));
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const pending of pendingFocus.values()) clearTimeout(pending.timer);
    pendingFocus.clear();
    for (const pending of pendingLookup.values()) clearTimeout(pending.timer);
    pendingLookup.clear();
    for (const pending of pendingStage.values()) clearTimeout(pending.timer);
    pendingStage.clear();
    wss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolveClosed) => { wss.close(() => resolveClosed()); });
    await new Promise<void>((resolveHttp) => { httpServer.close(() => resolveHttp()); });
    fixedDb?.close();
    for (const db of openDbs.values()) db.close();
  };

  return { wss, db: fixedDb, host, port, close };
}

function isDirectInvocation(): boolean {
  return typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
}

if (isDirectInvocation()) {
  startIngestServer()
    .then((running) => {
      let shuttingDown = false;
      const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('[ws] ' + signal + ' received, flushing WAL and shutting down');
        running.close().then(() => process.exit(0)).catch((error) => { console.error('[ws] shutdown failed: ' + describeError(error)); process.exit(1); });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => { console.error('[ws] failed to start: ' + describeError(error)); process.exitCode = 1; });
}
