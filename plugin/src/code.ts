/// <reference lib="es2022" />
/** Figma sandbox entry (stage 2): page-by-page, ACK-gated, no page kept for extraction. */

import type {
  BridgeFocusRequestPayload,
  BridgeFocusResultPayload,
  BridgeLookupRequestPayload,
  BridgeSelectionItem,
  ComponentRow,
  FileMetaPayload,
  NodeRow,
  VariableRow,
  WsEnvelopeMessage,
} from '../../shared/protocol';
import { dehydrateComponent, dehydrateNode, dehydrateVariableValue, getNodeChildren } from './serializer';

const BATCH_SIZE = 250;
const MAX_BATCH_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 30000;

figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

let running = false;
let focusing = false;
let batchSeq = 0;
let lookupSeq = 0;
const waiters = new Map<number, (ok: boolean, error?: string) => void>();
const progress = { total: 0, index: 0, page: '', committed: 0 };

function post(message: unknown, batchId?: number): void {
  figma.ui.postMessage({ type: 'RELAY', batchId, message });
}

function send(message: WsEnvelopeMessage, timeoutMs: number = ACK_TIMEOUT_MS): Promise<void> {
  const batchId = ++batchSeq;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(batchId);
      reject(new Error('ACK timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    waiters.set(batchId, (ok, error) => {
      clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error(error || 'relay rejected'));
    });
    post(message, batchId);
  });
}

function fileMeta(): FileMetaPayload {
  let key = figma.root.id;
  try {
    if (typeof figma.fileKey === 'string' && figma.fileKey) key = figma.fileKey;
  } catch {
    /* local files */
  }
  return { file_key: key, file_name: figma.root.name || 'Untitled', extracted_at: new Date().toISOString(), page_count: figma.root.children.length };
}

function sendMeta(): void {
  const pages = figma.root.children.map((page, index) => ({ page_id: page.id, page_name: page.name, page_index: index }));
  figma.ui.postMessage({ type: 'PAGE_META', payload: { file: fileMeta(), pages } });
  postSelectionCount();
}

function progressMsg(stage: string, extra = ''): void {
  figma.ui.postMessage({ type: 'PAGE_PROGRESS', payload: { index: progress.index, total: progress.total, page: progress.page, stage, committed: progress.committed, extra } });
}

/** Local variables are small; ACK-gated like every other batch. */
async function extractVariables(): Promise<number> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const names = new Map<string, string>();
  for (const c of collections) names.set(c.id, c.name);
  const variables = await figma.variables.getLocalVariablesAsync();
  for (let start = 0; start < variables.length; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, variables.length);
    const chunk: VariableRow[] = [];
    for (let i = start; i < end; i += 1) {
      const v = variables[i];
      const valuesByMode: Record<string, unknown> = {};
      for (const modeId of Object.keys(v.valuesByMode)) valuesByMode[modeId] = dehydrateVariableValue(v.valuesByMode[modeId]);
      chunk.push({ id: v.id, name: v.name, collection_id: v.variableCollectionId, collection_name: names.get(v.variableCollectionId) ?? '', resolved_type: v.resolvedType, values_by_mode_json: JSON.stringify(valuesByMode), scopes_json: JSON.stringify(v.scopes ?? []) });
    }
    await send({ type: 'CHUNK_VARIABLES', payload: chunk });
  }
  return variables.length;
}

