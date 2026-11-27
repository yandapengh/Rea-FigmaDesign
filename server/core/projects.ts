/// <reference lib="es2022" />
/**
 * Multi-project isolation & configuration registry.
 *
 * Keeps AST SQLite graphs under data/<projectId>/graph.sqlite and per-project
 * configuration + semantic labels isolated under labels/projects/<projectId>/
 * while keeping legacy primary project labels/screens-v2.json 100% compatible.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import Database = require('better-sqlite3');
import { DEFAULT_SCREEN_SPEC, findScreenRoots, Graph, type ScreenSpec } from './graph';
import { recomputeV2Counts, tryLoadScreenLabelsV2, type ArchivedScreenLabelV2 } from './semantics';

export { DEFAULT_SCREEN_SPEC, type ScreenSpec };

export interface LabelProposalItem {
  id: string;
  currentMajor: string;
  currentMinor: string;
  currentGeneration: string;
  suggestedMajor: string;
  suggestedMinor: string;
  suggestedGeneration: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  source: 'ast-exact' | 'ast-family' | 'heuristic' | 'uncertain';
}

export interface ProposalsDoc {
  version: 1;
  projectId: string;
  generatedAt: string;
  scope: string;
  items: LabelProposalItem[];
}

export function proposalsPathForProject(root: string, projectId: string): string {
  return resolve(root, 'labels/projects', projectId, 'proposals.json');
}

export function loadProposals(root: string, projectId: string): ProposalsDoc | null {
  const path = proposalsPathForProject(root, projectId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProposalsDoc>;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return {
      version: 1,
      projectId: parsed.projectId || projectId,
      generatedAt: parsed.generatedAt || '',
      scope: parsed.scope || '',
      items: parsed.items,
    };
  } catch {
    return null;
  }
}

export function saveProposals(root: string, projectId: string, doc: ProposalsDoc): string {
  const path = proposalsPathForProject(root, projectId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return path;
}

export const LEGACY_PRIMARY_PROJECT = 'file-1d40063501';

export interface ProjectConfig {
  id: string;
  name: string;
  fileKey: string;
  fileName: string;
  screenSpec: ScreenSpec;
  majorOrder?: string[];
}

export interface ProjectInfo {
  id: string;
  name: string;
  fileKey: string;
  fileName: string;
  dbPath: string;
  labelsPath: string;
  labelsRelPath: string;
  configPath: string;
  reviewHtmlName: string;
  config: ProjectConfig;
  pagesTotal: number;
  pagesDone: number;
  nodesCount: number;
  labeledCount: number;
  majorCounts: Record<string, number>;
  updatedAt: string;
  updatedMs: number;
}

export function projectConfigPath(root: string, projectId: string): string {
  return resolve(root, 'labels/projects', projectId, 'project.json');
}

export function labelsPathForProject(root: string, projectId: string): string {
  const isolated = resolve(root, 'labels/projects', projectId, 'screens-v2.json');
  if (existsSync(isolated)) return isolated;
  if (projectId === LEGACY_PRIMARY_PROJECT) {
    const legacy = resolve(root, 'labels/screens-v2.json');
    if (existsSync(legacy)) return legacy;
  }
  return isolated;
}

export function projectReviewHtmlName(projectId: string): string {
  return 'review-' + projectId.replace(/[^A-Za-z0-9_-]/g, '_') + '.html';
}

export function normalizeScreenSpec(raw?: Partial<ScreenSpec>): ScreenSpec {
  return {
    widths: Array.isArray(raw?.widths) && raw.widths.length > 0
      ? raw.widths.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
      : DEFAULT_SCREEN_SPEC.widths.slice(),
    widthTolerance: typeof raw?.widthTolerance === 'number' && raw.widthTolerance >= 0
      ? raw.widthTolerance
      : DEFAULT_SCREEN_SPEC.widthTolerance,
    minHeight: typeof raw?.minHeight === 'number' && raw.minHeight > 0
      ? raw.minHeight
      : DEFAULT_SCREEN_SPEC.minHeight,
    maxHeight: typeof raw?.maxHeight === 'number' && raw.maxHeight >= 100
      ? raw.maxHeight
      : DEFAULT_SCREEN_SPEC.maxHeight,
    minNodes: typeof raw?.minNodes === 'number' && raw.minNodes >= 1
      ? Math.floor(raw.minNodes)
      : DEFAULT_SCREEN_SPEC.minNodes,
  };
}

export function loadProjectConfig(
  root: string,
  projectId: string,
  fallbackMeta?: { name?: string; fileKey?: string; fileName?: string },
): ProjectConfig {
  const cfgPath = projectConfigPath(root, projectId);
  let parsed: Partial<ProjectConfig> = {};
  if (existsSync(cfgPath)) {
    try {
      parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<ProjectConfig>;
    } catch {
      parsed = {};
    }
  }
  const fileName = parsed.fileName || fallbackMeta?.fileName || projectId;
  const name = parsed.name || fallbackMeta?.name || fileName;
  const fileKey = parsed.fileKey || fallbackMeta?.fileKey || '';
  const majorOrder = Array.isArray(parsed.majorOrder) && parsed.majorOrder.length > 0
    ? parsed.majorOrder.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : undefined;
  return {
    id: projectId,
    name,
    fileKey,
    fileName,
    screenSpec: normalizeScreenSpec(parsed.screenSpec),
    majorOrder,
  };
}

export function saveProjectConfig(root: string, config: ProjectConfig): string {
  const cfgPath = projectConfigPath(root, config.id);
  mkdirSync(dirname(cfgPath), { recursive: true });
  const normalized: ProjectConfig = {
    id: config.id,
    name: config.name,
    fileKey: config.fileKey,
    fileName: config.fileName,
    screenSpec: normalizeScreenSpec(config.screenSpec),
    majorOrder: config.majorOrder,
  };
  writeFileSync(cfgPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return cfgPath;
}

export function listProjects(root: string): ProjectInfo[] {
  const dataRoot = resolve(root, 'data');
  if (!existsSync(dataRoot)) return [];
  const projects: ProjectInfo[] = [];

  for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'samples') continue;
    const projectId = entry.name;
    const dir = join(dataRoot, projectId);
    const dbPath = join(dir, 'graph.sqlite');
    if (!existsSync(dbPath)) continue;

    let manifest: { file_key?: string; file_name?: string; updated_at?: string } = {};
    const manifestPath = join(dir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
      } catch {
        manifest = {};
      }
    }

    let fileKey = manifest.file_key ?? '';
    let fileName = manifest.file_name ?? projectId;
    let updatedAt = manifest.updated_at ?? '';
    let pagesTotal = 0;
    let pagesDone = 0;
    let nodesCount = 0;

    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const meta = db
          .prepare('SELECT file_key, file_name, extracted_at, page_count FROM file_meta ORDER BY extracted_at DESC LIMIT 1')
          .get() as { file_key: string; file_name: string; extracted_at: string; page_count: number } | undefined;
        if (meta) {
          fileKey = meta.file_key || fileKey;
          fileName = meta.file_name || fileName;
          updatedAt = updatedAt || meta.extracted_at || '';
          pagesTotal = meta.page_count || 0;
        }
        const nRow = db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: number } | undefined;
        nodesCount = nRow?.cnt ?? 0;
        const pRow = db
          .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done FROM pages")
          .get() as { total: number; done: number | null } | undefined;
        if (pRow && pRow.total > 0) pagesTotal = Math.max(pagesTotal, pRow.total);
        pagesDone = pRow?.done ?? 0;
      } finally {
        db.close();
      }
    } catch {
      /* ignore corrupt/partial metadata */
    }

    const updatedMs = updatedAt ? Date.parse(updatedAt) || statSync(dbPath).mtimeMs : statSync(dbPath).mtimeMs;
    if (!updatedAt) updatedAt = new Date(updatedMs).toISOString();

    const config = loadProjectConfig(root, projectId, { name: fileName, fileKey, fileName });
    const labelsPath = labelsPathForProject(root, projectId);
    const v2Doc = tryLoadScreenLabelsV2(labelsPath);
    const labeledCount = v2Doc?.screens.length ?? 0;
    const majorCounts = v2Doc?.counts ?? {};

    projects.push({
      id: projectId,
      name: config.name,
      fileKey: config.fileKey,
      fileName: config.fileName,
      dbPath,
      labelsPath,
      labelsRelPath: relative(root, labelsPath).replace(/\\/g, '/'),
      configPath: projectConfigPath(root, projectId),
      reviewHtmlName: projectReviewHtmlName(projectId),
      config,
      pagesTotal,
      pagesDone,
      nodesCount,
      labeledCount,
      majorCounts,
      updatedAt,
      updatedMs,
    });
  }

  projects.sort((a, b) => b.updatedMs - a.updatedMs || a.id.localeCompare(b.id));
  return projects;
}

