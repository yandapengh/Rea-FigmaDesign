/// <reference lib="es2022" />
/** Figma sandbox entry (stage 2): page-by-page, ACK-gated, no page kept for extraction. */

import type { ComponentRow, FileMetaPayload, NodeRow, VariableRow, WsEnvelopeMessage } from '../../shared/protocol';
import { dehydrateComponent, dehydrateNode, dehydrateVariableValue, getNodeChildren } from './serializer';

const BATCH_SIZE = 250;
const MAX_BATCH_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 30000;

figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

let running = false;
let batchSeq = 0;
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

figma.ui.onmessage = (message: unknown): void => {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
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
