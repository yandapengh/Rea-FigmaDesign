/**
 * Rea-FigmaDesign AST Probe — Figma sandbox entry.
 *
 * IMPORTANT: This file runs in Figma's QuickJS sandbox. It has figma.* APIs
 * but NO WebSocket / window / DOM. All data leaves through
 * figma.ui.postMessage -> ui.html -> ws://127.0.0.1:8765.
 *
 * The manifest uses documentAccess: "dynamic-page", therefore:
 *   - every page is loaded with await page.loadAsync()
 *   - instances resolve with await getMainComponentAsync()
 *   - variables use getLocalVariablesAsync / getLocalVariableCollectionsAsync
 */

import type {
  ComponentRow,
  FileMetaPayload,
  NodeRow,
  PageCensusRow,
  VariableRow,
  WsMessage,
} from '../../shared/protocol';
import {
  dehydrateComponent,
  dehydrateNode,
  dehydrateVariableValue,
  getNodeChildren,
} from './serializer';

const BATCH_SIZE = 500;
const MAX_DEPTH = 100;

figma.showUI(__html__, { width: 380, height: 520, themeColors: true });

interface ExtractionBuffers {
  nodes: NodeRow[];
  components: ComponentRow[];
  totalNodes: number;
}

let running = false;
let censusRunning = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function post(message: WsMessage): void {
  figma.ui.postMessage(message);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function currentFileKey(): string {
  try {
    const key = figma.fileKey;
    if (typeof key === 'string' && key.length > 0) return key;
  } catch {
    // figma.fileKey can be unavailable in local/offline files.
  }
  return figma.root.id;
}

function buildFileMeta(): FileMetaPayload {
  return {
    file_key: currentFileKey(),
    file_name: figma.root.name || 'Untitled',
    extracted_at: new Date().toISOString(),
    page_count: figma.root.children.length,
  };
}

/**
 * Emits local variables in <= 500-row chunks. Alias values are preserved as
 * { type: 'VARIABLE_ALIAS', id }; raw RGB floats become hex strings.
 */
async function extractVariables(): Promise<number> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionNames = new Map<string, string>();
  for (let index = 0; index < collections.length; index += 1) {
    collectionNames.set(collections[index].id, collections[index].name);
  }

  const variables = await figma.variables.getLocalVariablesAsync();
  let emitted = 0;

  for (let offset = 0; offset < variables.length; offset += BATCH_SIZE) {
    const end = Math.min(offset + BATCH_SIZE, variables.length);
    const chunk: VariableRow[] = [];

    for (let index = offset; index < end; index += 1) {
      const variable = variables[index];
      const valuesByMode: Record<string, unknown> = {};
      const modeIds = Object.keys(variable.valuesByMode);
      for (let modeIndex = 0; modeIndex < modeIds.length; modeIndex += 1) {
        const modeId = modeIds[modeIndex];
        valuesByMode[modeId] = dehydrateVariableValue(variable.valuesByMode[modeId]);
      }

      chunk.push({
        id: variable.id,
        name: variable.name,
        collection_id: variable.variableCollectionId,
        collection_name: collectionNames.get(variable.variableCollectionId) ?? '',
        resolved_type: variable.resolvedType,
        values_by_mode_json: JSON.stringify(valuesByMode),
        scopes_json: JSON.stringify(variable.scopes ?? []),
      });
    }

    post({ type: 'CHUNK_VARIABLES', payload: chunk });
    emitted += chunk.length;
    await yieldToEventLoop();
  }

  return emitted;
}

async function flushNodes(ctx: ExtractionBuffers, force: boolean): Promise<void> {
  while (ctx.nodes.length >= BATCH_SIZE) {
    const chunk = ctx.nodes;
    ctx.nodes = [];
    post({ type: 'CHUNK_NODES', payload: chunk });
    await yieldToEventLoop();
  }

  if (force && ctx.nodes.length > 0) {
    const chunk = ctx.nodes;
    ctx.nodes = [];
    post({ type: 'CHUNK_NODES', payload: chunk });
    await yieldToEventLoop();
  }
}