export function resolveProject(
  root: string,
  opts?: { project?: string; dbPath?: string },
): ProjectInfo {
  const all = listProjects(root);
  const want = opts?.project?.trim();
  if (want) {
    const byId = all.find((p) => p.id === want);
    if (byId) return byId;
    const lower = want.toLowerCase();
    const byName = all.find((p) => p.name.toLowerCase() === lower || p.fileName.toLowerCase() === lower);
    if (byName) return byName;
    const avail = all.map((p) => p.id + ' (' + p.name + ')').join(', ') || '(無)';
    throw new Error('找不到專案「' + want + '」。目前可用專案：' + avail);
  }

  if (opts?.dbPath) {
    const abs = resolve(root, opts.dbPath);
    const exact = all.find((p) => resolve(p.dbPath) === abs);
    if (exact) return exact;

    const dataPrefix = resolve(root, 'data') + sep;
    let derivedId = basename(abs).replace(/\.sqlite$/i, '') || 'custom';
    if (abs.startsWith(dataPrefix)) {
      const parts = abs.slice(dataPrefix.length).split(sep).filter(Boolean);
      if (parts[0] && parts[0] !== 'samples') derivedId = parts[0];
    }
    const config = loadProjectConfig(root, derivedId, { name: derivedId, fileName: derivedId });
    const labelsPath = labelsPathForProject(root, derivedId);
    const v2Doc = tryLoadScreenLabelsV2(labelsPath);
    return {
      id: derivedId,
      name: config.name,
      fileKey: config.fileKey,
      fileName: config.fileName,
      dbPath: abs,
      labelsPath,
      labelsRelPath: relative(root, labelsPath).replace(/\\/g, '/'),
      configPath: projectConfigPath(root, derivedId),
      reviewHtmlName: projectReviewHtmlName(derivedId),
      config,
      pagesTotal: 0,
      pagesDone: 0,
      nodesCount: 0,
      labeledCount: v2Doc?.screens.length ?? 0,
      majorCounts: v2Doc?.counts ?? {},
      updatedAt: new Date().toISOString(),
      updatedMs: Date.now(),
    };
  }

  if (all.length > 0) return all[0];

  const fallbackId = LEGACY_PRIMARY_PROJECT;
  const config = loadProjectConfig(root, fallbackId);
  const labelsPath = labelsPathForProject(root, fallbackId);
  return {
    id: fallbackId,
    name: config.name,
    fileKey: config.fileKey,
    fileName: config.fileName,
    dbPath: resolve(root, 'data/rea-figma.sqlite'),
    labelsPath,
    labelsRelPath: relative(root, labelsPath).replace(/\\/g, '/'),
    configPath: projectConfigPath(root, fallbackId),
    reviewHtmlName: projectReviewHtmlName(fallbackId),
    config,
    pagesTotal: 0,
    pagesDone: 0,
    nodesCount: 0,
    labeledCount: 0,
    majorCounts: {},
    updatedAt: '',
    updatedMs: 0,
  };
}

