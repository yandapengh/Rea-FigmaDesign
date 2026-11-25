/// <reference lib="es2022" />
/**
 * Pure health-check logic for a Rea-FigmaDesign SQLite graph.
 */

import Database = require('better-sqlite3');

export interface HealthCheckItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}

export interface HealthFileMeta {
  file_key: string;
  file_name: string;
  page_count: number;
  total_nodes: number;
}

export interface HealthReport {
  db: string;
  file: HealthFileMeta | null;
  nodes: number;
  pages: number;
  done: number;
  skipped: number;
  staging: number;
  checks: HealthCheckItem[];
  failed: number;
  duplicateNames: Array<{ page_name: string; c: number }>;
}

export function runHealthChecks(dbPath: string, fix = false): HealthReport {
  const db = new Database(dbPath, { readonly: !fix, fileMustExist: true });
  try {
    const meta = db
      .prepare('SELECT file_key, file_name, page_count, total_nodes FROM file_meta ORDER BY extracted_at DESC LIMIT 1')
      .get() as HealthFileMeta | undefined;
    const fileKey = meta?.file_key ?? '';
    const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
    const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

    const nodes = one<{ c: number }>('SELECT COUNT(*) AS c FROM nodes WHERE file_key = ?', fileKey).c;
    const pages = all<{ page_id: string; page_name: string; status: string; node_count: number; actual: number }>(
      'SELECT p.page_id, p.page_name, p.status, p.node_count, (SELECT COUNT(*) FROM nodes n WHERE n.file_key = p.file_key AND n.page_id = p.page_id) AS actual FROM pages p WHERE p.file_key = ? ORDER BY p.page_index',
      fileKey,
    );
    const staging = one<{ c: number }>('SELECT COUNT(*) AS c FROM nodes_staging WHERE file_key = ?', fileKey).c;
    const syncing = pages.filter((p) => p.status === 'SYNCING').length;
    const donePages = pages.filter((p) => p.status === 'DONE');
    const skipPages = pages.filter((p) => p.status === 'SKIPPED');
    const doneMismatch = donePages.filter((p) => p.node_count !== p.actual);
    const doneEmpty = donePages.filter((p) => p.actual === 0);
    const orphanPage = one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM nodes n LEFT JOIN pages p ON p.file_key = n.file_key AND p.page_id = n.page_id WHERE n.file_key = ? AND p.page_id IS NULL',
      fileKey,
    ).c;
    const orphanParent = one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM nodes n LEFT JOIN nodes p ON p.file_key = n.file_key AND p.id = n.parent_id WHERE n.file_key = ? AND n.parent_id IS NOT NULL AND p.id IS NULL',
      fileKey,
    ).c;
    const compMismatch = one<{ c: number }>('SELECT COUNT(*) AS c FROM components WHERE file_key <> ?', fileKey).c;
    const varMismatch = one<{ c: number }>('SELECT COUNT(*) AS c FROM variables WHERE file_key <> ?', fileKey).c;
    const dupNames = all<{ page_name: string; c: number }>(
      'SELECT page_name, COUNT(*) AS c FROM pages WHERE file_key = ? GROUP BY page_name HAVING c > 1',
      fileKey,
    );
    const sumCounts = donePages.reduce((acc, p) => acc + p.actual, 0) + skipPages.reduce((acc, p) => acc + p.actual, 0);
    const pageCountMismatch = meta ? pages.length - meta.page_count : 0;
    const totalMismatch = meta ? meta.total_nodes - nodes : 0;

    const checks: HealthCheckItem[] = [
      { id: 'file_meta', label: 'file_meta 存在且只有一個檔案', ok: Boolean(meta), detail: meta ? meta.file_name + ' (' + meta.file_key + ')' : 'missing', critical: true },
      { id: 'staging', label: '暫存表為 0 筆', ok: staging === 0, detail: staging + ' rows', critical: true },
      { id: 'syncing', label: '沒有卡在 SYNCING 的頁', ok: syncing === 0, detail: syncing + ' pages', critical: true },
      { id: 'orphan_page', label: '每個節點都屬於存在的頁', ok: orphanPage === 0, detail: orphanPage + ' nodes', critical: true },
      { id: 'orphan_parent', label: '沒有孤兒父節點', ok: orphanParent === 0, detail: orphanParent + ' nodes', critical: true },
      { id: 'done_empty', label: 'DONE 頁都有節點', ok: doneEmpty.length === 0, detail: doneEmpty.map((p) => p.page_name).join(', ') || '0 pages', critical: true },
      { id: 'page_node_count', label: 'pages.node_count 與實際節點一致', ok: doneMismatch.length === 0, detail: doneMismatch.length === 0 ? pages.length + ' pages' : doneMismatch.map((p) => p.page_name + ' ' + p.node_count + '≠' + p.actual).slice(0, 3).join('; ') + ' (' + doneMismatch.length + ')', critical: true },
      { id: 'total_nodes', label: 'file_meta.total_nodes 與 nodes 一致', ok: totalMismatch === 0, detail: 'meta ' + (meta ? meta.total_nodes : 0) + ' vs actual ' + nodes, critical: true },
      { id: 'page_count', label: 'pages 筆數與 file_meta.page_count 一致', ok: pageCountMismatch === 0, detail: pages.length + ' vs ' + (meta ? meta.page_count : 0), critical: false },
      { id: 'file_scope', label: 'components/variables 屬於同一檔案', ok: compMismatch === 0 && varMismatch === 0, detail: compMismatch + ' / ' + varMismatch, critical: true },
      { id: 'sum', label: 'DONE+SKIPPED 節點總和 = nodes', ok: sumCounts === nodes, detail: sumCounts + ' vs ' + nodes, critical: true },
    ];

    if (fix && meta) {
      const now = new Date().toISOString();
      db.pragma('journal_mode = WAL');
      const txn = db.transaction(() => {
        for (const p of pages) db.prepare('UPDATE pages SET node_count = ? WHERE file_key = ? AND page_id = ?').run(p.actual, fileKey, p.page_id);
        db.prepare('UPDATE file_meta SET total_nodes = ?, updated_at = ? WHERE file_key = ?').run(nodes, now, fileKey);
      });
      txn();
    }

    const failed = checks.filter((c) => !c.ok && c.critical).length;
    return {
      db: dbPath,
      file: meta ?? null,
      nodes,
      pages: pages.length,
      done: donePages.length,
      skipped: skipPages.length,
      staging,
      checks,
      failed,
      duplicateNames: dupNames,
    };
  } finally {
    db.close();
  }
}