async function flushComponents(ctx: ExtractionBuffers, force: boolean): Promise<void> {
  while (ctx.components.length >= BATCH_SIZE) {
    const chunk = ctx.components;
    ctx.components = [];
    post({ type: 'CHUNK_COMPONENTS', payload: chunk });
    await yieldToEventLoop();
  }

  if (force && ctx.components.length > 0) {
    const chunk = ctx.components;
    ctx.components = [];
    post({ type: 'CHUNK_COMPONENTS', payload: chunk });
    await yieldToEventLoop();
  }
}

/**
 * Depth-first walk. Children of vector/icon nodes are pruned; everything else
 * (including instance subtrees) is serialized so layout overrides stay visible.
 */
async function walkChildren(
  children: readonly SceneNode[],
  parentId: string | null,
  pageId: string,
  pageName: string,
  depth: number,
  ctx: ExtractionBuffers,
): Promise<void> {
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const dehydrated = await dehydrateNode(node, parentId, pageId, pageName, index, depth);

    ctx.nodes.push(dehydrated.row);
    ctx.totalNodes += 1;

    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      ctx.components.push(dehydrateComponent(node, pageId, pageName));
      if (ctx.components.length >= BATCH_SIZE) {
        await flushComponents(ctx, false);
      }
    }

    if (ctx.nodes.length >= BATCH_SIZE) {
      await flushNodes(ctx, false);
    }

    if (!dehydrated.shouldSkipChildren && depth < MAX_DEPTH) {
      const nested = getNodeChildren(node);
      if (nested !== null && nested.length > 0) {
        await walkChildren(nested, node.id, pageId, pageName, depth + 1, ctx);
      }
    }
  }
}

async function runExtraction(): Promise<void> {
  if (running || censusRunning) return;
  running = true;

  const startedAt = Date.now();
  const ctx: ExtractionBuffers = { nodes: [], components: [], totalNodes: 0 };

  try {
    post({ type: 'SYNC_START', payload: buildFileMeta() });

    const variableCount = await extractVariables();
    const pages = figma.root.children;

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      // Mandatory for documentAccess: "dynamic-page".
      await page.loadAsync();
      const children = page.children;
      if (children.length === 0) continue;
      await walkChildren(children, null, page.id, page.name, 0, ctx);
    }

    await flushNodes(ctx, true);
    await flushComponents(ctx, true);

    const durationMs = Date.now() - startedAt;
    post({
      type: 'SYNC_COMPLETE',
      payload: { total_nodes: ctx.totalNodes, duration_ms: durationMs },
    });

    figma.notify(
      `Rea-FigmaDesign：${ctx.totalNodes} 個節點、${variableCount} 個變數，耗時 ${(durationMs / 1000).toFixed(1)} 秒`,
      { timeout: 5000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({ type: 'ERROR', payload: { message } });
    figma.notify(`Rea-FigmaDesign 擷取失敗：${message}`, { error: true, timeout: 8000 });
  } finally {
    running = false;
  }
}

async function runPageCensus(): Promise<void> {
  if (running || censusRunning) return;
  censusRunning = true;

  try {
    const pages = figma.root.children;
    const rows: PageCensusRow[] = [];

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      // dynamic-page: load the page before reading children.
      await page.loadAsync();
      const childCount = page.children.length;
      rows.push({
        page_id: page.id,
        page_name: page.name,
        page_index: index,
        child_count: childCount,
        is_empty: childCount === 0 ? 1 : 0,
      });
      if (index > 0 && index % 10 === 0) await yieldToEventLoop();
    }

    post({ type: 'PAGE_CENSUS', payload: rows });
    const contentPages = rows.filter((row) => row.is_empty === 0).length;
    figma.notify(
      `Rea-FigmaDesign 頁面普查：${rows.length} 頁（${contentPages} 有內容 / ${rows.length - contentPages} 空頁）`,
      { timeout: 5000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({ type: 'ERROR', payload: { message } });
    figma.notify(`Rea-FigmaDesign 頁面普查失敗：${message}`, { error: true, timeout: 8000 });
  } finally {
    censusRunning = false;
  }
}

figma.ui.onmessage = (message: unknown): void => {
  if (!isRecord(message)) return;
  if (message.action === 'START_EXTRACTION') {
    void runExtraction();
  } else if (message.action === 'PAGE_CENSUS') {
    void runPageCensus();
  }
};