export function matchBridgeProject(
  target: { fileKey?: string; fileName?: string; name?: string },
  bridge: { figma_file_key?: string; figma_file_name?: string },
): boolean {
  const bKey = (bridge.figma_file_key || '').trim();
  const bName = (bridge.figma_file_name || '').trim();
  const tKey = (target.fileKey || '').trim();
  const tNames = [target.fileName, target.name].map((s) => (s || '').trim()).filter(Boolean);
  if (bKey && bKey !== '0:0' && tKey && tKey !== '0:0' && bKey === tKey) return true;
  if (bName && tNames.indexOf(bName) !== -1) return true;
  return false;
}

export interface ReconcileLabelsResult {
  archived: number;
  archivedIds: string[];
  remaining: number;
  proposalsPruned: number;
}

/**
 * After incremental/full SQLite sync, archive label entries whose node_id no longer exists
 * in the database into `archivedDeleted` (preserving history) and prune stale proposals.
 */
export function reconcileProjectLabelsWithDb(
  root: string,
  projectId: string,
  dbPath: string,
  fileKey?: string,
): ReconcileLabelsResult {
  if (!existsSync(dbPath)) {
    return { archived: 0, archivedIds: [], remaining: 0, proposalsPruned: 0 };
  }
  const labelsPath = labelsPathForProject(root, projectId);
  const v2Doc = tryLoadScreenLabelsV2(labelsPath);
  const proposalsDoc = loadProposals(root, projectId);

  const checkIds = new Set<string>();
  if (v2Doc) for (const s of v2Doc.screens) checkIds.add(s.id);
  if (proposalsDoc) for (const it of proposalsDoc.items) checkIds.add(it.id);

  if (checkIds.size === 0) {
    return { archived: 0, archivedIds: [], remaining: 0, proposalsPruned: 0 };
  }

  const allIds = [...checkIds];
  const liveIds = new Set<string>();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    for (let i = 0; i < allIds.length; i += 500) {
      const part = allIds.slice(i, i + 500);
      const placeholders = part.map(() => '?').join(',');
      const rows = (fileKey
        ? db.prepare('SELECT id FROM nodes WHERE file_key = ? AND id IN (' + placeholders + ')').all(fileKey, ...part)
        : db.prepare('SELECT id FROM nodes WHERE id IN (' + placeholders + ')').all(...part)) as Array<{ id: string }>;
      for (const r of rows) liveIds.add(r.id);
    }
  } finally {
    db.close();
  }

  let archived = 0;
  const archivedIds: string[] = [];
  let remaining = v2Doc?.screens.length ?? 0;

  if (v2Doc) {
    const kept: typeof v2Doc.screens = [];
    const deleted: ArchivedScreenLabelV2[] = [];
    const now = new Date().toISOString();
    for (const s of v2Doc.screens) {
      if (liveIds.has(s.id)) {
        kept.push(s);
      } else {
        archived += 1;
        archivedIds.push(s.id);
        deleted.push({ ...s, deletedAt: now });
      }
    }
    remaining = kept.length;
    if (archived > 0) {
      const archivedById = new Map<string, ArchivedScreenLabelV2>();
      for (const prev of v2Doc.archivedDeleted ?? []) archivedById.set(prev.id, prev);
      for (const d of deleted) archivedById.set(d.id, d);
      const nextDoc = {
        ...v2Doc,
        counts: recomputeV2Counts(kept),
        screens: kept,
        archivedDeleted: [...archivedById.values()],
      };
      mkdirSync(dirname(labelsPath), { recursive: true });
      writeFileSync(labelsPath, JSON.stringify(nextDoc, null, 2) + '\n', 'utf8');
    }
  }

  let proposalsPruned = 0;
  if (proposalsDoc && proposalsDoc.items.length > 0) {
    const keptProps = proposalsDoc.items.filter((it) => liveIds.has(it.id));
    proposalsPruned = proposalsDoc.items.length - keptProps.length;
    if (proposalsPruned > 0) {
      saveProposals(root, projectId, { ...proposalsDoc, items: keptProps });
    }
  }

  return { archived, archivedIds, remaining, proposalsPruned };
}

