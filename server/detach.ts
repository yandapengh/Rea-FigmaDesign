/// <reference lib="es2022" />
/** CLI: component-library detach recall (stage 6). */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Graph } from './core/graph';
import { syntheticDetachRecall } from './core/detach';
const ROOT = resolve(__dirname, '..');
let dbPath = '';
{
  let best = ''; let bestTime = 0;
  for (const d of readdirSync(join(ROOT, 'data'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(ROOT, 'data', d.name, 'graph.sqlite');
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (t > bestTime) { bestTime = t; best = p; }
  }
  dbPath = best;
}
const g = new Graph(dbPath);
const r = syntheticDetachRecall(g, 300);
const pct = (n: number): number => Math.round((100 * n) / Math.max(1, r.sample));
console.log('detach  db=' + dbPath);
console.log('sample=' + r.sample + '  top1=' + pct(r.top1) + '%  top3=' + pct(r.top3) + '%  top5=' + pct(r.top5) + '%');
