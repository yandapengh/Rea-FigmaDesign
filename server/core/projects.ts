/// <reference lib="es2022" />
/**
 * Multi-project isolation & configuration registry.
 *
 * Keeps AST SQLite graphs under data/<projectId>/graph.sqlite and per-project
 * configuration + semantic labels isolated under labels/projects/<projectId>/
 * while keeping legacy primary project labels/screens-v2.json 100% compatible.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import Database = require('better-sqlite3');
import { DEFAULT_SCREEN_SPEC, type ScreenSpec } from './graph';
import { tryLoadScreenLabelsV2 } from './semantics';

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