export interface SyncScreenRef {
  id: string;
  name: string;
  pageId: string;
  pageName: string;
  major?: string;
  minor?: string;
}

export interface LastSyncReport {
  version: 1;
  syncedAt: string;
  isInitialImport: boolean;
  touchedPages: string[];
  prunedPages: string[];
  addedScreens: SyncScreenRef[];
  removedScreens: SyncScreenRef[];
  labelsArchived: number;
  proposalsPruned: number;
}

export function lastSyncPathForDb(dbPath: string): string {
  return join(dirname(dbPath), 'last-sync.json');
}

export function loadLastSync(dbPath: string): LastSyncReport | null {
  const path = lastSyncPathForDb(dbPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LastSyncReport>;
    if (!parsed || !Array.isArray(parsed.addedScreens) || !Array.isArray(parsed.removedScreens)) return null;
    return {
      version: 1,
      syncedAt: parsed.syncedAt || '',
      isInitialImport: parsed.isInitialImport === true,
      touchedPages: Array.isArray(parsed.touchedPages) ? parsed.touchedPages : [],
      prunedPages: Array.isArray(parsed.prunedPages) ? parsed.prunedPages : [],
      addedScreens: parsed.addedScreens,
      removedScreens: parsed.removedScreens,
      labelsArchived: typeof parsed.labelsArchived === 'number' ? parsed.labelsArchived : 0,
      proposalsPruned: typeof parsed.proposalsPruned === 'number' ? parsed.proposalsPruned : 0,
    };
  } catch {
    return null;
  }
}