/** Iterative traversal: one page in memory at a time, flush by count or ~1MB. */
async function exportPage(page: PageNode, index: number, total: number, fileKey: string): Promise<void> {
  progress.index = index;
  progress.total = total;
  progress.page = page.name;
  progress.committed = 0;
  progressMsg('loading');

  await page.loadAsync();
  if (page.children.length === 0) {
    await send({ type: 'PAGE_SKIP', payload: { file_key: fileKey, page_id: page.id, page_name: page.name, page_index: index } });
    progressMsg('skipped');
    return;
  }

  await send({ type: 'PAGE_START', payload: { file_key: fileKey, page_id: page.id, page_name: page.name, page_index: index, child_count: page.children.length, is_empty: 0 } });

  let buffer: NodeRow[] = [];
  let bytes = 0;
  let pageCommitted = 0;
  let componentBuffer: ComponentRow[] = [];

  const flush = async (force: boolean): Promise<void> => {
    if (buffer.length === 0) return;
    if (!force && buffer.length < BATCH_SIZE && bytes < MAX_BATCH_BYTES) return;
    const chunk = buffer;
    buffer = [];
    bytes = 0;
    await send({ type: 'CHUNK_NODES', payload: chunk });
    pageCommitted += chunk.length;
    progress.committed = pageCommitted;
    progressMsg('streaming');
  };

  const flushComponents = async (force: boolean): Promise<void> => {
    if (componentBuffer.length === 0) return;
    if (!force && componentBuffer.length < BATCH_SIZE) return;
    const chunk = componentBuffer;
    componentBuffer = [];
    await send({ type: 'CHUNK_COMPONENTS', payload: chunk });
  };

  const stack: Array<{ node: SceneNode; parentId: string | null; depth: number; childIndex: number }> = [];
  const roots = page.children;
  for (let i = roots.length - 1; i >= 0; i -= 1) stack.push({ node: roots[i], parentId: null, depth: 0, childIndex: i });

  while (stack.length > 0) {
    const item = stack.pop()!;
    const d = await dehydrateNode(item.node, item.parentId, page.id, page.name, item.childIndex, item.depth);
    buffer.push(d.row);
    bytes += JSON.stringify(d.row).length;
    if (item.node.type === 'COMPONENT' || item.node.type === 'COMPONENT_SET') {
      componentBuffer.push(dehydrateComponent(item.node, page.id, page.name));
      await flushComponents(false);
    }
    await flush(false);
    if (!d.shouldSkipChildren && item.depth < 100) {
      const kids = getNodeChildren(item.node);
      if (kids !== null) {
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ node: kids[i], parentId: item.node.id, depth: item.depth + 1, childIndex: i });
      }
    }
  }

  await flush(true);
  await flushComponents(true);
  progressMsg('committing');
  await send({ type: 'PAGE_COMPLETE', payload: { file_key: fileKey, page_id: page.id, total_nodes: pageCommitted } });
  progressMsg('done');
}

