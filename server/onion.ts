/// <reference lib="es2022" />
/** CLI: Tier 1.5 onion normalization summary (read-only). */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Graph } from './core/graph';
import { onionHashes, onionScreenGroups } from './core/onion';

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
const hashes = onionHashes(g, dbPath);
const groups = onionScreenGroups(g, hashes);
const t1 = new Set<string>();
let merges = 0;
for (const group of groups) {
  for (const key of group.tier1Keys) t1.add(key);
  if (group.tier1Keys.length > 1) merges += 1;
}
console.log('tier15  db=' + dbPath);
console.log('nodes=' + g.nodes.size.toLocaleString('en-US') + '  screens=' + groups.reduce((a, x) => a + x.ids.length, 0));
console.log('tier1 groups=' + t1.size + '  tier1.5 groups=' + groups.length + '  merged groups=' + merges);