export function saveLastSync(dbPath: string, report: LastSyncReport): string {
  const path = lastSyncPathForDb(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return path;
}

export function snapshotProjectScreens(
  root: string,
  projectId: string,
  dbPath: string,
  fileKey?: string,
): Map<string, SyncScreenRef> {
  const out = new Map<string, SyncScreenRef>();
  if (!existsSync(dbPath)) return out;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let nodeCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number } | undefined;
    nodeCount = row?.c ?? 0;
  } catch {
    nodeCount = 0;
  } finally {
    db.close();
  }
  if (nodeCount === 0) return out;

  const config = loadProjectConfig(root, projectId);
  const v2Doc = tryLoadScreenLabelsV2(labelsPathForProject(root, projectId));
  const labelById = new Map<string, { major: string; minor: string }>();
  if (v2Doc) {
    for (const s of v2Doc.screens) labelById.set(s.id, { major: s.major, minor: s.minor });
    for (const a of v2Doc.archivedDeleted ?? []) {
      if (!labelById.has(a.id)) labelById.set(a.id, { major: a.major, minor: a.minor });
    }
  }

  const g = new Graph(dbPath);
  const roots = findScreenRoots(g, config.screenSpec);
  for (const id of roots) {
    const n = g.nodes.get(id);
    if (!n) continue;
    const lbl = labelById.get(id);
    out.set(id, {
      id,
      name: n.name || '(無名)',
      pageId: n.page_id || '',
      pageName: n.page_name || '',
      major: lbl?.major || undefined,
      minor: lbl?.minor || undefined,
    });
  }
  void fileKey;
  return out;
}

export function computeScreenSyncDiff(
  before: Map<string, SyncScreenRef>,
  after: Map<string, SyncScreenRef>,
): { addedScreens: SyncScreenRef[]; removedScreens: SyncScreenRef[]; isInitialImport: boolean } {
  const isInitialImport = before.size === 0;
  const addedScreens: SyncScreenRef[] = [];
  const removedScreens: SyncScreenRef[] = [];
  for (const [id, ref] of after) {
    if (!before.has(id)) addedScreens.push(ref);
  }
  for (const [id, ref] of before) {
    if (!after.has(id)) removedScreens.push(ref);
  }
  return { addedScreens, removedScreens, isInitialImport };
}

export const PC_WEB_SCREEN_SPEC: ScreenSpec = {
  widths: [1280, 1366, 1440, 1512, 1680, 1728, 1920],
  widthTolerance: 16,
  minHeight: 700,
  maxHeight: 16000,
  minNodes: 40,
};

export interface WorkspaceConfig {
  id: string;
  name: string;
  sources: string[];
  screenSpec: ScreenSpec;
  majorOrder?: string[];
  updatedAt?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  sources: string[];
  sourceProjects: ProjectInfo[];
  missingSources: string[];
  configPath: string;
  labelsPath: string;
  labelsRelPath: string;
  reviewHtmlName: string;
  config: WorkspaceConfig;
  pagesTotal: number;
  pagesDone: number;
  nodesCount: number;
  labeledCount: number;
  majorCounts: Record<string, number>;
  updatedAt: string;
  updatedMs: number;
}

export function makeCompositeScreenId(sourceId: string, nodeId: string): string {
  return sourceId + '::' + nodeId;
}

export function parseCompositeScreenId(id: string): { sourceId: string; nodeId: string } | null {
  const idx = id.indexOf('::');
  if (idx <= 0) return null;
  const sourceId = id.slice(0, idx).trim();
  const nodeId = id.slice(idx + 2).trim();
  if (!sourceId || !nodeId) return null;
  return { sourceId, nodeId };
}

