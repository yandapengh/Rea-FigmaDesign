/// <reference lib="es2022" />
/** CLI: print UX spatial feature sheet for one screen node. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Graph } from './core/graph';
import { UX_FEATURES, uxFeatures } from './core/ux';

const ROOT = resolve(__dirname, '..');
const id = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
if (!id) { console.error('usage: tsx server/ux.ts <node-id>'); process.exit(1); }
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
if (!g.nodes.has(id)) { console.error('node not found: ' + id); process.exit(1); }
const values = uxFeatures(g, id);
console.log('ux  ' + id + '  ' + (g.nodes.get(id)?.name ?? ''));
UX_FEATURES.forEach((name, i) => console.log((name + '').padEnd(16) + values[i].toFixed(3)));