async function run(pageIds: string[]): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const selected = figma.root.children.filter((p) => pageIds.indexOf(p.id) !== -1);
    if (selected.length === 0) throw new Error('no pages selected');
    const meta = fileMeta();
    meta.pages = selected.map((p, i) => ({ page_id: p.id, page_name: p.name, page_index: figma.root.children.indexOf(p) }));
    await send({ type: 'SYNC_START', payload: meta });
    try { await extractVariables(); } catch (error) { figma.ui.postMessage({ type: 'RUN_WARN', payload: { message: 'variables: ' + (error instanceof Error ? error.message : String(error)) } }); }
    for (let i = 0; i < selected.length; i += 1) {
      try {
        await exportPage(selected[i], i + 1, selected.length, meta.file_key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        figma.ui.postMessage({ type: 'PAGE_ERROR', payload: { page: selected[i].name, pageId: selected[i].id, stage: 'export', message } });
        throw error;
      }
    }
    await send({ type: 'SYNC_COMPLETE', payload: { total_nodes: progress.committed, duration_ms: Date.now() - started } });
    figma.notify('Rea-FigmaDesign：已完成 ' + selected.length + ' 頁', { timeout: 5000 });
    figma.ui.postMessage({ type: 'RUN_DONE', payload: { pages: selected.length, duration: Date.now() - started } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({ type: 'RUN_ERROR', payload: { message } });
    figma.notify('Rea-FigmaDesign 匯出失敗：' + message, { error: true, timeout: 8000 });
  } finally {
    running = false;
  }
}

function getContainingPage(node: SceneNode): PageNode | null {
  let ancestor: BaseNode | null = node.parent;
  while (ancestor !== null) {
    if (ancestor.type === 'PAGE') return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

function postFocusResult(payload: BridgeFocusResultPayload): void {
  figma.ui.postMessage({ type: 'BRIDGE_FOCUS_RESULT', payload });
}

function extractTextPreview(root: SceneNode): string {
  const stack: SceneNode[] = [root];
  const snippets: string[] = [];
  const seen = new Set<string>();
  let visited = 0;
  while (stack.length > 0 && visited < 60 && snippets.length < 4) {
    const cur = stack.pop()!;
    visited += 1;
    if ('visible' in cur && cur.visible === false) continue;
    if (cur.type === 'TEXT') {
      const txt = cur.characters.replace(/\s+/g, ' ').trim();
      if (txt && !seen.has(txt)) {
        seen.add(txt);
        snippets.push(txt);
      }
    }
    const kids = getNodeChildren(cur);
    if (kids !== null) {
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }
  return snippets.join(' · ').slice(0, 140);
}

function collectAncestorIds(node: SceneNode): string[] {
  const ids: string[] = [];
  let p: BaseNode | null = node.parent;
  while (p !== null && p.type !== 'PAGE' && p.type !== 'DOCUMENT' && ids.length < 30) {
    ids.push(p.id);
    p = p.parent;
  }
  return ids;
}

function postSelectionCount(): void {
  if (running) return;
  figma.ui.postMessage({ type: 'SELECTION_COUNT', count: figma.currentPage.selection.length });
}

function lookupCurrentSelection(): void {
  if (running) {
    figma.ui.postMessage({ type: 'BRIDGE_LOOKUP_ERROR', error: '插件正在匯出資料，請稍候再查找' });
    return;
  }
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    figma.notify('請先在 Figma 畫布中選中至少 1 個設計稿', { timeout: 2500 });
    figma.ui.postMessage({ type: 'BRIDGE_LOOKUP_ERROR', error: '請先在 Figma 畫布中選中至少 1 個設計稿' });
    return;
  }
  const page = figma.currentPage;
  const meta = fileMeta();
  const items: BridgeSelectionItem[] = sel.slice(0, 200).map((node) => {
    const item: BridgeSelectionItem = {
      id: node.id,
      name: node.name || '(未命名)',
      type: node.type,
      page_id: page.id,
      page_name: page.name,
      text_preview: extractTextPreview(node),
      ancestor_ids: collectAncestorIds(node),
    };
    if ('width' in node && typeof node.width === 'number' && Number.isFinite(node.width)) {
      item.width = Math.round(node.width);
    }
    if ('height' in node && typeof node.height === 'number' && Number.isFinite(node.height)) {
      item.height = Math.round(node.height);
    }
    return item;
  });
  const payload: BridgeLookupRequestPayload = {
    request_id: 'lookup-' + Date.now() + '-' + (++lookupSeq),
    file_key: meta.file_key,
    file_name: meta.file_name,
    page_id: page.id,
    page_name: page.name,
    items,
  };
  figma.ui.postMessage({ type: 'BRIDGE_LOOKUP_SELECTION', payload });
}

/** Locate and select nodes within a single Figma page (never cross-page). */
async function focusBridgeNodes(payload: BridgeFocusRequestPayload): Promise<void> {
  const reqId = typeof payload?.request_id === 'string' ? payload.request_id : '';
  if (running) {
    postFocusResult({ request_id: reqId, ok: false, error: '插件正在匯出資料，請稍候再定位' });
    return;
  }
  if (focusing) {
    postFocusResult({ request_id: reqId, ok: false, error: '上一次定位仍在進行中，請稍候' });
    return;
  }
  const rawIds = Array.isArray(payload?.node_ids) ? payload.node_ids : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  const pageOnly = payload?.page_only === true;
  if (ids.length === 0 && !(pageOnly && (payload?.page_id || payload?.page_name))) {
    postFocusResult({ request_id: reqId, ok: false, error: '沒有提供可定位的 node_id' });
    return;
  }

  focusing = true;
  try {
    if (pageOnly) {
      let targetPage: PageNode | null = null;
      if (typeof payload.page_id === 'string' && payload.page_id) {
        targetPage = figma.root.children.find((p) => p.id === payload.page_id) ?? null;
      }
      if (!targetPage && typeof payload.page_name === 'string' && payload.page_name.trim()) {
        const wantName = payload.page_name.trim();
        targetPage = figma.root.children.find((p) => p.name.trim() === wantName) ?? null;
      }
      if (!targetPage && ids.length > 0) {
        const first = await figma.getNodeByIdAsync(ids[0]);
        if (first && first.type !== 'DOCUMENT') {
          targetPage = first.type === 'PAGE' ? (first as PageNode) : getContainingPage(first as SceneNode);
        }
      }
      if (!targetPage) {
        postFocusResult({ request_id: reqId, ok: false, page_only: true, error: '在目前 Figma 檔案中找不到對應頁面' });
        return;
      }
      if (figma.currentPage.id !== targetPage.id) {
        await figma.setCurrentPageAsync(targetPage);
      }
      figma.notify('Rea-FigmaDesign：已跳轉到頁面 · ' + targetPage.name, { timeout: 2200 });
      postFocusResult({
        request_id: reqId,
        ok: true,
        page_id: targetPage.id,
        page_name: targetPage.name,
        page_only: true,
        selected_count: 0,
      });
      return;
    }

    const resolved: Array<{ id: string; node: BaseNode | null }> = [];
    for (let i = 0; i < ids.length; i += 10) {
      const part = ids.slice(i, i + 10);
      const batch = await Promise.all(part.map(async (id) => ({ id, node: await figma.getNodeByIdAsync(id) })));
      for (const item of batch) resolved.push(item);
    }

    const missingIds: string[] = [];
    const pageGroups = new Map<string, { page: PageNode; nodes: SceneNode[] }>();
    for (const item of resolved) {
      if (!item.node) {
        missingIds.push(item.id);
        continue;
      }
      if (item.node.type === 'DOCUMENT' || item.node.type === 'PAGE') {
        missingIds.push(item.id);
        continue;
      }
      const scene = item.node as SceneNode;
      const page = getContainingPage(scene);
      if (!page) {
        missingIds.push(item.id);
        continue;
      }
      const group = pageGroups.get(page.id);
      if (group) group.nodes.push(scene);
      else pageGroups.set(page.id, { page, nodes: [scene] });
    }

    if (pageGroups.size === 0) {
      postFocusResult({
        request_id: reqId,
        ok: false,
        missing_ids: missingIds,
        error: '在目前 Figma 檔案中找不到對應節點（可能已刪除或未開啟對應檔案）',
      });
      return;
    }

    if (pageGroups.size > 1) {
      postFocusResult({
        request_id: reqId,
        ok: false,
        cross_page_pages: [...pageGroups.values()].map((g) => ({
          page_id: g.page.id,
          page_name: g.page.name,
          count: g.nodes.length,
        })),
        error: '目標節點跨越多個 Figma 頁面，請按單頁逐一跳轉',
      });
      return;
    }

    const target = pageGroups.values().next().value as { page: PageNode; nodes: SceneNode[] };
    if (figma.currentPage.id !== target.page.id) {
      await figma.setCurrentPageAsync(target.page);
    }
    figma.currentPage.selection = target.nodes;
    figma.viewport.scrollAndZoomIntoView(target.nodes);
    figma.notify('Rea-FigmaDesign：已定位 ' + target.nodes.length + ' 個節點 · ' + target.page.name, { timeout: 2500 });

    postFocusResult({
      request_id: reqId,
      ok: true,
      page_id: target.page.id,
      page_name: target.page.name,
      selected_count: target.nodes.length,
      missing_ids: missingIds.length > 0 ? missingIds : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postFocusResult({
      request_id: reqId,
      ok: false,
      error: 'Figma 定位失敗：' + message,
    });
  } finally {
    focusing = false;
  }
}

figma.on('selectionchange', () => {
  postSelectionCount();
});

figma.ui.onmessage = (message: unknown): void => {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
  if (msg.type === 'LOOKUP_SELECTION') {
    lookupCurrentSelection();
    return;
  }
  if (msg.type === 'LOOKUP_NOTIFY') {
    figma.notify(String(msg.message || ''), { error: msg.isError === true, timeout: 3000 });
    return;
  }
  if (msg.type === 'BRIDGE_FOCUS_NODES') {
    void focusBridgeNodes(msg.payload as BridgeFocusRequestPayload);
    return;
  }
  if (msg.type === 'ACK') {
    const id = typeof msg.batchId === 'number' ? msg.batchId : -1;
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter(msg.status === 'OK', typeof msg.error === 'string' ? msg.error : undefined);
    }
    return;
  }
  if (msg.type === 'REQUEST_META' || msg.action === 'REQUEST_META') {
    sendMeta();
    return;
  }
  if (msg.action === 'START_EXTRACTION') {
    const ids = Array.isArray(msg.pageIds) ? (msg.pageIds as string[]) : [];
    void run(ids);
  }
};

sendMeta();