export function sanitizeWorkspaceId(raw: string): string {
  const trimmed = (raw || '').trim();
  const bare = trimmed.replace(/^ws-/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (bare && bare.length >= 2) {
    return ('ws-' + bare).slice(0, 60);
  }
  const digest = createHash('sha1').update((trimmed || 'app') + '|' + Date.now()).digest('hex').slice(0, 8);
  return 'ws-' + digest;
}

export function workspaceDir(root: string, wsId: string): string {
  return resolve(root, 'labels/workspaces', wsId);
}

export function workspaceConfigPath(root: string, wsId: string): string {
  return resolve(root, 'labels/workspaces', wsId, 'workspace.json');
}

export function workspaceLabelsPath(root: string, wsId: string): string {
  return resolve(root, 'labels/workspaces', wsId, 'screens-v2.json');
}

export function loadWorkspaceConfig(root: string, wsId: string): WorkspaceConfig | null {
  const cfgPath = workspaceConfigPath(root, wsId);
  if (!existsSync(cfgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<WorkspaceConfig>;
    if (!parsed || typeof parsed.name !== 'string') return null;
    const sources = Array.isArray(parsed.sources)
      ? [...new Set(parsed.sources.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()))]
      : [];
    const majorOrder = Array.isArray(parsed.majorOrder) && parsed.majorOrder.length > 0
      ? parsed.majorOrder.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : undefined;
    return {
      id: parsed.id || wsId,
      name: parsed.name.trim() || wsId,
      sources,
      screenSpec: normalizeScreenSpec(parsed.screenSpec),
      majorOrder,
      updatedAt: parsed.updatedAt || '',
    };
  } catch {
    return null;
  }
}

export function saveWorkspaceConfig(root: string, config: WorkspaceConfig): WorkspaceConfig {
  const id = config.id.startsWith('ws-') ? config.id : sanitizeWorkspaceId(config.id || config.name);
  const cfgPath = workspaceConfigPath(root, id);
  mkdirSync(dirname(cfgPath), { recursive: true });
  const normalized: WorkspaceConfig = {
    id,
    name: config.name.trim() || id,
    sources: [...new Set((config.sources || []).map((s) => s.trim()).filter(Boolean))],
    screenSpec: normalizeScreenSpec(config.screenSpec),
    majorOrder: config.majorOrder && config.majorOrder.length > 0 ? config.majorOrder : undefined,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(cfgPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

export function deleteWorkspace(root: string, wsId: string): boolean {
  if (!wsId || !wsId.startsWith('ws-')) return false;
  const dir = workspaceDir(root, wsId);
  const boardPath = resolve(root, '.scratch', projectReviewHtmlName(wsId));
  let existed = false;
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    existed = true;
  }
  if (existsSync(boardPath)) {
    rmSync(boardPath, { force: true });
    existed = true;
  }
  return existed;
}

export function listWorkspaces(root: string): WorkspaceInfo[] {
  const wsRoot = resolve(root, 'labels/workspaces');
  if (!existsSync(wsRoot)) return [];
  const allProjects = listProjects(root);
  const byProjId = new Map(allProjects.map((p) => [p.id, p]));
  const out: WorkspaceInfo[] = [];

  for (const entry of readdirSync(wsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfg = loadWorkspaceConfig(root, entry.name);
    if (!cfg) continue;

    const sourceProjects: ProjectInfo[] = [];
    const missingSources: string[] = [];
    let pagesTotal = 0;
    let pagesDone = 0;
    let nodesCount = 0;
    let maxUpdatedMs = cfg.updatedAt ? Date.parse(cfg.updatedAt) || 0 : 0;

    for (const sid of cfg.sources) {
      const sp = byProjId.get(sid);
      if (sp) {
        sourceProjects.push(sp);
        pagesTotal += sp.pagesTotal;
        pagesDone += sp.pagesDone;
        nodesCount += sp.nodesCount;
        if (sp.updatedMs > maxUpdatedMs) maxUpdatedMs = sp.updatedMs;
      } else {
        missingSources.push(sid);
      }
    }

    const labelsPath = workspaceLabelsPath(root, cfg.id);
    const v2Doc = tryLoadScreenLabelsV2(labelsPath);
    const labeledCount = v2Doc?.screens.length ?? 0;
    const majorCounts = v2Doc?.counts ?? {};
    const updatedMs = maxUpdatedMs || statSync(workspaceConfigPath(root, entry.name)).mtimeMs;
    const updatedAt = new Date(updatedMs).toISOString();

    out.push({
      id: cfg.id,
      name: cfg.name,
      sources: cfg.sources,
      sourceProjects,
      missingSources,
      configPath: workspaceConfigPath(root, cfg.id),
      labelsPath,
      labelsRelPath: relative(root, labelsPath).replace(/\\/g, '/'),
      reviewHtmlName: projectReviewHtmlName(cfg.id),
      config: cfg,
      pagesTotal,
      pagesDone,
      nodesCount,
      labeledCount,
      majorCounts,
      updatedAt,
      updatedMs,
    });
  }

  out.sort((a, b) => b.updatedMs - a.updatedMs || a.id.localeCompare(b.id));
  return out;
}

export function resolveWorkspace(root: string, want: string): WorkspaceInfo | null {
  const trimmed = (want || '').trim();
  if (!trimmed) return null;
  const all = listWorkspaces(root);
  const byId = all.find((w) => w.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return all.find((w) => w.name.toLowerCase() === lower) ?? null;
}

/** Reconcile workspace labels & proposals (composite `sourceId::nodeId`) against each source's SQLite DB. */
export function reconcileWorkspaceLabelsWithDbs(root: string, ws: WorkspaceInfo): ReconcileLabelsResult {
  const v2Doc = tryLoadScreenLabelsV2(ws.labelsPath);
  const proposalsDoc = loadProposals(root, ws.id);
  const bySourceId = new Map(ws.sourceProjects.map((sp) => [sp.id, sp]));

  const idsBySource = new Map<string, Set<string>>();
  const addCheck = (compId: string): void => {
    const parsed = parseCompositeScreenId(compId);
    if (!parsed) return;
    let bucket = idsBySource.get(parsed.sourceId);
    if (!bucket) {
      bucket = new Set<string>();
      idsBySource.set(parsed.sourceId, bucket);
    }
    bucket.add(parsed.nodeId);
  };
  if (v2Doc) for (const s of v2Doc.screens) addCheck(s.id);
  if (proposalsDoc) for (const it of proposalsDoc.items) addCheck(it.id);

  if (idsBySource.size === 0) {
    return { archived: 0, archivedIds: [], remaining: v2Doc?.screens.length ?? 0, proposalsPruned: 0 };
  }

  const liveCompositeIds = new Set<string>();
  for (const [srcId, rawSet] of idsBySource) {
    const sp = bySourceId.get(srcId);
    if (!sp || !existsSync(sp.dbPath)) continue;
    const rawList = [...rawSet];
    const db = new Database(sp.dbPath, { readonly: true, fileMustExist: true });
    try {
      for (let i = 0; i < rawList.length; i += 500) {
        const part = rawList.slice(i, i + 500);
        const rows = db
          .prepare('SELECT id FROM nodes WHERE id IN (' + part.map(() => '?').join(',') + ')')
          .all(...part) as Array<{ id: string }>;
        for (const r of rows) liveCompositeIds.add(makeCompositeScreenId(srcId, r.id));
      }
    } finally {
      db.close();
    }
  }

  let archived = 0;
  const archivedIds: string[] = [];
  let remaining = v2Doc?.screens.length ?? 0;

  if (v2Doc) {
    const kept: typeof v2Doc.screens = [];
    const deleted: ArchivedScreenLabelV2[] = [];
    const now = new Date().toISOString();
    for (const s of v2Doc.screens) {
      const parsed = parseCompositeScreenId(s.id);
      if (!parsed || !bySourceId.has(parsed.sourceId) || liveCompositeIds.has(s.id)) {
        kept.push(s);
      } else {
        archived += 1;
        archivedIds.push(s.id);
        deleted.push({ ...s, deletedAt: now });
      }
    }
    remaining = kept.length;
    if (archived > 0) {
      const archivedById = new Map<string, ArchivedScreenLabelV2>();
      for (const prev of v2Doc.archivedDeleted ?? []) archivedById.set(prev.id, prev);
      for (const d of deleted) archivedById.set(d.id, d);
      const nextDoc = {
        ...v2Doc,
        counts: recomputeV2Counts(kept),
        screens: kept,
        archivedDeleted: [...archivedById.values()],
      };
      mkdirSync(dirname(ws.labelsPath), { recursive: true });
      writeFileSync(ws.labelsPath, JSON.stringify(nextDoc, null, 2) + '\n', 'utf8');
    }
  }

  let proposalsPruned = 0;
  if (proposalsDoc && proposalsDoc.items.length > 0) {
    const keptProps = proposalsDoc.items.filter((it) => {
      const parsed = parseCompositeScreenId(it.id);
      return !parsed || !bySourceId.has(parsed.sourceId) || liveCompositeIds.has(it.id);
    });
    proposalsPruned = proposalsDoc.items.length - keptProps.length;
    if (proposalsPruned > 0) {
      saveProposals(root, ws.id, { ...proposalsDoc, items: keptProps });
    }
  }

  return { archived, archivedIds, remaining, proposalsPruned };
}
